import { normalizeTableProfile } from './profile.js';

export const CHARACTER_TABLE_PROFILE_FIELD = 'amily2_table_profile';

export function readCurrentCharacterTableProfile(context) {
    const characterId = context?.characterId;
    if (!Number.isInteger(characterId)) return null;
    return readCharacterTableProfile(context, characterId);
}

export function readCharacterTableProfile(context, characterId) {
    const raw = context?.characters?.[characterId]?.data?.extensions?.[CHARACTER_TABLE_PROFILE_FIELD];
    return normalizeTableProfile(raw);
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
    await context.writeExtensionField(characterId, CHARACTER_TABLE_PROFILE_FIELD, normalized);
    return normalized;
}
