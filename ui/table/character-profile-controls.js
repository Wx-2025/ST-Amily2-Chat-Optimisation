import { normalizeCharacterId } from '../../core/table-system/character-profile.js';
import {
    captureChatScope,
    chatScopesMatch,
} from '../../core/table-system/infra/chat-scope.js';

export const IMPORT_SYNC_CHARACTER_PROFILE_SETTING = 'table_import_sync_character_profile';

/**
 * Restore and persist the explicit opt-in for writing an imported table
 * profile back to the current character card.
 */
export function bindImportSyncCharacterProfileSetting(
    checkbox,
    getSettings,
    saveSettings,
) {
    if (!checkbox) return () => {};
    checkbox.checked = getSettings?.()?.[IMPORT_SYNC_CHARACTER_PROFILE_SETTING] === true;

    const persist = () => {
        const settings = getSettings?.();
        if (!settings || typeof settings !== 'object') return;
        settings[IMPORT_SYNC_CHARACTER_PROFILE_SETTING] = checkbox.checked === true;
        saveSettings?.();
    };
    checkbox.addEventListener('change', persist);
    return () => checkbox.removeEventListener('change', persist);
}

/**
 * Capture both the normalized index and the card identity before opening a
 * file picker. Import completion may happen much later, after the user has
 * switched cards.
 */
export function captureCharacterProfileTarget(context) {
    const characterId = normalizeCharacterId(context?.characterId);
    const character = characterId === null ? null : context?.characters?.[characterId];
    if (!character) return null;
    return Object.freeze({
        characterId,
        character,
        identity: readCharacterIdentity(character),
        chatScope: captureChatScope(context),
    });
}

export function isSameCharacterProfileTarget(context, target) {
    if (!target) return false;
    const characterId = normalizeCharacterId(context?.characterId);
    if (characterId === null || characterId !== target.characterId) return false;
    const character = context?.characters?.[characterId];
    if (!character) return false;
    const identity = readCharacterIdentity(character);
    const characterMatches = character === target.character
        || Boolean(identity
            && target.identity
            && identity === target.identity);
    if (!characterMatches) return false;
    return characterProfileChatScopesMatch(
        target.chatScope,
        captureChatScope(context),
    );
}

function readCharacterIdentity(character) {
    const avatar = character?.avatar ?? character?.data?.avatar;
    return typeof avatar === 'string' && avatar.length > 0 ? `avatar:${avatar}` : null;
}

function characterProfileChatScopesMatch(expected, actual) {
    if (expected?.chatId || actual?.chatId) {
        return chatScopesMatch(expected, actual);
    }
    return expected?.chatId === actual?.chatId
        && expected?.epoch === actual?.epoch
        && expected?.chatRef === actual?.chatRef
        && expected?.metadataRef === actual?.metadataRef;
}
