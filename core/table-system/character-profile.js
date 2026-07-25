import { createTableStateFromProfile, normalizeTableProfile } from './profile.js';
import { isTableDefinitionRegistered, validateTableState } from './module-tables.js';

export const CHARACTER_TABLE_PROFILE_FIELD = 'amily2_table_profile';
const MAX_PROFILE_SIZE = 1_000_000;
const MAX_PROFILE_TABLES = 64;
const MAX_PROFILE_COLUMNS = 128;

export function readCurrentCharacterTableProfile(context) {
    const characterId = context?.characterId;
    if (!Number.isInteger(characterId)) return null;
    return readCharacterTableProfile(context, characterId);
}

export function readCharacterTableProfile(context, characterId) {
    const raw = context?.characters?.[characterId]?.data?.extensions?.[CHARACTER_TABLE_PROFILE_FIELD];
    if (raw === undefined || raw === null) return null;
    if (!isSafeCharacterProfileEnvelope(raw)) {
        console.warn('[TableDatabase] 已拒绝不安全或超限的角色卡表档案。');
        return null;
    }
    const profile = normalizeTableProfile(raw);
    if (!profile) return null;
    if (hasInvalidPortableTableClaims(profile) || !hasValidPortableTableSchemas(profile)) {
        console.warn('[TableDatabase] 角色卡表档案含重复表 ID、模块 owner 或已注册模块表。');
        return null;
    }
    return profile;
}

export async function removeCharacterTableProfile(context, characterId) {
    if (!Number.isInteger(characterId) || typeof context?.writeExtensionField !== 'function') {
        throw new Error('Character table profile removal requires a selected character and writeExtensionField().');
    }
    await context.writeExtensionField(characterId, CHARACTER_TABLE_PROFILE_FIELD, null);
    return true;
}

export function getCurrentCharacterTableProfileStatus(context) {
    const characterId = context?.characterId;
    if (!Number.isInteger(characterId)) {
        return Object.freeze({ available: false, characterId: null, profile: null });
    }
    const profile = readCharacterTableProfile(context, characterId);
    return Object.freeze({ available: Boolean(profile), characterId, profile });
}

/**
 * This is intentionally not exposed through AmilyBus. Card writes must remain
 * an explicit user-driven operation in the future table profile UI.
 */
export async function writeCharacterTableProfile(context, characterId, profile) {
    if (!Number.isInteger(characterId) || typeof context?.writeExtensionField !== 'function') {
        throw new Error('Character table profile writes require a selected character and writeExtensionField().');
    }
    const normalized = normalizeTableProfile(profile);
    if (!normalized) throw new Error('Invalid Amily2 table profile.');
    if (!isSafeCharacterProfileEnvelope(normalized)
        || hasInvalidPortableTableClaims(normalized)
        || !hasValidPortableTableSchemas(normalized)) {
        throw new Error('角色卡表档案不能包含重复 ID、模块表、运行时行数据或超限结构。');
    }
    await context.writeExtensionField(characterId, CHARACTER_TABLE_PROFILE_FIELD, normalized);
    return normalized;
}

export function isSafeCharacterProfileEnvelope(profile) {
    if (!profile || typeof profile !== 'object' || !Array.isArray(profile.tables)) return false;
    if (profile.tables.length > MAX_PROFILE_TABLES) return false;
    try {
        if (JSON.stringify(profile).length > MAX_PROFILE_SIZE) return false;
    } catch {
        return false;
    }
    return profile.tables.every(table => {
        if (!table || typeof table !== 'object') return false;
        if (Array.isArray(table.rows) && table.rows.length > 0) return false;
        if (!Array.isArray(table.headers) || table.headers.length > MAX_PROFILE_COLUMNS) return false;
        if (table.headers.some(header => typeof header !== 'string' || header.length > 512)) return false;
        return ['note', 'rule_add', 'rule_delete', 'rule_update'].every(key => (
            table[key] === undefined || (typeof table[key] === 'string' && table[key].length <= 100_000)
        ));
    });
}

function hasInvalidPortableTableClaims(profile) {
    const tableIds = new Set();
    return profile.tables.some(table => {
        if (tableIds.has(table.id)) return true;
        tableIds.add(table.id);
        return table.owner !== 'user' || isTableDefinitionRegistered(table.id);
    });
}

function hasValidPortableTableSchemas(profile) {
    try {
        validateTableState(createTableStateFromProfile(profile));
        return true;
    } catch (error) {
        console.warn('[TableDatabase] 角色卡表档案 schema 校验失败。', error);
        return false;
    }
}
