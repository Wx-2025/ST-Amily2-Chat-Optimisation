/**
 * api-resolver.js — API 配置槽位解析器
 *
 * 职责：
 *   优先从 ApiProfileManager 读取功能槽分配的 Profile（含解密 Key），
 *   无分配时返回 null，由调用方执行旧配置兜底。
 *
 * 使用方式：
 *   const profile = await getSlotProfile('main');
 *   if (profile) { // 用 profile.provider / apiUrl / apiKey / model ... }
 *   else          { // 回退到旧 DOM / extension_settings 读取 }
 *
 * provider → apiMode 映射（供 Nccs / Ngms / Jqyh 内部 switch 使用）：
 *   'openai'             → 'openai_test'  (经 ST 后端代理发送，规避 CORS)
 *   'google'             → 'openai_test'  (Google OpenAI-compat 同样走代理)
 *   'sillytavern_backend'→ 'openai_test'
 *   'sillytavern_preset' → 'sillytavern_preset'
 */

import { apiProfileManager } from '../../utils/config/ApiProfileManager.js';

/**
 * 将 Profile.provider 映射到子模块使用的 apiMode 字段。
 * @param {string} provider
 * @returns {'openai_test'|'sillytavern_preset'}
 */
export function providerToApiMode(provider) {
    return provider === 'sillytavern_preset' ? 'sillytavern_preset' : 'openai_test';
}

/**
 * 获取功能槽对应的完整 Profile（含解密 Key）。
 * 未分配或读取失败时返回 null。
 *
 * @param {string} slot  功能槽名（见 ApiProfileManager.SLOTS）
 * @returns {Promise<Object|null>}
 */
export async function getSlotProfile(slot) {
    try {
        return await apiProfileManager.getAssignedProfile(slot);
    } catch (e) {
        console.warn(`[ApiResolver] 读取槽位 "${slot}" 失败，降级到旧配置:`, e);
        return null;
    }
}
