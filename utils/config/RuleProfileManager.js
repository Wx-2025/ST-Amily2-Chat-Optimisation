import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../settings.js";

const RULE_PROFILE_KEY = 'ruleProfiles';
const RULE_ASSIGNMENTS_KEY = 'ruleProfileAssignments';

// ── 功能槽定义 ──────────────────────────────────────────────────────────────────
export const RULE_SLOTS = {
    table:             { label: '表格提取规则' },
    historiography:    { label: '史官/总结提取规则' },
    condensation:      { label: '翰林院·浓缩规则' },
    queryPreprocessing:{ label: '翰林院·查询预处理规则' },
};

function sanitizeRuleProfile(profile = {}) {
    const exclusionRules = Array.isArray(profile.exclusionRules)
        ? profile.exclusionRules
            .map(rule => ({
                start: String(rule?.start ?? '').trim(),
                end: String(rule?.end ?? '').trim(),
            }))
            .filter(rule => rule.start)
        : [];

    return {
        id: String(profile.id ?? '').trim(),
        name: String(profile.name ?? '').trim(),
        tagExtractionEnabled: Boolean(profile.tagExtractionEnabled),
        tags: String(profile.tags ?? ''),
        exclusionRules,
    };
}

function cloneRuleProfile(profile = {}) {
    return {
        id: profile.id || '',
        name: profile.name || '',
        tagExtractionEnabled: Boolean(profile.tagExtractionEnabled),
        tags: profile.tags || '',
        exclusionRules: Array.isArray(profile.exclusionRules)
            ? profile.exclusionRules.map(rule => ({
                start: rule.start || '',
                end: rule.end || '',
            }))
            : [],
    };
}

function createRuleProfileId(name = 'rule-profile') {
    const base = String(name || 'rule-profile')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'rule-profile';
    return `${base}-${Date.now().toString(36)}`;
}

function ensureSettingsRoot() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    return extension_settings[extensionName];
}

function ensureProfileMap() {
    const settings = ensureSettingsRoot();
    if (!settings[RULE_PROFILE_KEY] || typeof settings[RULE_PROFILE_KEY] !== 'object' || Array.isArray(settings[RULE_PROFILE_KEY])) {
        settings[RULE_PROFILE_KEY] = {};
    }
    return settings[RULE_PROFILE_KEY];
}

function ensureAssignments() {
    const settings = ensureSettingsRoot();
    if (!settings[RULE_ASSIGNMENTS_KEY] || typeof settings[RULE_ASSIGNMENTS_KEY] !== 'object' || Array.isArray(settings[RULE_ASSIGNMENTS_KEY])) {
        settings[RULE_ASSIGNMENTS_KEY] = {};
    }
    return settings[RULE_ASSIGNMENTS_KEY];
}

function mergeRuleConfig(profile, fallback = {}) {
    const safeFallback = sanitizeRuleProfile({
        id: fallback.id,
        name: fallback.name,
        tagExtractionEnabled: fallback.tagExtractionEnabled,
        tags: fallback.tags,
        exclusionRules: fallback.exclusionRules,
    });

    if (!profile) {
        return safeFallback;
    }

    return {
        id: profile.id,
        name: profile.name,
        tagExtractionEnabled: profile.tagExtractionEnabled,
        tags: profile.tags,
        exclusionRules: cloneRuleProfile(profile).exclusionRules.length > 0
            ? cloneRuleProfile(profile).exclusionRules
            : safeFallback.exclusionRules,
    };
}

function _dispatchChange() {
    const profiles = Object.values(ensureProfileMap())
        .map(p => cloneRuleProfile(p))
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'zh-Hans-CN'));
    const assignments = { ...ensureAssignments() };
    document.dispatchEvent(new CustomEvent('amily2:ruleProfilesChanged', {
        detail: { profiles, assignments },
    }));
}

export class RuleProfileManager {
    listProfiles() {
        const profiles = Object.values(ensureProfileMap())
            .map(profile => cloneRuleProfile(profile))
            .sort((left, right) => {
                const leftName = left.name || left.id;
                const rightName = right.name || right.id;
                return leftName.localeCompare(rightName, 'zh-Hans-CN');
            });
        return profiles;
    }

    getProfile(id) {
        if (!id) return null;
        const profile = ensureProfileMap()[id];
        return profile ? cloneRuleProfile(profile) : null;
    }

    saveProfile(profile) {
        const normalized = sanitizeRuleProfile(profile);
        const profileId = normalized.id || createRuleProfileId(normalized.name);
        const nextProfile = {
            ...normalized,
            id: profileId,
            name: normalized.name || profileId,
        };

        ensureProfileMap()[profileId] = nextProfile;
        saveSettingsDebounced();
        _dispatchChange();
        return cloneRuleProfile(nextProfile);
    }

    deleteProfile(id) {
        if (!id) return false;
        const profiles = ensureProfileMap();
        if (!profiles[id]) return false;
        delete profiles[id];
        saveSettingsDebounced();
        _dispatchChange();
        return true;
    }

    resolveProfile(id, fallback = {}) {
        return mergeRuleConfig(this.getProfile(id), fallback);
    }

    // ── 功能槽分配 ──────────────────────────────────────────────────────────────

    getAssignment(slot) {
        if (!RULE_SLOTS[slot]) return null;
        return ensureAssignments()[slot] || null;
    }

    setAssignment(slot, profileId) {
        if (!RULE_SLOTS[slot]) return false;
        const assignments = ensureAssignments();
        if (profileId) {
            assignments[slot] = profileId;
        } else {
            delete assignments[slot];
        }
        saveSettingsDebounced();
        _dispatchChange();
        return true;
    }

    getAssignedProfile(slot) {
        const id = this.getAssignment(slot);
        if (!id) return null;
        const profile = ensureProfileMap()[id];
        return profile ? cloneRuleProfile(profile) : null;
    }
}

export const ruleProfileManager = new RuleProfileManager();

export function resolveRuleConfig(ruleProfileId, fallback = {}) {
    return ruleProfileManager.resolveProfile(ruleProfileId, fallback);
}

/**
 * 通过功能槽名解析规则配置（推荐方式）
 * 先查 assignments，再回退到旧字段
 */
export function resolveSlotRuleConfig(slot, legacyFallback = {}) {
    const assignedId = ruleProfileManager.getAssignment(slot);
    if (assignedId) {
        const profile = ruleProfileManager.getProfile(assignedId);
        if (profile) return profile;
    }
    // 回退到旧的 resolve 路径
    return sanitizeRuleProfile(legacyFallback);
}

export function resolveCondensationRuleConfig(settings = {}) {
    const condensation = settings.condensation || {};
    return resolveSlotRuleConfig('condensation', {
        ...condensation,
        ruleProfileId: condensation.ruleProfileId,
    });
}

export function resolveQueryPreprocessingRuleConfig(settings = {}) {
    const queryPreprocessing = settings.queryPreprocessing || {};
    return resolveSlotRuleConfig('queryPreprocessing', {
        ...queryPreprocessing,
        ruleProfileId: queryPreprocessing.ruleProfileId,
    });
}

export function resolveTableRuleConfig(settings = {}) {
    return resolveSlotRuleConfig('table', {
        id: settings.table_rule_profile_id,
        tagExtractionEnabled: Boolean(settings.table_tags_to_extract),
        tags: settings.table_tags_to_extract || '',
        exclusionRules: settings.table_exclusion_rules || [],
    });
}

export function resolveHistoriographyRuleConfig(settings = {}) {
    return resolveSlotRuleConfig('historiography', {
        id: settings.historiographyRuleProfileId,
        tagExtractionEnabled: settings.historiographyTagExtractionEnabled ?? false,
        tags: settings.historiographyTags || '',
        exclusionRules: settings.historiographyExclusionRules || [],
    });
}

// ── 一次性迁移：旧分散 profileId 字段 → 统一 assignments ─────────────────────
;(() => {
    const settings = ensureSettingsRoot();
    const assignments = ensureAssignments();
    let changed = false;

    // table: table_rule_profile_id → assignments.table
    if (settings.table_rule_profile_id && !assignments.table) {
        assignments.table = settings.table_rule_profile_id;
        changed = true;
    }

    // historiography: historiographyRuleProfileId → assignments.historiography
    if (settings.historiographyRuleProfileId && !assignments.historiography) {
        assignments.historiography = settings.historiographyRuleProfileId;
        changed = true;
    }

    // condensation: condensation.ruleProfileId → assignments.condensation
    const condensation = settings.condensation || {};
    if (condensation.ruleProfileId && !assignments.condensation) {
        assignments.condensation = condensation.ruleProfileId;
        changed = true;
    }

    // queryPreprocessing: queryPreprocessing.ruleProfileId → assignments.queryPreprocessing
    const queryPreprocessing = settings.queryPreprocessing || {};
    if (queryPreprocessing.ruleProfileId && !assignments.queryPreprocessing) {
        assignments.queryPreprocessing = queryPreprocessing.ruleProfileId;
        changed = true;
    }

    if (changed) {
        saveSettingsDebounced();
        console.log('[RuleProfiles] 已迁移旧规则配置分配到统一 assignments。', assignments);
    }
})();

setTimeout(() => {
    try {
        const ctx = window.Amily2Bus?.register('RuleProfiles');
        if (!ctx) {
            console.warn('[RuleProfiles] Amily2Bus 尚未就绪，注册跳过。');
            return;
        }
        ctx.expose({
            listProfiles: () => ruleProfileManager.listProfiles(),
            getProfile: (id) => ruleProfileManager.getProfile(id),
            saveProfile: (profile) => ruleProfileManager.saveProfile(profile),
            deleteProfile: (id) => ruleProfileManager.deleteProfile(id),
            resolveProfile: (id, fallback) => ruleProfileManager.resolveProfile(id, fallback),
            getAssignment: (slot) => ruleProfileManager.getAssignment(slot),
            setAssignment: (slot, id) => ruleProfileManager.setAssignment(slot, id),
            getAssignedProfile: (slot) => ruleProfileManager.getAssignedProfile(slot),
            RULE_SLOTS,
        });
        ctx.log('RuleProfiles', 'info', 'RuleProfiles 服务已注册到 Bus。');
    } catch (error) {
        console.error('[RuleProfiles] Bus 注册失败:', error);
    }
}, 0);
