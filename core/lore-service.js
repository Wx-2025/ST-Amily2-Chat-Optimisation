/**
 * LoreService — 世界书操作统一服务层
 *
 * 职责：
 *  1. 写锁（Promise chain 串行化，防止多模块并发覆盖同一世界书）
 *  2. ST world-info.js API 的统一门面（减少各模块直接依赖 ST 内部函数）
 *  3. Phase 2.3 将注册为 Amily2Bus 服务，届时外部模块改为 query('LoreService')
 *
 * 当前消费方：
 *  - core/super-memory/lorebook-bridge.js  → ensureBook()
 *  - core/historiographer.js               → saveBook()
 *  - core/lore.js                          → （Phase 2.3 后迁入）
 */

import { registerInternalBusPlugin } from '../SL/bus/Amily2Bus.js';

import {
    loadWorldInfo,
    createNewWorldInfo,
    saveWorldInfo,
} from '/scripts/world-info.js';
import {
    eventSource,
    event_types,
    getRequestHeaders,
} from '/script.js';
import {
    commitWorldInfoMutationStrict,
    persistWorldInfoStrict,
} from './strict-world-info-persistence.js';

// ── 写锁实现 ─────────────────────────────────────────────────────────────────
//
// 所有写操作排入同一个 Promise chain，保证串行执行。
// 读操作无锁，并发安全。

let _writeLock = Promise.resolve();
let _hostWorldInfoCache;

async function resolveHostWorldInfoCache() {
    if (_hostWorldInfoCache !== undefined) return _hostWorldInfoCache;
    try {
        const worldInfoModule = await import('/scripts/world-info.js');
        _hostWorldInfoCache = worldInfoModule.worldInfoCache ?? null;
    } catch (error) {
        console.warn('[LoreService] 当前 SillyTavern 未公开 worldInfoCache；严格保存后将依靠宿主事件刷新。', error);
        _hostWorldInfoCache = null;
    }
    return _hostWorldInfoCache;
}

/**
 * 在写锁保护下执行 fn，所有世界书写操作应通过此函数。
 * @template T
 * @param {string}        label  - 操作标识，用于日志定位
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withLoreLock(label, fn) {
    const result = _writeLock.then(() => {
        console.log(`[LoreService] 写锁获取: ${label}`);
        return fn();
    });
    // 出错时不阻断后续排队操作，但让错误传播给调用方
    _writeLock = result.then(
        () => { console.log(`[LoreService] 写锁释放: ${label}`); },
        () => { console.warn(`[LoreService] 写锁释放（含错误）: ${label}`); },
    );
    return result;
}

// ── 读操作（无锁）────────────────────────────────────────────────────────────

/**
 * 加载世界书数据（只读，不加锁）。
 * @param {string} bookName
 * @returns {Promise<object|null>}
 */
export async function loadBook(bookName) {
    return loadWorldInfo(bookName);
}

// ── 写操作（全部走写锁）──────────────────────────────────────────────────────

/**
 * 确保世界书存在，不存在则创建。防止并发双重创建。
 * @param {string} bookName
 * @returns {Promise<object>} 世界书数据
 */
export async function ensureBook(bookName) {
    return withLoreLock(`ensureBook(${bookName})`, async () => {
        const existing = await loadWorldInfo(bookName);
        if (existing) return existing;
        console.log(`[LoreService] 世界书不存在，正在创建: ${bookName}`);
        return createNewWorldInfo(bookName);
    });
}

/**
 * 保存世界书数据。
 * @param {string}  bookName
 * @param {object}  bookData
 * @param {boolean} [silent=true]
 * @returns {Promise<void>}
 */
export async function saveBook(bookName, bookData, silent = true) {
    return withLoreLock(`saveBook(${bookName})`, () =>
        saveWorldInfo(bookName, bookData, silent)
    );
}

/**
 * Strictly persist a world-info draft while the caller already owns the lore
 * write lock. HTTP/network failure leaves the host cache untouched.
 *
 * @param {string} bookName
 * @param {object} bookData Independent candidate draft
 * @param {{
 *   fetchImpl?: Function,
 *   getHeaders?: Function,
 *   cache?: object,
 *   eventEmitter?: object,
 *   updatedEvent?: unknown,
 *   logger?: object,
 * }} [options]
 */
export async function saveBookStrictUnlocked(bookName, bookData, options = {}) {
    const optionOr = (key, fallback) =>
        Object.prototype.hasOwnProperty.call(options, key)
            ? options[key]
            : fallback;
    const headersProvider = options.getHeaders ?? getRequestHeaders;
    const hostCache = await resolveHostWorldInfoCache();
    return persistWorldInfoStrict({
        name: bookName,
        data: bookData,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        headers: await Promise.resolve(headersProvider()),
        cache: optionOr('cache', hostCache),
        eventEmitter: optionOr('eventEmitter', eventSource),
        updatedEvent: optionOr(
            'updatedEvent',
            event_types.WORLDINFO_UPDATED,
        ),
        logger: optionOr('logger', console),
    });
}

/**
 * Strict single-request save for callers that do not already own the lock.
 */
export async function saveBookStrict(bookName, bookData, options = {}) {
    return withLoreLock(
        `saveBookStrict(${bookName})`,
        () => saveBookStrictUnlocked(bookName, bookData, options),
    );
}

/**
 * Clone, mutate and strictly persist a world-info book under the shared lore
 * write lock. The object returned by loadWorldInfo is never mutated directly.
 *
 * @param {string} bookName
 * @param {(draft: object, source: object|null|undefined) => unknown} mutateDraft
 * @param {{
 *   loadData?: Function,
 *   createEmptyData?: Function,
 *   fetchImpl?: Function,
 *   getHeaders?: Function,
 *   cache?: object,
 *   eventEmitter?: object,
 *   updatedEvent?: unknown,
 *   logger?: object,
 * }} [options]
 */
export async function mutateBookStrict(bookName, mutateDraft, options = {}) {
    const {
        loadData = () => loadWorldInfo(bookName),
        createEmptyData,
        ...saveOptions
    } = options;
    return withLoreLock(
        `mutateBookStrict(${bookName})`,
        () => commitWorldInfoMutationStrict({
            name: bookName,
            loadData,
            mutateDraft,
            persistDraft: (_name, draft) =>
                saveBookStrictUnlocked(bookName, draft, saveOptions),
            ...(typeof createEmptyData === 'function'
                ? { createEmptyData }
                : {}),
        }),
    );
}

// ── Bus 注册 ──────────────────────────────────────────────────────────────────
// Bus 注册名：'LoreService'
// 公共 Bus 仅发布状态；世界书读写由 Amily 内部模块直接导入。
(() => {
    try {
        const _ctx = registerInternalBusPlugin('LoreService');
        if (!_ctx) {
            console.warn('[LoreService] Amily2Bus 尚未就绪，服务注册跳过。');
            return;
        }
        _ctx.expose({ getStatus: () => Object.freeze({ ready: true }) });
        _ctx.log('LoreService', 'info', 'LoreService 已注册到 Bus。');
    } catch (e) {
        console.error('[LoreService] Bus 注册失败:', e);
    }
})();
