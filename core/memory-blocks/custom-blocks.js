/**
 * core/memory-blocks/custom-blocks.js — 用户自定义块的持久化（Phase 2）
 *
 * 自定义块以纯 JSON（BlockDefinition 数组）存于
 * extension_settings[extensionName].memoryBlocks_customBlocks，
 * 与运行时注册中心（registry.js）双向同步：
 *   - bootstrap / UI 初始化时 syncCustomBlocksFromSettings() 全量重放
 *   - 增删改 CRUD 同时更新 settings 与 registry，并 saveSettingsDebounced
 *
 * 自定义块 id 一律以 'custom.' 为前缀，与内置块（'plotOpt.sulv1' 等）天然
 * 隔离；CRUD 仅对该前缀生效，内置块不可经此修改或删除。
 */

import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { extensionName } from '../../utils/settings.js';
import { register, unregister, listAll } from './registry.js';

const STORAGE_KEY = 'memoryBlocks_customBlocks';
export const CUSTOM_ID_PREFIX = 'custom.';

export function isCustomBlockId(id) {
    return typeof id === 'string' && id.startsWith(CUSTOM_ID_PREFIX);
}

function getStore() {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    const s = extension_settings[extensionName];
    if (!Array.isArray(s[STORAGE_KEY])) s[STORAGE_KEY] = [];
    return s[STORAGE_KEY];
}

function persist() {
    saveSettingsDebounced();
}

function newCustomId() {
    return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 把 settings 中的自定义块全量重放进 registry（幂等，可重复调用）。
 * 单个块定义损坏时跳过并告警，不影响其余块。
 */
export function syncCustomBlocksFromSettings() {
    for (const b of listAll()) {
        if (isCustomBlockId(b.id)) unregister(b.id);
    }
    for (const def of getStore()) {
        try {
            register(def);
        } catch (error) {
            console.warn(`[MemoryBlocks] 自定义块定义损坏，已跳过:`, def, error);
        }
    }
}

/** 列出某 context 下的自定义块（settings 为权威源；不过滤 enabled）。 */
export function listCustomBlocks(context) {
    const store = getStore();
    return context ? store.filter(b => b.context === context) : [...store];
}

export function getCustomBlock(id) {
    return getStore().find(b => b.id === id) ?? null;
}

/**
 * 新增自定义块。def 不含 id（自动生成）；校验失败时抛错、不落库。
 * @returns {Object} 落库后的完整定义
 */
export function addCustomBlock(def) {
    const full = { enabled: true, ...def, id: newCustomId() };
    register(full); // 先过 registry 校验，抛错则不落库
    getStore().push(full);
    persist();
    return full;
}

/** 修改自定义块（浅合并 patch；id/非 custom 块不可改）。 */
export function updateCustomBlock(id, patch) {
    if (!isCustomBlockId(id)) throw new Error(`[MemoryBlocks] 仅自定义块可修改: ${id}`);
    const store = getStore();
    const idx = store.findIndex(b => b.id === id);
    if (idx === -1) throw new Error(`[MemoryBlocks] 自定义块不存在: ${id}`);
    const merged = { ...store[idx], ...patch, id };
    register(merged); // 校验 + 覆盖注册
    store[idx] = merged;
    persist();
    return merged;
}

export function deleteCustomBlock(id) {
    if (!isCustomBlockId(id)) return false;
    const store = getStore();
    const idx = store.findIndex(b => b.id === id);
    if (idx === -1) return false;
    store.splice(idx, 1);
    unregister(id);
    persist();
    return true;
}
