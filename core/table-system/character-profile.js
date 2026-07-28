import { createTableStateFromProfile, normalizeTableProfile } from './profile.js';
import { isTableDefinitionRegistered, validateTableState } from './module-tables.js';

export const CHARACTER_TABLE_PROFILE_FIELD = 'amily2_table_profile';
export const CHARACTER_PROFILE_UNSET_VALUE = '__@@UNSET@@__';
const MAX_PROFILE_SIZE = 1_000_000;
const MAX_PROFILE_TABLES = 64;
const MAX_PROFILE_COLUMNS = 128;

/**
 * SillyTavern may expose the selected character index as either a number or a
 * decimal string. Keep this conversion deliberately strict so values such as
 * an empty string, a float, a negative index or an exponent can never become a
 * different character index through JavaScript's permissive Number().
 */
export function normalizeCharacterId(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
        return null;
    }
    const characterId = Number(value);
    return Number.isSafeInteger(characterId) ? characterId : null;
}

export function readCurrentCharacterTableProfile(context) {
    const characterId = normalizeCharacterId(context?.characterId);
    if (characterId === null) return null;
    return readCharacterTableProfile(context, characterId);
}

export function readCharacterTableProfile(context, characterId) {
    const normalizedCharacterId = normalizeCharacterId(characterId);
    if (normalizedCharacterId === null) return null;
    const raw = context?.characters?.[normalizedCharacterId]?.data?.extensions?.[CHARACTER_TABLE_PROFILE_FIELD];
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

export async function removeCharacterTableProfile(context, characterId, options = {}) {
    const normalizedCharacterId = normalizeCharacterId(characterId);
    if (normalizedCharacterId === null) {
        throw new Error('Character table profile removal requires a selected character and writeExtensionField().');
    }
    await persistCharacterTableProfileField(
        context,
        normalizedCharacterId,
        CHARACTER_PROFILE_UNSET_VALUE,
        options,
    );
    return true;
}

export function getCurrentCharacterTableProfileStatus(context) {
    const characterId = normalizeCharacterId(context?.characterId);
    if (characterId === null) {
        return Object.freeze({ available: false, characterId: null, profile: null });
    }
    const profile = readCharacterTableProfile(context, characterId);
    return Object.freeze({ available: Boolean(profile), characterId, profile });
}

/**
 * This is intentionally not exposed through AmilyBus. Card writes must remain
 * an explicit user-driven operation in the future table profile UI.
 */
export async function writeCharacterTableProfile(context, characterId, profile, options = {}) {
    const normalizedCharacterId = normalizeCharacterId(characterId);
    if (normalizedCharacterId === null) {
        throw new Error('Character table profile writes require a selected character and writeExtensionField().');
    }
    const normalized = normalizeTableProfile(profile);
    if (!normalized) throw new Error('Invalid Amily2 table profile.');
    if (!isSafeCharacterProfileEnvelope(normalized)
        || hasInvalidPortableTableClaims(normalized)
        || !hasValidPortableTableSchemas(normalized)) {
        throw new Error('角色卡表档案不能包含重复 ID、模块表、运行时行数据或超限结构。');
    }
    await persistCharacterTableProfileField(
        context,
        normalizedCharacterId,
        normalized,
        options,
    );
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

async function persistCharacterTableProfileField(context, characterId, value, options) {
    const hasCharacterList = Array.isArray(context?.characters);
    const character = hasCharacterList ? context.characters[characterId] : null;
    if (hasCharacterList && !character) {
        throw new Error(`Character table profile target ${characterId} does not exist.`);
    }

    const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    const avatar = typeof character?.avatar === 'string' ? character.avatar.trim() : '';
    const canUseVerifiedHostWrite = Boolean(
        character
        && avatar
        && typeof context?.getRequestHeaders === 'function'
        && typeof fetchImpl === 'function',
    );

    if (canUseVerifiedHostWrite) {
        const response = await fetchImpl('/api/characters/merge-attributes', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                avatar,
                data: {
                    extensions: {
                        [CHARACTER_TABLE_PROFILE_FIELD]: value,
                    },
                },
            }),
        });
        if (!response?.ok) {
            throw new Error(
                `Character table profile persistence failed with HTTP ${response?.status ?? 'unknown'}.`,
            );
        }
        synchronizeLocalCharacterProfile(character, value);
        synchronizeActiveCharacterJsonEditor(
            context,
            characterId,
            character.json_data,
        );
        return;
    }

    // Isolated unit-test shims may only expose writeExtensionField().
    // Current SillyTavern contexts take the verified HTTP path above because
    // writeExtensionField() logs a failed response but still resolves void.
    if (!hasCharacterList && typeof context?.writeExtensionField === 'function') {
        await context.writeExtensionField(characterId, CHARACTER_TABLE_PROFILE_FIELD, value);
        return;
    }
    throw new Error(
        'Character table profile persistence requires SillyTavern merge-attributes or writeExtensionField().',
    );
}

function synchronizeLocalCharacterProfile(character, value) {
    const isUnset = value === CHARACTER_PROFILE_UNSET_VALUE;
    if (!character.data || typeof character.data !== 'object' || Array.isArray(character.data)) {
        character.data = {};
    }
    if (!character.data.extensions
        || typeof character.data.extensions !== 'object'
        || Array.isArray(character.data.extensions)) {
        character.data.extensions = {};
    }
    if (isUnset) {
        delete character.data.extensions[CHARACTER_TABLE_PROFILE_FIELD];
    } else {
        character.data.extensions[CHARACTER_TABLE_PROFILE_FIELD] = value;
    }

    if (typeof character.json_data !== 'string' || !character.json_data.trim()) return;
    try {
        const jsonData = JSON.parse(character.json_data);
        if (!jsonData.data || typeof jsonData.data !== 'object' || Array.isArray(jsonData.data)) {
            jsonData.data = {};
        }
        if (!jsonData.data.extensions
            || typeof jsonData.data.extensions !== 'object'
            || Array.isArray(jsonData.data.extensions)) {
            jsonData.data.extensions = {};
        }
        if (isUnset) {
            delete jsonData.data.extensions[CHARACTER_TABLE_PROFILE_FIELD];
        } else {
            jsonData.data.extensions[CHARACTER_TABLE_PROFILE_FIELD] = value;
        }
        character.json_data = JSON.stringify(jsonData);
    } catch (error) {
        console.warn('[TableDatabase] 角色卡已写入，但本地 json_data 无法同步。', error);
    }
}

function synchronizeActiveCharacterJsonEditor(context, characterId, jsonData) {
    if (normalizeCharacterId(context?.characterId) !== characterId
        || typeof jsonData !== 'string'
        || !jsonData.trim()) {
        return;
    }
    const editor = globalThis.document?.getElementById?.('character_json_data');
    if (editor && 'value' in editor) {
        editor.value = jsonData;
    }
}
