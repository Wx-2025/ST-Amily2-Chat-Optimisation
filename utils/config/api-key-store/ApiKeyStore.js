/**
 * ApiKeyStore — 专用 API 凭证管理模块
 *
 * 存储策略（用户可选）：
 *
 *   'local'（默认）
 *     API Key 明文存储在 localStorage（前缀 amily2_secure_）。
 *     不随 ST 设置上传，绝对安全，但换设备需重新填写。
 *
 *   'cloud'
 *     API Key 使用混合加密（RSA-OAEP + AES-256-GCM）后存入 extension_settings。
 *     私钥仅保存在本设备 localStorage，服务端只能看到密文。
 *     换设备时密文跟着走，但需要在新设备上重新生成密钥对并重新输入 Key。
 *     可大幅提升技术攻击成本（被动读取 settings.json 完全无效）。
 *
 *   注意：API URL 不是凭证，始终存储在 extension_settings（云同步，方便多端）。
 *
 * Bus 注册名：'ApiKeyStore'
 *
 * 公开接口（query('ApiKeyStore')）：
 *   getKey(field)              — 读取指定凭证（自动按模式解密）
 *   setKey(field, value)       — 写入指定凭证（自动按模式加密）
 *   getMode()                  — 返回当前存储模式 'local' | 'cloud'
 *   setMode(mode)              — 切换存储模式（会迁移现有数据）
 *   isCloudReady()             — cloud 模式下密钥对是否已就绪
 *   generateKeyPair()          — 生成新密钥对（会清除旧加密数据）
 *   getPublicKeyInfo()         — 返回公钥摘要字符串（用于 UI 展示）
 *   exportEncryptedBackup()    — 导出加密备份（JSON，含密文+公钥，不含私钥）
 */

import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../../settings.js";
import { SENSITIVE_KEYS } from "../sensitive-keys.js";
import {
    generateKeyPair,
    serializeKeyPair,
    importPublicKey,
    importPrivateKey,
    encrypt,
    decrypt,
} from "./crypto-utils.js";

// ── 存储 key 常量 ─────────────────────────────────────────────────────────────
const LS_MODE_KEY      = 'amily2_keystore_mode';      // 'local' | 'cloud'
const LS_PRIVATE_KEY   = 'amily2_keypair_private';    // JWK 字符串
const LS_PLAIN_PREFIX  = 'amily2_secure_';            // local 模式明文前缀
const EXT_PUBKEY       = 'amily2_pubkey';             // extension_settings 中的公钥
const EXT_ENC_PREFIX   = 'amily2_enc_';               // extension_settings 中的密文前缀

// ── ApiKeyStore ───────────────────────────────────────────────────────────────

class ApiKeyStore {
    constructor() {
        this._publicKey  = null;   // CryptoKey（运行时缓存）
        this._privateKey = null;   // CryptoKey（运行时缓存）
        this._keyReady   = false;
        this._initPromise = null;
    }

    // ── 初始化 ──────────────────────────────────────────────────────────────

    /**
     * 异步初始化：若为 cloud 模式则加载密钥对到内存缓存。
     * 由 Bus 注册后自动调用，也可手动 await。
     */
    async init() {
        if (this.getMode() === 'cloud') {
            await this._loadKeyPair();
        }
    }

    // ── 公开 API ────────────────────────────────────────────────────────────

    /** 读取指定凭证字段（SENSITIVE_KEYS 内的字段） */
    async getKey(field) {
        if (!SENSITIVE_KEYS.has(field)) {
            console.warn(`[ApiKeyStore] "${field}" 不是凭证字段，请用 configManager.get() 读取普通配置。`);
            return undefined;
        }
        if (this.getMode() === 'cloud') {
            return this._getCloud(field);
        }
        return this._getLocal(field);
    }

    /** 写入指定凭证字段 */
    async setKey(field, value) {
        if (!SENSITIVE_KEYS.has(field)) {
            console.warn(`[ApiKeyStore] "${field}" 不是凭证字段。`);
            return;
        }
        if (this.getMode() === 'cloud') {
            await this._setCloud(field, value);
        } else {
            this._setLocal(field, value);
        }
    }

    /** 当前存储模式 */
    getMode() {
        return localStorage.getItem(LS_MODE_KEY) || 'local';
    }

    /**
     * 切换存储模式并迁移现有数据。
     * local → cloud：读出明文 → 加密 → 写入 extension_settings → 清除 localStorage 明文
     * cloud → local：解密 → 写入 localStorage → 清除 extension_settings 密文
     * @param {'local'|'cloud'} mode
     */
    async setMode(mode) {
        const current = this.getMode();
        if (current === mode) return;

        if (mode === 'cloud') {
            if (!this._keyReady) {
                await this.generateKeyPair();   // 首次切换自动生成密钥对
            }
            await this._migrateLocalToCloud();
        } else {
            await this._migrateCloudToLocal();
        }

        localStorage.setItem(LS_MODE_KEY, mode);
        console.info(`[ApiKeyStore] 存储模式已切换为 "${mode}"。`);
    }

    /** cloud 模式下密钥对是否已就绪 */
    isCloudReady() {
        return this._keyReady;
    }

    /**
     * 按任意 ID 存储凭证（供 ApiProfileManager 使用，key = `profile_<id>`）。
     * 走与 setKey 相同的加密路由。
     */
    async storeById(id, value) {
        const field = `profile_${id}`;
        if (this.getMode() === 'cloud') {
            await this._setCloud(field, value);
        } else {
            this._setLocal(field, value);
        }
    }

    /**
     * 按任意 ID 读取凭证（供 ApiProfileManager 使用）。
     */
    async retrieveById(id) {
        const field = `profile_${id}`;
        if (this.getMode() === 'cloud') {
            return this._getCloud(field);
        }
        return this._getLocal(field);
    }

    /**
     * 删除指定 ID 的凭证（Profile 删除时调用）。
     */
    deleteById(id) {
        const field = `profile_${id}`;
        localStorage.removeItem(LS_PLAIN_PREFIX + field);
        const settings = extension_settings[extensionName];
        if (settings?.[EXT_ENC_PREFIX + field]) {
            delete settings[EXT_ENC_PREFIX + field];
            saveSettingsDebounced();
        }
    }

    /**
     * 生成新的 RSA 密钥对。
     * 警告：会清除所有已加密的 cloud 模式凭证（旧私钥无法解密）。
     */
    async generateKeyPair() {
        const keyPair = await generateKeyPair();
        const { publicJwk, privateJwk } = await serializeKeyPair(keyPair);

        // 清除旧密文（旧私钥无法解密新密钥对加密的内容）
        this._clearAllCloudCiphers();

        // 私钥存 localStorage，公钥存 extension_settings（公钥不需要保密）
        localStorage.setItem(LS_PRIVATE_KEY, privateJwk);
        const settings = extension_settings[extensionName] || {};
        settings[EXT_PUBKEY] = publicJwk;
        saveSettingsDebounced();

        // 更新运行时缓存
        this._publicKey  = await importPublicKey(publicJwk);
        this._privateKey = await importPrivateKey(privateJwk);
        this._keyReady   = true;

        console.info('[ApiKeyStore] 新密钥对已生成。请重新输入所有 API Key。');
    }

    /**
     * 返回公钥的简短指纹（SHA-256 前 8 字节，Base64），用于 UI 展示。
     * @returns {Promise<string>}
     */
    async getPublicKeyInfo() {
        const jwkStr = extension_settings[extensionName]?.[EXT_PUBKEY];
        if (!jwkStr) return '（未生成）';
        const jwk = JSON.parse(jwkStr);
        const raw = new TextEncoder().encode(jwk.n);    // RSA modulus
        const hash = await crypto.subtle.digest('SHA-256', raw);
        const hex = Array.from(new Uint8Array(hash)).slice(0, 8)
            .map(b => b.toString(16).padStart(2, '0')).join(':');
        return `RSA-2048 · ${hex}`;
    }

    /**
     * 导出可备份的加密摘要（包含公钥 + 所有密文，不含私钥）。
     * 仅供参考，不能用于在新设备上恢复（因为私钥不在其中）。
     * @returns {Object}
     */
    exportEncryptedBackup() {
        const settings = extension_settings[extensionName] || {};
        const backup = { publicKey: settings[EXT_PUBKEY], encrypted: {} };
        for (const field of SENSITIVE_KEYS) {
            const cipher = settings[EXT_ENC_PREFIX + field];
            if (cipher) backup.encrypted[field] = cipher;
        }
        return backup;
    }

    // ── 内部：local 模式 ────────────────────────────────────────────────────

    _getLocal(field) {
        return localStorage.getItem(LS_PLAIN_PREFIX + field) ?? '';
    }

    _setLocal(field, value) {
        if (value !== null && value !== undefined && value !== '') {
            localStorage.setItem(LS_PLAIN_PREFIX + field, value);
        } else {
            localStorage.removeItem(LS_PLAIN_PREFIX + field);
        }
    }

    // ── 内部：cloud 模式 ────────────────────────────────────────────────────

    async _getCloud(field) {
        if (!this._keyReady) {
            console.warn('[ApiKeyStore] cloud 模式密钥未就绪，无法解密。');
            return '';
        }
        const cipher = extension_settings[extensionName]?.[EXT_ENC_PREFIX + field];
        if (!cipher) return '';
        try {
            return await decrypt(this._privateKey, cipher);
        } catch (e) {
            console.error(`[ApiKeyStore] 解密 "${field}" 失败（私钥不匹配？）:`, e);
            return '';
        }
    }

    async _setCloud(field, value) {
        if (!this._keyReady) {
            console.warn('[ApiKeyStore] cloud 模式密钥未就绪，无法加密。');
            return;
        }
        const settings = extension_settings[extensionName] || {};
        if (value !== null && value !== undefined && value !== '') {
            settings[EXT_ENC_PREFIX + field] = await encrypt(this._publicKey, value);
        } else {
            delete settings[EXT_ENC_PREFIX + field];
        }
        saveSettingsDebounced();
    }

    // ── 内部：迁移 ──────────────────────────────────────────────────────────

    async _migrateLocalToCloud() {
        for (const field of SENSITIVE_KEYS) {
            const plain = this._getLocal(field);
            if (plain) {
                await this._setCloud(field, plain);
                localStorage.removeItem(LS_PLAIN_PREFIX + field);
                console.info(`[ApiKeyStore] "${field}" 已加密迁移至云同步。`);
            }
        }
    }

    async _migrateCloudToLocal() {
        for (const field of SENSITIVE_KEYS) {
            const plain = await this._getCloud(field);
            if (plain) {
                this._setLocal(field, plain);
                console.info(`[ApiKeyStore] "${field}" 已解密迁移至本地存储。`);
            }
        }
        this._clearAllCloudCiphers();
    }

    _clearAllCloudCiphers() {
        const settings = extension_settings[extensionName];
        if (!settings) return;
        let changed = false;
        for (const field of SENSITIVE_KEYS) {
            if (settings[EXT_ENC_PREFIX + field]) {
                delete settings[EXT_ENC_PREFIX + field];
                changed = true;
            }
        }
        if (changed) saveSettingsDebounced();
    }

    // ── 内部：密钥加载 ──────────────────────────────────────────────────────

    async _loadKeyPair() {
        const privateJwk = localStorage.getItem(LS_PRIVATE_KEY);
        const publicJwk  = extension_settings[extensionName]?.[EXT_PUBKEY];

        if (!privateJwk || !publicJwk) {
            console.warn('[ApiKeyStore] cloud 模式：本地未找到密钥对，请生成新密钥对。');
            this._keyReady = false;
            return;
        }

        try {
            this._privateKey = await importPrivateKey(privateJwk);
            this._publicKey  = await importPublicKey(publicJwk);
            this._keyReady   = true;
            console.info('[ApiKeyStore] cloud 模式密钥对已加载。');
        } catch (e) {
            console.error('[ApiKeyStore] 密钥对加载失败（数据损坏？）:', e);
            this._keyReady = false;
        }
    }
}

// ── 单例导出 ─────────────────────────────────────────────────────────────────
export const apiKeyStore = new ApiKeyStore();

// ── Bus 注册 ──────────────────────────────────────────────────────────────────
setTimeout(async () => {
    try {
        // 先初始化（cloud 模式下加载密钥）
        await apiKeyStore.init();

        const _ctx = window.Amily2Bus?.register('ApiKeyStore');
        if (!_ctx) {
            console.warn('[ApiKeyStore] Amily2Bus 尚未就绪，注册跳过。');
            return;
        }
        _ctx.expose({
            getKey:               (field)        => apiKeyStore.getKey(field),
            setKey:               (field, value) => apiKeyStore.setKey(field, value),
            getMode:              ()             => apiKeyStore.getMode(),
            setMode:              (mode)         => apiKeyStore.setMode(mode),
            isCloudReady:         ()             => apiKeyStore.isCloudReady(),
            generateKeyPair:      ()             => apiKeyStore.generateKeyPair(),
            getPublicKeyInfo:     ()             => apiKeyStore.getPublicKeyInfo(),
            exportEncryptedBackup: ()            => apiKeyStore.exportEncryptedBackup(),
        });
        _ctx.log('ApiKeyStore', 'info', 'ApiKeyStore 服务已注册到 Bus。');
    } catch (e) {
        console.error('[ApiKeyStore] 初始化失败:', e);
    }
}, 0);
