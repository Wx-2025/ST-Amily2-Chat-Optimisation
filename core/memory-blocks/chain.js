/**
 * core/memory-blocks/chain.js
 *
 * 顺序拼接式工作流：把 context 下所有启用块的结果，按 block.order 排序后用 separator
 * 拼接，并可选 header/footer 包裹，最终输出一个"完整的注入块"字符串。
 *
 * 与 executor.js（模板替换式）并列两种组合范式：
 *   - executor: 模板里挖空 placeholder，块负责填料 → 替换式
 *   - chain:    无模板，块各自产出一段文本 → 顺序拼成一整段
 *
 * 战斗系统设计稿（§3.2）里的"战报作底部独立注入块"、未来的"记忆注入合成块"
 * 都是 chain 模式的天然用例：战斗模块只需声明一个 BlockDefinition，order 取大
 * 就自动落在拼接末尾。
 *
 * ── Chain 定义（纯数据、JSON 可序列化）─────────────────────────────────────
 *   {
 *     id:        string       // 与 BlockDefinition.context 对齐，块通过 context 隐式归属
 *     name?:     string       // UI 显示名
 *     separator?: string      // 块间分隔符，默认 '\n\n'
 *     header?:   string       // 整段前缀，可选
 *     footer?:   string       // 整段后缀，可选
 *   }
 *
 * Chain 无须显式注册也能 compose——未注册时使用默认值，方便临时拼接。
 */

import { executeContext } from './runner.js';

const chains = new Map();

const DEFAULT_SEPARATOR = '\n\n';

function validateChain(def) {
    if (!def || typeof def !== 'object') throw new Error('[MemoryBlocks/Chain] 定义必须是对象。');
    if (!def.id) throw new Error('[MemoryBlocks/Chain] Chain.id 必填。');
}

export function registerChain(def) {
    validateChain(def);
    chains.set(def.id, {
        separator: DEFAULT_SEPARATOR,
        header: '',
        footer: '',
        ...def,
    });
}

export function unregisterChain(id) {
    return chains.delete(id);
}

export function getChain(id) {
    return chains.get(id) ?? null;
}

export function listChains() {
    return [...chains.values()];
}

/**
 * 执行 Chain，按 order 排序后拼接成最终字符串。
 *
 * @param {string} chainId
 * @param {{ settings?, signal?, extras? }} [opts]
 * @returns {Promise<string>}
 */
export async function composeChain(chainId, opts = {}) {
    if (!chainId) return '';
    const chain = getChain(chainId);
    const results = await executeContext({ context: chainId, ...opts });

    const sorted = results
        .filter(r => r !== null)
        .sort((a, b) => (a.block.order ?? 0) - (b.block.order ?? 0));

    const separator = chain?.separator ?? DEFAULT_SEPARATOR;
    const body = sorted.map(r => r.value).join(separator);

    const parts = [chain?.header, body, chain?.footer]
        .map(p => (typeof p === 'string' ? p : ''))
        .filter(p => p.length > 0);

    return parts.join(separator);
}

/**
 * 取 Chain 的执行结果明细（含每块原值），用于调试或调用方自定义后处理。
 *
 * @returns {Promise<Array<{ block, value }>>}
 */
export async function inspectChain(chainId, opts = {}) {
    if (!chainId) return [];
    const results = await executeContext({ context: chainId, ...opts });
    return results
        .filter(r => r !== null)
        .sort((a, b) => (a.block.order ?? 0) - (b.block.order ?? 0));
}
