/**
 * ConfigManager — 独立配置持久化管理模块
 *
 * 解决的安全问题：
 *   SillyTavern 的 extension_settings 会通过 saveSettingsDebounced() 上传到 ST
 *   服务端 settings.json。使用三方云服务商时，服务商可读取该文件，导致所有
 *   API 密钥泄露。
 *
 * 解决方案：
 *   敏感字段（API Key / URL）→ localStorage（浏览器本地，绝不上传）
 *   非敏感字段              → extension_settings（维持原有行为）
 *
 * Bus 注册名：'Config'
 *
 * 公开接口（query('Config')）：
 *   get(key)              — 读取配置项（自动路由）
 *   set(key, value)       — 写入配置项（自动路由 + 触发保存）
 *   getSettings()         — 返回完整配置对象（敏感字段从 localStorage 注入）
 *   migrate()             — 将 extension_settings 中残留的敏感字段迁移到 localStorage
 */

import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../settings.js";
import { SENSITIVE_KEYS } from "./sensitive-keys.js";
import { apiKeyStore } from "./api-key-store/ApiKeyStore.js";

// localStorage key 前缀，避免与其他插件冲突
const LS_PREFIX = 'amily2_secure_';

// ── ConfigManager ────────────────────────────────────────────────────────────

class ConfigManager {
    async init() {
        await apiKeyStore.init();
        await this.syncSensitiveCache({ force: true });
    }

    /**
     * 读取配置项。
     * 敏感字段从 localStorage 读取，其余从 extension_settings 读取。
     * @param {string} key
     * @returns {*}
     */
    get(key) {
        if (SENSITIVE_KEYS.has(key)) {
            return localStorage.getItem(LS_PREFIX + key) ?? '';
        }
        return extension_settings[extensionName]?.[key];
    }

    /**
     * 写入配置项并持久化。
     * 敏感字段写入 localStorage（同时从 extension_settings 清除残留）。
     * 非敏感字段写入 extension_settings 并触发 saveSettingsDebounced。
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        if (SENSITIVE_KEYS.has(key)) {
            this._setSensitiveCacheValue(key, value);
            // 确保 extension_settings 中不保留该敏感字段
            const settings = extension_settings[extensionName];
            if (settings && Object.prototype.hasOwnProperty.call(settings, key)) {
                delete settings[key];
                saveSettingsDebounced();
            }
            if (apiKeyStore.getMode() === 'cloud') {
                apiKeyStore.setKey(key, value).catch(e => {
                    console.error(`[ConfigManager] 云同步敏感字段 "${key}" 失败:`, e);
                });
            }
        } else {
            if (!extension_settings[extensionName]) {
                extension_settings[extensionName] = {};
            }
            extension_settings[extensionName][key] = value;
            saveSettingsDebounced();
        }
    }

    /**
     * 返回完整配置对象（合并视图）。
     * 以 extension_settings 为基础，将 localStorage 中的敏感字段注入覆盖。
     *
     * 用途：替换现有 `const settings = extension_settings[extensionName]` 的读取点，
     * 使 API 调用模块能透明地获取到敏感字段，无需感知存储层差异。
     *
     * @returns {Object}
     */
    getSettings() {
        const base = extension_settings[extensionName] ?? {};
        const result = { ...base };
        for (const key of SENSITIVE_KEYS) {
            const val = localStorage.getItem(LS_PREFIX + key);
            // null 表示 localStorage 中不存在，保留 base 中原值（如有）
            if (val !== null) {
                result[key] = val;
            }
        }
        return result;
    }

    /**
     * 迁移：将 extension_settings 中已存在的敏感字段移到 localStorage。
     *
     * 应在插件初始化阶段调用一次。
     * 逻辑：
     *   - 若 extension_settings 有值 → 迁移到 localStorage（若 localStorage 已有值则跳过，保留用户上次输入）
     *   - 从 extension_settings 删除该字段
     *   - 最终触发一次 saveSettingsDebounced 清洗服务端
     */
    migrate() {
        const settings = extension_settings[extensionName];
        if (!settings) return;

        let needsSave = false;

        for (const key of SENSITIVE_KEYS) {
            const settingsVal = settings[key];
            if (settingsVal !== undefined && settingsVal !== '') {
                // localStorage 中已有值时不覆盖（优先保留用户最新输入）
                if (!localStorage.getItem(LS_PREFIX + key)) {
                    localStorage.setItem(LS_PREFIX + key, settingsVal);
                    console.info(`[Amily2-Config] 已迁移敏感字段 "${key}" 到本地安全存储。`);
                }
                delete settings[key];
                needsSave = true;
            }
        }

        if (needsSave) {
            saveSettingsDebounced();
            console.info('[Amily2-Config] 敏感配置迁移完成，已从云同步配置中清除密钥。');
        }
    }

    async syncSensitiveCache({ force = false } = {}) {
        if (apiKeyStore.getMode() !== 'cloud') return;
        await apiKeyStore.init();
        if (!apiKeyStore.isCloudReady()) return;

        for (const key of SENSITIVE_KEYS) {
            const cached = localStorage.getItem(LS_PREFIX + key);
            if (!force && cached !== null && cached !== '') continue;

            const value = await apiKeyStore.getKey(key);
            this._setSensitiveCacheValue(key, value);
        }
    }

    _setSensitiveCacheValue(key, value) {
        if (value !== null && value !== undefined && value !== '') {
            localStorage.setItem(LS_PREFIX + key, value);
        } else {
            localStorage.removeItem(LS_PREFIX + key);
        }
    }
}

// ── 单例导出 ─────────────────────────────────────────────────────────────────
export const configManager = new ConfigManager();

// ── Bus 注册 ──────────────────────────────────────────────────────────────────
// setTimeout 确保 window.Amily2Bus 在 Amily2Bus.js 模块体执行后已挂载
setTimeout(() => {
    try {
        const _ctx = window.Amily2Bus?.register('Config');
        if (!_ctx) {
            console.warn('[Config] Amily2Bus 尚未就绪，Config 服务注册跳过。');
            return;
        }
        _ctx.expose({
            get:         (key)        => configManager.get(key),
            set:         (key, value) => configManager.set(key, value),
            getSettings: ()           => configManager.getSettings(),
            migrate:     ()           => configManager.migrate(),
            init:        ()           => configManager.init(),
            syncSensitiveCache: (options) => configManager.syncSensitiveCache(options),
        });
        _ctx.log('ConfigManager', 'info', 'Config 服务已注册到 Bus。');
    } catch (e) {
        console.error('[Config] Bus 注册失败:', e);
    }
}, 0);
