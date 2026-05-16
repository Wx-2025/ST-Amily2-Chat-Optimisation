/**
 * @file API 厂商识别 + 参数 registry 查询。
 *
 * Registry 文件：assets/api-vendor-params.json
 * 加载策略：模块首次调用时 fetch 一次，缓存到 _registry。
 *
 * 提供的能力：
 *   - detectVendor(apiUrl) → vendorId | null
 *   - getVendorEntry(vendorId) → 完整 vendor 对象（含 params 元信息）
 *   - listVendorParams(vendorId) → [{ name, type, desc, ... }]
 *   - getRegistry() → 整个 registry（debug 用）
 *
 * Phase A 仅用于 customParams 编辑器的提示展示，不做强制校验。
 * Phase B 计划：迁移现有 15 处散乱的 `apiUrl.includes('googleapis.com')` 等检查到 detectVendor 单一入口。
 */

import { extensionName } from './settings.js';

const REGISTRY_PATH = `scripts/extensions/third-party/${extensionName}/assets/api-vendor-params.json`;

/** @type {Promise<any> | null} */
let _registryPromise = null;
/** @type {any | null} */
let _registry = null;

/**
 * 懒加载 registry，缓存到模块作用域。多次调用只 fetch 一次。
 * @returns {Promise<any>}
 */
async function _loadRegistry() {
    if (_registry) return _registry;
    if (!_registryPromise) {
        _registryPromise = fetch(REGISTRY_PATH)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status} 加载 ${REGISTRY_PATH} 失败`);
                return res.json();
            })
            .then(data => {
                _registry = data;
                return data;
            })
            .catch(err => {
                console.error('[api-vendor] registry 加载失败:', err);
                // 降级到内置最小 fallback，保证业务不中断
                _registry = {
                    version: 0,
                    vendors: [],
                    fallback: { id: 'openai-compat', displayName: 'OpenAI-compatible', params: {} },
                };
                return _registry;
            });
    }
    return _registryPromise;
}

/**
 * 强制刷新 registry（开发期热更新或测试用）。
 */
export async function reloadRegistry() {
    _registry = null;
    _registryPromise = null;
    return _loadRegistry();
}

/**
 * 返回完整 registry。供 UI 列举所有 vendor、debug 用。
 * @returns {Promise<any>}
 */
export async function getRegistry() {
    return _loadRegistry();
}

/**
 * 根据 apiUrl 识别 vendor。匹配不上时返回 fallback.id（默认 'openai-compat'）。
 * 大小写不敏感的 substring 匹配。
 *
 * @param {string} apiUrl
 * @returns {Promise<string | null>}
 */
export async function detectVendor(apiUrl) {
    const reg = await _loadRegistry();
    const url = (apiUrl || '').toLowerCase();
    if (!url) return reg.fallback?.id || null;

    for (const vendor of reg.vendors || []) {
        const matches = vendor.match || [];
        if (matches.some(m => url.includes(String(m).toLowerCase()))) {
            return vendor.id;
        }
    }
    return reg.fallback?.id || null;
}

/**
 * 根据 vendorId 取完整 vendor 对象（含 params 元信息）。
 * fallback id 也能查到。
 *
 * @param {string | null | undefined} vendorId
 * @returns {Promise<any | null>}
 */
export async function getVendorEntry(vendorId) {
    if (!vendorId) return null;
    const reg = await _loadRegistry();
    if (reg.fallback && vendorId === reg.fallback.id) return reg.fallback;
    return (reg.vendors || []).find(v => v.id === vendorId) || null;
}

/**
 * 列出指定 vendor 的所有标准参数（已过滤掉 _doc / _warning_* 这类 meta 字段）。
 *
 * @param {string | null | undefined} vendorId
 * @returns {Promise<Array<{ name: string, type?: string, range?: number[], values?: string[], desc?: string }>>}
 */
export async function listVendorParams(vendorId) {
    const entry = await getVendorEntry(vendorId);
    if (!entry || !entry.params) return [];
    return Object.entries(entry.params)
        .filter(([k]) => !k.startsWith('_'))
        .map(([name, meta]) => ({ name, ...(meta || {}) }));
}

/**
 * 同步版：从已加载的 registry 直接查询。仅在确知已 await 过 _loadRegistry 后使用，
 * 主要给 UI render 循环用（避免 React-style 异步重渲染）。
 * registry 未加载时返回空。
 *
 * @param {string} apiUrl
 * @returns {string | null}
 */
export function detectVendorSync(apiUrl) {
    if (!_registry) return null;
    const url = (apiUrl || '').toLowerCase();
    if (!url) return _registry.fallback?.id || null;
    for (const vendor of _registry.vendors || []) {
        const matches = vendor.match || [];
        if (matches.some(m => url.includes(String(m).toLowerCase()))) {
            return vendor.id;
        }
    }
    return _registry.fallback?.id || null;
}

/**
 * 同步版 listVendorParams。同样要求 registry 已 preload。
 * @param {string | null | undefined} vendorId
 * @returns {Array<{ name: string, type?: string, range?: number[], values?: string[], desc?: string }>}
 */
export function listVendorParamsSync(vendorId) {
    if (!_registry || !vendorId) return [];
    let entry = null;
    if (_registry.fallback && vendorId === _registry.fallback.id) entry = _registry.fallback;
    else entry = (_registry.vendors || []).find(v => v.id === vendorId) || null;
    if (!entry || !entry.params) return [];
    return Object.entries(entry.params)
        .filter(([k]) => !k.startsWith('_'))
        .map(([name, meta]) => ({ name, ...(meta || {}) }));
}
