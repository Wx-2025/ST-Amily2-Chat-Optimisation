import { characters, saveCharacterDebounced, this_chid, getCharacters, getRequestHeaders } from "/script.js";
import { extensionName } from "../../utils/settings.js";

async function saveCharacterById(chid) {
    const char = characters[chid];
    if (!char) return;

    try {
        const response = await fetch('/api/characters/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(char)
        });
        
        if (!response.ok) {
            console.error(`[Amily2 CharAPI] Failed to save character ${chid}:`, response.statusText);
        } else {
            console.log(`[Amily2 CharAPI] Successfully saved character ${chid}`);
        }
    } catch (e) {
        console.error(`[Amily2 CharAPI] Error saving character ${chid}:`, e);
    }
}

export function getCharacter(chid = this_chid) {
    if (chid === undefined || chid < 0 || !characters[chid]) {
        console.warn(`[Amily2 CharAPI] Invalid character ID: ${chid}`);
        return null;
    }
    return characters[chid];
}

export function updateCharacter(chid, updates) {
    const char = getCharacter(chid);
    if (!char) return false;

    let changed = false;
    const fields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

    fields.forEach(field => {
        if (updates[field] !== undefined && char[field] !== updates[field]) {
            char[field] = updates[field];
            changed = true;
        }
    });

    if (changed) {
        saveCharacterById(chid);
        console.log(`[Amily2 CharAPI] Updated character ${chid}:`, Object.keys(updates));
        return true;
    }
    return false;
}

export function getFirstMessages(chid) {
    const char = getCharacter(chid);
    if (!char) return [];

    const messages = [char.first_mes];
    if (char.data && Array.isArray(char.data.alternate_greetings)) {
        messages.push(...char.data.alternate_greetings);
    }
    return messages;
}

export function addFirstMessage(chid, message) {
    const char = getCharacter(chid);
    if (!char) return false;

    if (!char.data) char.data = {};
    if (!Array.isArray(char.data.alternate_greetings)) {
        char.data.alternate_greetings = [];
    }

    char.data.alternate_greetings.push(message);
    saveCharacterById(chid);
    console.log(`[Amily2 CharAPI] Added alternate greeting to character ${chid}`);
    return true;
}

export function updateFirstMessage(chid, index, message) {
    const char = getCharacter(chid);
    if (!char) return false;

    if (index === 0) {
        char.first_mes = message;
    } else {
        const altIndex = index - 1;
        if (char.data && Array.isArray(char.data.alternate_greetings) && char.data.alternate_greetings[altIndex] !== undefined) {
            char.data.alternate_greetings[altIndex] = message;
        } else {
            console.warn(`[Amily2 CharAPI] Alternate greeting index out of bounds: ${altIndex}`);
            return false;
        }
    }
    saveCharacterById(chid);
    console.log(`[Amily2 CharAPI] Updated greeting ${index} for character ${chid}`);
    return true;
}

export function removeFirstMessage(chid, index) {
    const char = getCharacter(chid);
    if (!char) return false;

    if (index === 0) {
        console.warn(`[Amily2 CharAPI] Cannot remove main greeting, clearing instead.`);
        char.first_mes = "";
    } else {
        const altIndex = index - 1;
        if (char.data && Array.isArray(char.data.alternate_greetings) && char.data.alternate_greetings[altIndex] !== undefined) {
            char.data.alternate_greetings.splice(altIndex, 1);
        } else {
            console.warn(`[Amily2 CharAPI] Alternate greeting index out of bounds: ${altIndex}`);
            return false;
        }
    }
    saveCharacterById(chid);
    console.log(`[Amily2 CharAPI] Removed greeting ${index} for character ${chid}`);
    return true;
}

export async function createNewCharacter(name) {
    try {
        const formData = new FormData();
        formData.append('ch_name', name);
        formData.append('description', '');
        formData.append('personality', '');
        formData.append('scenario', '');
        formData.append('first_mes', 'Hello!');
        formData.append('mes_example', '');
        formData.append('creator', 'Amily2-AutoChar');
        formData.append('creator_notes', 'Character created automatically by Amily2 AutoChar Card.');
        formData.append('tags', '');
        formData.append('character_version', '1.0');
        formData.append('post_history_instructions', '');
        formData.append('system_prompt', '');
        formData.append('talkativeness', '0.5');
        formData.append('extensions', '{}');
        formData.append('fav', 'false');
        
        formData.append('world', '');
        formData.append('depth_prompt_prompt', '');
        formData.append('depth_prompt_depth', '4');
        formData.append('depth_prompt_role', 'system');

        try {
            const res = await fetch(`scripts/extensions/third-party/${extensionName}/core/auto-char-card/Amily.png`);
            if (res.ok) {
                const blob = await res.blob();
                formData.append('avatar', blob, 'default.png');
            } else {
                throw new Error('Failed to fetch default avatar');
            }
        } catch (e) {
            console.warn("[Amily2 CharAPI] Failed to load default avatar, using fallback 1x1 PNG.", e);
            const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
            const byteCharacters = atob(base64Png);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'image/png' });
            formData.append('avatar', blob, 'default.png');
        }

        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }), 
            body: formData,
        });

        if (response.ok) {
            const avatarId = await response.text(); 
            console.log(`[Amily2 CharAPI] Created character: ${name}, Avatar ID: ${avatarId}`);
            
            await getCharacters();
            
            const newChid = characters.findIndex(c => c.avatar === avatarId);
            if (newChid !== -1) {
                return newChid;
            }
            
            return -2; 
        } else {
            console.error(`[Amily2 CharAPI] Failed to create character: ${response.statusText}`);
            return -1;
        }
    } catch (error) {
        console.error(`[Amily2 CharAPI] Error creating character:`, error);
        return -1;
    }
}
