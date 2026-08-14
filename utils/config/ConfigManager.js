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
 * Bus 只公开不含配置内容的就绪状态。配置读取、写入、迁移与敏感缓存同步
 * 仅供 Amily 内部模块导入使用，不能进入全局查询面。
 */

import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../settings.js";
import { SENSITIVE_KEYS } from "./sensitive-keys.js";
import { apiKeyStore } from "./api-key-store/ApiKeyStore.js";
import { registerInternalBusPlugin } from '../../SL/bus/Amily2Bus.js';

// localStorage key 前缀，避免与其他插件冲突
const LS_PREFIX = 'amily2_secure_';

// ── ConfigManager ────────────────────────────────────────────────────────────

export class ConfigManager {
    constructor() {
        this._vaultSensitiveCache = new Map();
        this._vaultCacheScope = null;
        this._vaultCacheRevision = 0;
        this._vaultFieldRevisions = new Map();
        this._manualCloudFieldStates = new Map();
    }

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
            if (apiKeyStore.getMode() === 'vault') {
                return this._vaultSensitiveCache.get(key) ?? '';
            }
            return localStorage.getItem(LS_PREFIX + key) ?? '';
        }
        return extension_settings[extensionName]?.[key];
    }

    /**
     * Check whether a setting exists without copying a credential into UI state.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        if (SENSITIVE_KEYS.has(key)) {
            if (apiKeyStore.getMode() === 'vault') {
                return Boolean(this._vaultSensitiveCache.get(key));
            }
            return Boolean(localStorage.getItem(LS_PREFIX + key));
        }
        const value = extension_settings[extensionName]?.[key];
        return value !== undefined && value !== null && value !== '';
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
            const mode = apiKeyStore.getMode();
            if (mode === 'vault') {
                const previousValue = this._vaultSensitiveCache.get(key);
                const fieldRevision = (this._vaultFieldRevisions.get(key) || 0) + 1;
                this._vaultFieldRevisions.set(key, fieldRevision);
                this._vaultCacheRevision += 1;
                this._setVaultSensitiveCacheValue(key, value);
                apiKeyStore.setKey(key, value).catch(() => {
                    if (this._vaultFieldRevisions.get(key) !== fieldRevision) return;
                    this._setVaultSensitiveCacheValue(key, previousValue);
                    this._vaultFieldRevisions.set(key, fieldRevision + 1);
                    this._vaultCacheRevision += 1;
                    console.warn(`[ConfigManager] 授权码云同步字段 "${key}" 失败，本次修改未提交。`);
                });
            } else if (mode === 'cloud') {
                const previousState = this._manualCloudFieldStates.get(key);
                const state = previousState?.pending > 0
                    ? previousState
                    : {
                        revision: previousState?.revision || 0,
                        pending: 0,
                        durableValue: localStorage.getItem(LS_PREFIX + key),
                    };
                const fieldRevision = state.revision + 1;
                state.revision = fieldRevision;
                state.pending += 1;
                this._manualCloudFieldStates.set(key, state);
                this._setSensitiveCacheValue(key, value);
                apiKeyStore.setKey(key, value).then(() => {
                    if (this._manualCloudFieldStates.get(key) !== state) return;
                    state.durableValue = value !== null && value !== undefined && value !== ''
                        ? String(value)
                        : null;
                    state.pending = Math.max(0, state.pending - 1);
                }).catch(() => {
                    if (this._manualCloudFieldStates.get(key) !== state) return;
                    state.pending = Math.max(0, state.pending - 1);
                    if (state.revision !== fieldRevision) return;
                    this._setSensitiveCacheValue(key, state.durableValue);
                    state.revision = fieldRevision + 1;
                    console.warn(`[ConfigManager] 云同步敏感字段 "${key}" 失败，本次修改未提交。`);
                });
            } else {
                this._manualCloudFieldStates.delete(key);
                this._setSensitiveCacheValue(key, value);
                apiKeyStore.notePlaintextMutation();
            }
            // 确保 extension_settings 中不保留该敏感字段
            const settings = extension_settings[extensionName];
            if (settings && Object.prototype.hasOwnProperty.call(settings, key)) {
                delete settings[key];
                saveSettingsDebounced();
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
            const val = apiKeyStore.getMode() === 'vault'
                ? (this._vaultSensitiveCache.has(key)
                    ? this._vaultSensitiveCache.get(key)
                    : null)
                : localStorage.getItem(LS_PREFIX + key);
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
        const mode = apiKeyStore.getMode();
        if (mode !== 'cloud' && mode !== 'vault') return;
        await apiKeyStore.init();
        if (!apiKeyStore.isCloudReady()) return;

        let snapshot;
        try {
            snapshot = await apiKeyStore.readEncryptedPlainSnapshot();
        } catch {
            // A missing, mismatched or damaged private key must not block the
            // host/plugin bootstrap and must not erase an existing safe cache.
            console.warn('[ConfigManager] 加密凭证尚未就绪，已保留当前缓存。');
            return;
        }
        if (snapshot.mutationRevision !== apiKeyStore.getMutationRevision()) return;

        if (mode === 'vault') {
            const scopeHash = apiKeyStore.getActiveVaultScopeHash();
            if (!scopeHash) return;
            this.hydrateVaultSensitiveCache({
                values: snapshot.values,
                scopeHash,
                expectedMutationRevision: snapshot.mutationRevision,
            });
            try {
                apiKeyStore.finalizeVaultMigration({
                    scopeHash,
                    expectedMutationRevision: snapshot.mutationRevision,
                    fingerprint: snapshot.fingerprint,
                    remoteRevision: snapshot.remoteRevision,
                    cipherFields: snapshot.cipherFields,
                    validatedFields: snapshot.validatedFields,
                });
            } catch {
                // Journal validation is cleanup, not a bootstrap dependency.
                // Preserve the encrypted cache and the plaintext fallback so a
                // damaged/stale journal cannot block the plugin from loading.
                console.warn('[ConfigManager] Vault 迁移回退尚未完成验证，已保留回退数据。');
            }
            return;
        }

        const nextValues = new Map();
        for (const key of SENSITIVE_KEYS) {
            const cached = localStorage.getItem(LS_PREFIX + key);
            if (!force && cached !== null && cached !== '') continue;
            nextValues.set(key, Object.prototype.hasOwnProperty.call(snapshot.values, key)
                ? snapshot.values[key]
                : '');
        }
        if (snapshot.mutationRevision !== apiKeyStore.getMutationRevision()) return;
        for (const [key, value] of nextValues) {
            this._setSensitiveCacheValue(key, value);
        }
    }

    hydrateVaultSensitiveCache({ values, scopeHash, expectedMutationRevision }) {
        if (apiKeyStore.getMode() !== 'vault'
            || scopeHash !== apiKeyStore.getActiveVaultScopeHash()
            || expectedMutationRevision !== apiKeyStore.getMutationRevision()) {
            throw new Error('Vault cache hydration is stale.');
        }
        const staged = new Map();
        for (const key of SENSITIVE_KEYS) {
            const value = Object.prototype.hasOwnProperty.call(values || {}, key)
                ? values[key]
                : '';
            if (typeof value !== 'string') {
                throw new TypeError('Vault cache contains an invalid credential value.');
            }
            if (value) staged.set(key, value);
        }
        this._vaultSensitiveCache = staged;
        this._vaultCacheScope = scopeHash;
        this._vaultFieldRevisions.clear();
        this._vaultCacheRevision += 1;
        return this.getVaultCacheStatus();
    }

    clearVaultSensitiveCache({ clearPersistentFallback = false } = {}) {
        this._vaultSensitiveCache.clear();
        this._vaultCacheScope = null;
        this._vaultFieldRevisions.clear();
        this._vaultCacheRevision += 1;
        if (clearPersistentFallback) {
            for (const key of SENSITIVE_KEYS) {
                localStorage.removeItem(LS_PREFIX + key);
            }
        }
    }

    /**
     * Retire every decrypted Vault credential in the current synchronous turn.
     *
     * Authorization cleanup also asks VaultSyncController to abort network work
     * and retire device state asynchronously. That promise boundary is too late
     * for callers which immediately continue after logout/expiry, especially
     * profile credentials that are decrypted directly by ApiKeyStore instead of
     * being served from ConfigManager's fixed-field cache.
     *
     * Migration plaintext is intentionally preserved. It may only be removed
     * after the existing reload/durability validation succeeds.
     */
    suspendVaultSensitiveRuntime() {
        this.clearVaultSensitiveCache();
        if (apiKeyStore.getMode() !== 'vault') return false;
        apiKeyStore.suspendVaultRuntimeState();
        return true;
    }

    getVaultCacheStatus() {
        return Object.freeze({
            ready: Boolean(this._vaultCacheScope),
            scopeBound: Boolean(this._vaultCacheScope),
            revision: this._vaultCacheRevision,
            populatedFields: this._vaultSensitiveCache.size,
        });
    }

    _setVaultSensitiveCacheValue(key, value) {
        if (value !== null && value !== undefined && value !== '') {
            this._vaultSensitiveCache.set(key, String(value));
        } else {
            this._vaultSensitiveCache.delete(key);
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
try {
    const _ctx = registerInternalBusPlugin('Config');
    _ctx.expose({
        getStatus: () => Object.freeze({ ready: true }),
    });
    _ctx.log('ConfigManager', 'info', 'Config 服务已注册到 Bus。');
} catch (e) {
    console.error('[Config] Bus 注册失败:', e);
}
