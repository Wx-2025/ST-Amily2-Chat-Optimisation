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
import { configManager } from "./ConfigManager.js";

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
    ngms:          { label: 'NGMS（总结）',            type: 'chat' },
    nccs:          { label: 'NCCS（填表）',            type: 'chat' },
    cwb:           { label: '角色世界书',              type: 'chat' },
    autoCharCard:  { label: '一键生卡',              type: 'chat' },
    sybd:          { label: '术语表填写',             type: 'chat' },
    tableFilling:  { label: '表格填表 / 重整',        type: 'chat' },
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
                fakeStream:  data.fakeStream  ?? false,
                // 自定义参数：透传到 LLM 请求 body 的额外 key/value（top_p、frequency_penalty 等）
                // 由 utils/api-vendor.js 提供 vendor 标准参数提示，但不强校验。
                customParams: (typeof data.customParams === 'object' && data.customParams !== null)
                    ? data.customParams
                    : {},
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

// ── Profile.provider 迁移 ────────────────────────────────────────────────────
// Phase B 改造：旧 'openai' 是"OpenAI 兼容总称"，现在拆为 6 个具体 vendor + 'custom_oai'。
// 按 URL substring 推断真实 vendor；推断不出来 → 改成 'custom_oai'；URL 为空 → 保持 'openai'。
// 仅迁移 provider==='openai' 的旧 profile，新值（anthropic/openrouter/deepseek/xai/custom_oai/google/...）一概不动。
function _detectVendorFromUrlSync(url) {
    if (!url) return null;
    const lower = String(url).toLowerCase();
    if (lower.includes('anthropic.com'))                              return 'anthropic';
    if (lower.includes('openrouter.ai'))                              return 'openrouter';
    if (lower.includes('googleapis.com') || lower.includes('aistudio.google.com')) return 'google';
    if (lower.includes('deepseek.com'))                               return 'deepseek';
    if (lower.includes('x.ai') || lower.includes('xai.com'))          return 'xai';
    if (lower.includes('openai.com'))                                 return 'openai';
    return null;
}

;(() => {
    try {
        const s = extension_settings[extensionName];
        if (!s || !Array.isArray(s[EXT_PROFILES])) return;
        let migratedCount = 0;
        for (const profile of s[EXT_PROFILES]) {
            if (profile?.provider !== 'openai') continue; // 已是新值或非 chat profile
            const detected = _detectVendorFromUrlSync(profile.apiUrl);
            if (detected && detected !== 'openai') {
                profile.provider = detected;
                migratedCount++;
            } else if (profile.apiUrl && !detected) {
                // URL 填了但不匹配任何已知厂商 → 标记为 custom_oai
                profile.provider = 'custom_oai';
                migratedCount++;
            }
            // URL 为空（新建中）或确实是 openai.com → 保持 'openai'
        }
        if (migratedCount > 0) {
            console.info(`[ApiProfiles] 迁移: ${migratedCount} 个 profile 的 provider 字段已按 URL 重分类。`);
            saveSettingsDebounced();
        }
    } catch (e) {
        console.warn('[ApiProfiles] provider 迁移失败:', e);
    }
})();

// ── Legacy → Profile 自动迁移（v2.1.x）─────────────────────────────────────
// 对每个 chat slot：若没分配 profile 且旧字段（apiUrl + model 都填了）存在，
// 自动建一个 profile + 迁移 API Key + 分配给该 slot。
// 幂等：通过 _legacyProfileMigrationDone 标记，只在首次 ship 后跑一次。
// 旧字段保留不动，由"清除旧配置残留"按钮显式清理。

/**
 * 每个 slot 的 legacy 字段映射。jqyh 已合并到 plotOpt 不单独迁移。
 * cwb / autoCharCard / ragEmbed / ragRerank 字段结构差异较大，留作后续。
 */
const LEGACY_PROFILE_MIGRATION_MAP = [
    {
        slot: 'main',
        urlKey: 'apiUrl',
        modelKey: 'model',
        keyName: 'apiKey',
        maxTokensKey: 'maxTokens',
        temperatureKey: 'temperature',
        name: '主面板 旧配置',
    },
    {
        slot: 'plotOpt',
        urlKey: 'plotOpt_apiUrl',
        modelKey: 'plotOpt_model',
        keyName: 'plotOpt_apiKey',
        maxTokensKey: 'plotOpt_max_tokens',
        temperatureKey: 'plotOpt_temperature',
        name: '剧情优化 旧配置',
    },
    {
        slot: 'plotOptConc',
        urlKey: 'plotOpt_concurrentApiUrl',
        modelKey: 'plotOpt_concurrentModel',
        keyName: 'plotOpt_concurrentApiKey',
        maxTokensKey: 'plotOpt_concurrentMaxTokens',
        temperatureKey: null, // 并发优化无独立 temperature 旧字段
        name: '并发剧情优化 旧配置',
    },
    {
        slot: 'ngms',
        urlKey: 'ngmsApiUrl',
        modelKey: 'ngmsModel',
        keyName: 'ngmsApiKey',
        maxTokensKey: 'ngmsMaxTokens',
        temperatureKey: 'ngmsTemperature',
        name: 'NGMS 旧配置',
    },
    {
        slot: 'nccs',
        urlKey: 'nccsApiUrl',
        modelKey: 'nccsModel',
        keyName: 'nccsApiKey',
        maxTokensKey: 'nccsMaxTokens',
        temperatureKey: 'nccsTemperature',
        name: 'NCCS 旧配置',
    },
    {
        slot: 'sybd',
        urlKey: 'sybdApiUrl',
        modelKey: 'sybdModel',
        keyName: 'sybdApiKey',
        maxTokensKey: 'sybdMaxTokens',
        temperatureKey: 'sybdTemperature',
        name: 'SYBD 旧配置',
    },
];

;(async () => {
    try {
        const s = extension_settings[extensionName];
        if (!s) return;
        if (s._legacyProfileMigrationDone) return; // 幂等

        const migrated = [];
        for (const m of LEGACY_PROFILE_MIGRATION_MAP) {
            // 已分配 profile 的 slot 跳过
            if (apiProfileManager.getAssignment(m.slot)) continue;

            const url   = String(s[m.urlKey]   ?? '').trim();
            const model = String(s[m.modelKey] ?? '').trim();
            if (!url || !model) continue; // 旧配置不完整，跳过

            const provider = _detectVendorFromUrlSync(url) || 'custom_oai';

            const profileId = apiProfileManager.createProfile({
                type: 'chat',
                name: m.name,
                provider,
                apiUrl: url,
                model,
                maxTokens:   s[m.maxTokensKey]      ?? undefined,
                temperature: m.temperatureKey ? s[m.temperatureKey] : undefined,
            });

            // 旧 API Key 从 configManager（localStorage）读出，写入 ApiKeyStore
            try {
                const legacyKey = configManager.get(m.keyName);
                if (legacyKey) await apiProfileManager.setKey(profileId, legacyKey);
            } catch (keyErr) {
                console.warn(`[ApiProfiles] ${m.slot} Key 迁移失败:`, keyErr);
            }

            apiProfileManager.setAssignment(m.slot, profileId);
            migrated.push(`${m.slot} → ${profileId}`);
        }

        // 新引入的 slot（无 legacy 字段可迁移）默认借用其他 slot 的 profile，
        // 让升级用户的功能不至于因为没主动分配而中断。用户可以随后改成专属 profile。
        const SLOT_INHERITANCE = {
            tableFilling: 'main',  // 表格填表历史上默认走主 API，升级后默认沿用 main 的 profile
        };
        const linked = [];
        for (const [newSlot, sourceSlot] of Object.entries(SLOT_INHERITANCE)) {
            if (apiProfileManager.getAssignment(newSlot)) continue;
            const sourceId = apiProfileManager.getAssignment(sourceSlot);
            if (sourceId) {
                apiProfileManager.setAssignment(newSlot, sourceId);
                linked.push(`${newSlot} ← ${sourceSlot} (${sourceId})`);
            }
        }

        s._legacyProfileMigrationDone = true;
        saveSettingsDebounced();

        if (migrated.length > 0 || linked.length > 0) {
            if (migrated.length > 0) {
                console.info(`[ApiProfiles] 自动迁移 ${migrated.length} 个旧配置 → profile:`, migrated);
            }
            if (linked.length > 0) {
                console.info(`[ApiProfiles] 自动 link ${linked.length} 个新 slot 借用现有 profile:`, linked);
            }
            // 延迟提示，等 toastr 就绪
            setTimeout(() => {
                if (typeof toastr !== 'undefined' && migrated.length > 0) {
                    toastr.success(
                        `已自动迁移 ${migrated.length} 个旧 API 配置到新连接配置${linked.length > 0 ? `（含 ${linked.length} 个新槽位借用）` : ''}。请检查"API 连接配置"面板，确认无误后可点"清除旧配置残留"。`,
                        'Amily2 配置迁移',
                        { timeOut: 8000 }
                    );
                }
            }, 2000);
        }
    } catch (e) {
        console.warn('[ApiProfiles] Legacy → profile 自动迁移失败:', e);
    }
})();

/**
 * 清除旧配置残留 —— 用户在 UI 点击按钮时调用。
 *
 * 行为：
 *   1. 校验所有有 legacy 字段的 slot 都已分配 profile（防止误删导致功能没配置）
 *   2. 删除 extension_settings 里的 legacy URL / model / maxTokens / temperature / apiMode / tavernProfile / fakeStream 字段
 *   3. 删除 configManager（localStorage）里的 legacy API Key
 *   4. 不删 _legacyProfileMigrationDone 标记（避免再次运行迁移）
 *
 * @returns {{ ok: boolean, error?: string, clearedFields: number, clearedKeys: number }}
 */
export function clearLegacyConfig() {
    const s = extension_settings[extensionName];
    if (!s) return { ok: false, error: 'extension_settings 不存在', clearedFields: 0, clearedKeys: 0 };

    // 前置校验：每个有 legacy 数据的 slot 必须已分配 profile
    for (const m of LEGACY_PROFILE_MIGRATION_MAP) {
        const url   = String(s[m.urlKey]   ?? '').trim();
        const model = String(s[m.modelKey] ?? '').trim();
        const hasLegacy = url || model;
        if (!hasLegacy) continue;
        if (!apiProfileManager.getAssignment(m.slot)) {
            return {
                ok: false,
                error: `槽位 "${m.slot}" 仍有旧配置但未分配 profile，清除会导致该模块不可用。请先在 API 连接配置面板为它分配 profile。`,
                clearedFields: 0,
                clearedKeys: 0,
            };
        }
    }

    // 全套 legacy 字段（含 maxTokens / temperature / apiMode / tavernProfile / fakeStream / enabled 等）
    const ALL_LEGACY_FIELDS = {
        main:        ['apiUrl', 'model', 'maxTokens', 'temperature', 'apiProvider', 'tavernProfile'],
        plotOpt:     ['plotOpt_apiUrl', 'plotOpt_model', 'plotOpt_apiMode', 'plotOpt_tavernProfile', 'plotOpt_max_tokens', 'plotOpt_temperature', 'plotOpt_top_p', 'plotOpt_presence_penalty', 'plotOpt_frequency_penalty'],
        plotOptConc: ['plotOpt_concurrentApiUrl', 'plotOpt_concurrentModel', 'plotOpt_concurrentApiProvider', 'plotOpt_concurrentMaxTokens'],
        ngms:        ['ngmsApiUrl', 'ngmsModel', 'ngmsApiMode', 'ngmsTavernProfile', 'ngmsMaxTokens', 'ngmsTemperature', 'ngmsFakeStreamEnabled'],
        nccs:        ['nccsApiUrl', 'nccsModel', 'nccsApiMode', 'nccsTavernProfile', 'nccsMaxTokens', 'nccsTemperature', 'nccsFakeStreamEnabled'],
        sybd:        ['sybdApiUrl', 'sybdModel', 'sybdApiMode', 'sybdTavernProfile', 'sybdMaxTokens', 'sybdTemperature'],
        // jqyh 字段也清掉（已合并到 plotOpt 但残留可能还在）
        jqyh:        ['jqyhApiUrl', 'jqyhModel', 'jqyhApiMode', 'jqyhTavernProfile', 'jqyhMaxTokens', 'jqyhTemperature', 'jqyhEnabled'],
    };

    const LEGACY_KEY_NAMES = {
        main:        'apiKey',
        plotOpt:     'plotOpt_apiKey',
        plotOptConc: 'plotOpt_concurrentApiKey',
        ngms:        'ngmsApiKey',
        nccs:        'nccsApiKey',
        sybd:        'sybdApiKey',
        jqyh:        'jqyhApiKey',
    };

    let clearedFields = 0;
    let clearedKeys = 0;

    for (const slot of Object.keys(ALL_LEGACY_FIELDS)) {
        for (const field of ALL_LEGACY_FIELDS[slot]) {
            if (field in s) {
                delete s[field];
                clearedFields++;
            }
        }
        const keyName = LEGACY_KEY_NAMES[slot];
        if (keyName) {
            try {
                if (configManager.get(keyName)) {
                    // configManager.set(key, '') 对敏感字段会同时清除 localStorage + extension_settings
                    configManager.set(keyName, '');
                    clearedKeys++;
                }
            } catch (e) {
                console.warn(`[ApiProfiles] 清除旧 Key ${keyName} 失败:`, e);
            }
        }
    }

    saveSettingsDebounced();
    console.info(`[ApiProfiles] 清除旧配置残留：${clearedFields} 个字段 + ${clearedKeys} 个 Key。`);
    return { ok: true, clearedFields, clearedKeys };
}

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
