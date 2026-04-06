/**
 * ApiProfileManager — API 连接配置组管理
 *
 * Profile 是一组完整的 API 连接参数，按模型类型分为三类：
 *   chat      — 对话/补全模型（主 API、剧情优化、各子系统等）
 *   embedding — 向量嵌入模型（RAG 向量化）
 *   rerank    — 重排序模型（RAG 精排）
 *
 * 存储分离：
 *   Profile 元数据（name、type、provider、url、model、params）→ extension_settings.amily2_profiles
 *   API Key                                                    → ApiKeyStore（local 或 cloud 加密）
 *
 * 功能分配（assignments）：
 *   记录每个系统功能当前使用哪个 Profile ID，存于 extension_settings.amily2_profile_assignments
 *   选单会按功能对应的 Profile 类型进行过滤，防止类型错配。
 *
 * Bus 注册名：'ApiProfiles'
 *
 * 公开接口：
 *   getProfiles(type?)          — 获取全部或指定类型的 Profile 列表
 *   getProfile(id)              — 获取单个 Profile 元数据
 *   createProfile(data)         — 新建 Profile（返回新 ID）
 *   updateProfile(id, data)     — 更新 Profile 元数据
 *   deleteProfile(id)           — 删除 Profile（含清理 Key）
 *   getKey(id)                  — 读取 Profile 的 API Key（异步，自动解密）
 *   setKey(id, value)           — 写入 Profile 的 API Key（异步，自动加密）
 *   getAssignment(slot)         — 获取功能槽当前分配的 Profile ID
 *   setAssignment(slot, id)     — 设置功能槽的 Profile
 *   getAssignedProfile(slot)    — 获取功能槽完整 Profile（含解密 Key）
 *   SLOTS                       — 可用功能槽清单（静态）
 *   PROFILE_TYPES               — Profile 类型定义（静态）
 */

import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../settings.js";
import { apiKeyStore } from "./api-key-store/ApiKeyStore.js";

// ── 类型与功能槽定义 ──────────────────────────────────────────────────────────

/** Profile 类型定义 */
export const PROFILE_TYPES = {
    chat: {
        label: '对话模型',
        icon: 'fa-comments',
        description: '用于文本生成、对话补全的模型（Chat / Completion）',
        params: ['maxTokens', 'temperature'],
    },
    embedding: {
        label: '向量嵌入',
        icon: 'fa-project-diagram',
        description: '将文本转换为向量的模型，用于 RAG 语义检索',
        params: ['dimensions', 'encodingFormat'],
    },
    rerank: {
        label: '重排序',
        icon: 'fa-sort-amount-down',
        description: '对检索结果重新打分排序的模型，用于 RAG 精排',
        params: ['topN', 'returnDocuments'],
    },
};

/** 功能槽：每个系统功能需要的 Profile 类型 */
export const SLOTS = {
    // Chat 槽
    main:          { label: '主 API（正文优化）',   type: 'chat' },
    plotOpt:       { label: '剧情优化 / JQYH',      type: 'chat' },
    plotOptConc:   { label: '剧情优化（并发）',      type: 'chat' },
    ngms:          { label: 'NGMS 历史记录',         type: 'chat' },
    nccs:          { label: 'NCCS 并发',             type: 'chat' },
    cwb:           { label: '角色世界书',              type: 'chat' },
    autoCharCard:  { label: '一键生卡',              type: 'chat' },
    // Embedding 槽
    ragEmbed:      { label: 'RAG 向量化',            type: 'embedding' },
    // Rerank 槽
    ragRerank:     { label: 'RAG 重排序',            type: 'rerank' },
};

// extension_settings 存储 key
const EXT_PROFILES    = 'amily2_profiles';
const EXT_ASSIGNMENTS = 'amily2_profile_assignments';

// ── ApiProfileManager ─────────────────────────────────────────────────────────

class ApiProfileManager {

    // ── 内部工具 ────────────────────────────────────────────────────────────

    _settings() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        return extension_settings[extensionName];
    }

    _profiles() {
        const s = this._settings();
        if (!Array.isArray(s[EXT_PROFILES])) s[EXT_PROFILES] = [];
        return s[EXT_PROFILES];
    }

    _assignments() {
        const s = this._settings();
        if (!s[EXT_ASSIGNMENTS] || typeof s[EXT_ASSIGNMENTS] !== 'object') {
            s[EXT_ASSIGNMENTS] = {};
        }
        return s[EXT_ASSIGNMENTS];
    }

    _save() {
        saveSettingsDebounced();
    }

    _newId() {
        return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }

    // ── Profile CRUD ────────────────────────────────────────────────────────

    /**
     * 获取 Profile 列表。
     * @param {'chat'|'embedding'|'rerank'} [type] 不传则返回全部
     * @returns {Array}
     */
    getProfiles(type) {
        const all = this._profiles();
        return type ? all.filter(p => p.type === type) : [...all];
    }

    /**
     * 获取单个 Profile 元数据（不含 Key）。
     */
    getProfile(id) {
        return this._profiles().find(p => p.id === id) ?? null;
    }

    /**
     * 新建 Profile。
     * @param {Object} data  Profile 数据（不含 id、apiKey）
     * @returns {string} 新 Profile 的 id
     */
    createProfile(data) {
        const id = this._newId();
        const profile = this._buildProfile(id, data);
        this._profiles().push(profile);
        this._save();
        return id;
    }

    /**
     * 更新 Profile 元数据（不更新 Key，Key 用 setKey()）。
     */
    updateProfile(id, data) {
        const list = this._profiles();
        const idx  = list.findIndex(p => p.id === id);
        if (idx === -1) return false;
        list[idx] = this._buildProfile(id, { ...list[idx], ...data });
        this._save();
        return true;
    }

    /**
     * 删除 Profile（同时清理存储的 Key 和功能槽引用）。
     */
    deleteProfile(id) {
        const s   = this._settings();
        s[EXT_PROFILES] = this._profiles().filter(p => p.id !== id);

        // 清理功能槽引用
        const asgn = this._assignments();
        for (const slot in asgn) {
            if (asgn[slot] === id) delete asgn[slot];
        }

        // 清理 Key
        apiKeyStore.deleteById(id);

        this._save();
    }

    // ── Key 操作 ────────────────────────────────────────────────────────────

    /** 读取 Profile 的 API Key（异步，自动解密） */
    async getKey(id) {
        return apiKeyStore.retrieveById(id);
    }

    /** 写入 Profile 的 API Key（异步，自动加密） */
    async setKey(id, value) {
        return apiKeyStore.storeById(id, value);
    }

    // ── 功能槽分配 ──────────────────────────────────────────────────────────

    /** 获取功能槽当前分配的 Profile ID（null = 未分配） */
    getAssignment(slot) {
        return this._assignments()[slot] ?? null;
    }

    /**
     * 设置功能槽的 Profile。
     * 会校验 Profile 类型是否与槽类型匹配。
     */
    setAssignment(slot, profileId) {
        if (!SLOTS[slot]) {
            console.warn(`[ApiProfiles] 未知功能槽 "${slot}"。`);
            return false;
        }
        if (profileId !== null) {
            const profile = this.getProfile(profileId);
            if (!profile) {
                console.warn(`[ApiProfiles] Profile "${profileId}" 不存在。`);
                return false;
            }
            if (profile.type !== SLOTS[slot].type) {
                console.warn(`[ApiProfiles] 类型不匹配：槽 "${slot}" 需要 ${SLOTS[slot].type}，Profile 类型为 ${profile.type}。`);
                return false;
            }
        }
        this._assignments()[slot] = profileId;
        this._save();
        return true;
    }

    /**
     * 获取功能槽完整 Profile，包含解密后的 API Key。
     * @returns {Promise<Object|null>}
     */
    async getAssignedProfile(slot) {
        const id = this.getAssignment(slot);
        if (!id) return null;
        const profile = this.getProfile(id);
        if (!profile) return null;
        const apiKey = await this.getKey(id);
        return { ...profile, apiKey };
    }

    // ── 内部：Profile 对象构造 ──────────────────────────────────────────────

    _buildProfile(id, data) {
        const type = data.type || 'chat';
        const base = {
            id,
            name:     data.name     || '未命名配置',
            type,
            provider: data.provider || 'openai',
            apiUrl:   data.apiUrl   || '',
            model:    data.model    || '',
        };

        if (type === 'chat') {
            return {
                ...base,
                maxTokens:   data.maxTokens   ?? 65500,
                temperature: data.temperature ?? 1.0,
            };
        }
        if (type === 'embedding') {
            return {
                ...base,
                dimensions:     data.dimensions     ?? null,
                encodingFormat: data.encodingFormat ?? 'float',
            };
        }
        if (type === 'rerank') {
            return {
                ...base,
                topN:            data.topN            ?? 5,
                returnDocuments: data.returnDocuments ?? false,
            };
        }
        return base;
    }
}

// ── 单例导出 ─────────────────────────────────────────────────────────────────
export const apiProfileManager = new ApiProfileManager();

// ── 历史槽位迁移 ──────────────────────────────────────────────────────────────
// v2.0.1: jqyh 槽合并入 plotOpt，superMemory 槽已移除（无 API 调用）
;(() => {
    try {
        const s = extension_settings[extensionName];
        if (!s) return;
        const assignments = s[EXT_ASSIGNMENTS];
        if (!assignments) return;
        if (assignments['jqyh'] && !assignments['plotOpt']) {
            assignments['plotOpt'] = assignments['jqyh'];
            console.info('[ApiProfiles] 迁移: jqyh 分配已合并至 plotOpt:', assignments['plotOpt']);
        }
        delete assignments['jqyh'];
        delete assignments['superMemory'];
        saveSettingsDebounced();
    } catch (e) {
        console.warn('[ApiProfiles] 历史槽位迁移失败:', e);
    }
})();

// ── Bus 注册 ──────────────────────────────────────────────────────────────────
setTimeout(() => {
    try {
        const _ctx = window.Amily2Bus?.register('ApiProfiles');
        if (!_ctx) {
            console.warn('[ApiProfiles] Amily2Bus 尚未就绪，注册跳过。');
            return;
        }
        _ctx.expose({
            getProfiles:         (type)       => apiProfileManager.getProfiles(type),
            getProfile:          (id)         => apiProfileManager.getProfile(id),
            createProfile:       (data)       => apiProfileManager.createProfile(data),
            updateProfile:       (id, data)   => apiProfileManager.updateProfile(id, data),
            deleteProfile:       (id)         => apiProfileManager.deleteProfile(id),
            getKey:              (id)         => apiProfileManager.getKey(id),
            setKey:              (id, val)    => apiProfileManager.setKey(id, val),
            getAssignment:       (slot)       => apiProfileManager.getAssignment(slot),
            setAssignment:       (slot, id)   => apiProfileManager.setAssignment(slot, id),
            getAssignedProfile:  (slot)       => apiProfileManager.getAssignedProfile(slot),
            SLOTS:               SLOTS,
            PROFILE_TYPES:       PROFILE_TYPES,
        });
        _ctx.log('ApiProfiles', 'info', 'ApiProfiles 服务已注册到 Bus。');
    } catch (e) {
        console.error('[ApiProfiles] Bus 注册失败:', e);
    }
}, 0);
