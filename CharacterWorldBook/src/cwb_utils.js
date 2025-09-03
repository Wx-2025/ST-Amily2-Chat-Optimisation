const DEBUG_MODE = true;
const SCRIPT_ID_PREFIX = 'CWB';


export function logDebug(...args) {
    if (DEBUG_MODE) {
        console.log(`[${SCRIPT_ID_PREFIX}]`, ...args);
    }
}

export function logError(...args) {
    console.error(`[${SCRIPT_ID_PREFIX}]`, ...args);
}

export function isCwbEnabled() {
    try {
        const overrides = JSON.parse(localStorage.getItem('cwb_boolean_settings_override') || '{}');
        if (overrides.cwb_master_enabled !== undefined) {
            return overrides.cwb_master_enabled === true;
        }

        const settingsString = localStorage.getItem('extensions_settings_ST-Amily2-Chat-Optimisation');
        if (settingsString) {
            const settings = JSON.parse(settingsString);
            if (settings?.cwb_master_enabled !== undefined) {
                return settings.cwb_master_enabled === true;
            }
        }
        
        return true;
    } catch (error) {
        console.error('[CWB] Error reading master switch state:', error);
        return true;
    }
}

export function checkCwbEnabled(operation = '操作') {
    if (!isCwbEnabled()) {
        console.log(`[${SCRIPT_ID_PREFIX}] ${operation}被跳过 - CharacterWorldBook总开关已关闭`);
        return false;
    }
    return true;
}

export function showToastr(type, message, options = {}) {
    if (!isCwbEnabled()) {
        return;
    }
    if (window.toastr) {
        window.toastr.clear();
        window.toastr[type](message, `角色世界书`, options);
    } else {
        logDebug(`Toastr (${type}): ${message}`);
    }
}

export function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&#039;');
}

export function cleanChatName(fileName) {
    if (!fileName || typeof fileName !== 'string') return 'unknown_chat_source';
    let cleanedName = fileName;
    if (fileName.includes('/') || fileName.includes('\\')) {
        const parts = fileName.split(/[\\/]/);
        cleanedName = parts[parts.length - 1];
    }
    return cleanedName.replace(/\.jsonl$/, '').replace(/\.json$/, '');
}

export function compareVersions(v1, v2) {
    const parts1 = String(v1).split('.').map(Number);
    const parts2 = String(v2).split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

export function parseCustomFormat(text) {
    const data = {};
    if (typeof text !== 'string') return data;

    const coreDataMatch = text.match(/\[--Amily2::CHAR_START--\]([\s\S]*?)\[--Amily2::CHAR_END--\]/);
    if (!coreDataMatch || !coreDataMatch[1]) {
        return data;
    }
    const coreData = coreDataMatch[1];

    const setNestedValue = (obj, path, value) => {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            const nextKey = keys[i + 1];
            const isNextKeyNumeric = /^\d+$/.test(nextKey);
            if (!current[key]) {
                current[key] = isNextKeyNumeric ? [] : {};
            }
            current = current[key];
        }
        const finalKey = keys[keys.length - 1];
        if (/^\d+$/.test(finalKey) && Array.isArray(current)) {
            current[parseInt(finalKey, 10)] = value;
        } else {
            current[finalKey] = value;
        }
    };

    const lines = coreData.split('\n').filter(line => line.trim() !== '');
    lines.forEach(line => {
        const match = line.match(/^\[{1,2}(.*?)\]{1,2}:([\s\S]*)$/);
        if (match) {
            const path = match[1];
            const value = match[2].trim();
            setNestedValue(data, path, value);
        }
    });

    return data;
}

function buildCustomFormatRecursive(obj, prefix = '') {
    let result = '';
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const newPrefix = prefix ? `${prefix}.${key}` : key;
            const value = obj[key];

            if (value === null || value === undefined) continue;

            if (typeof value === 'object' && !Array.isArray(value)) {
                result += buildCustomFormatRecursive(value, newPrefix);
            } else if (Array.isArray(value)) {
                if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
                    value.forEach((item, index) => {
                        result += buildCustomFormatRecursive(item, `${newPrefix}.${index}`);
                    });
                } else {
                    value.forEach((item, index) => {
                        result += `[${newPrefix}.${index}]:${item}\n`;
                    });
                }
            } else {
                result += `[${newPrefix}]:${value}\n`;
            }
        }
    }
    return result;
}

export function buildCustomFormat(data) {
    let content = buildCustomFormatRecursive(data);
    content = content.split('\n').filter(line => line.match(/^\[.*?]:.+/)).join('\n');
    return `[--Amily2::CHAR_START--]\n${content.trim()}\n[--Amily2::CHAR_END--]`;
}
