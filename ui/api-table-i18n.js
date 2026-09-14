import { t, subscribeLocaleChange, CATALOGS } from '../utils/i18n/index.js';
import { PLAIN } from '../utils/i18n/messages/api-table.js';
import { PLAIN as DEVICE_PLAIN } from '../utils/i18n/messages/device-management.js';
import { PLAIN as VAULT_PLAIN } from '../utils/i18n/messages/api-vault.js';
import { PLAIN as COMPAT_PLAIN } from '../utils/i18n/messages/table-compat.js';

const displayKeys = new Set([PLAIN, DEVICE_PLAIN, VAULT_PLAIN, COMPAT_PLAIN].flatMap(catalog => Object.keys(catalog)));

const bindings = new Map();
const metadataBindings = new WeakMap();
const attributes = ['title', 'placeholder', 'aria-label', 'label'];
const ownedRoots = '#amily2_main_drawer #amily2_chat_optimiser, #amily2_extension_frame #amily2_chat_optimiser';
const userContent = '#chat, .mes, .mes_text, #all-tables-container, .popup-content, textarea, [contenteditable]:not([contenteditable="false"])';
const selector = ['[data-amily-i18n]', '[data-api-table-i18n]', ...attributes.flatMap(attribute =>
    [`[data-amily-i18n-${attribute}]`, `[data-api-table-${attribute}]`])].join(', ');

function knownKey(key) {
    return typeof key === 'string' && key.startsWith('apiTableUi.') && displayKeys.has(key);
}

function isOwned(element) {
    return Boolean(element?.closest?.(ownedRoots)) && !element.closest(userContent);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function apiTableHtml(key, params = {}) {
    if (!knownKey(key)) throw new TypeError('Unknown API/table UI key');
    return `<span data-api-table-i18n="${escapeHtml(key)}" data-api-table-params="${escapeHtml(JSON.stringify(params))}">${escapeHtml(t(key, params))}</span>`;
}

export function apiTableAttr(key, params = {}, attribute = 'title') {
    if (!knownKey(key) || !attributes.includes(attribute)) throw new TypeError('Unsupported UI attribute or key');
    return `${attribute}="${escapeHtml(t(key, params))}" data-api-table-${attribute}="${escapeHtml(key)}" data-api-table-${attribute}-params="${escapeHtml(JSON.stringify(params))}"`;
}

export function clearApiTableText(target, property = 'textContent') {
    const element = target?.[0] ?? target;
    bindings.get(element)?.delete(property);
    if (bindings.get(element)?.size === 0) bindings.delete(element);
    metadataBindings.get(element)?.delete(property);
    const suffix = property === 'textContent' ? 'i18n' : property;
    element?.removeAttribute?.(property === 'textContent' ? 'data-amily-i18n' : `data-amily-i18n-${property}`);
    element?.removeAttribute?.(`data-api-table-${suffix}`);
    element?.removeAttribute?.(property === 'textContent' ? 'data-api-table-params' : `data-api-table-${property}-params`);
    return target;
}

export function setApiTableText(target, key, params = {}, property = 'textContent') {
    const element = target?.[0] ?? target;
    if (!element?.setAttribute || (target?.jquery && !target.length)) return target;
    if (!knownKey(key) || (property !== 'textContent' && !attributes.includes(property))) {
        throw new TypeError('Unsupported UI property or key');
    }
    clearApiTableText(target, property);
    const resolveParams = typeof params === 'function' ? params : () => ({ ...params });
    const value = t(key, resolveParams());
    writeDisplay(element, property, value);
    if (!bindings.has(element)) bindings.set(element, new Map());
    bindings.get(element).set(property, { key, resolveParams, value });
    return target;
}

function readDisplay(element, property) {
    return property === 'textContent' ? element.textContent : element.getAttribute(property);
}

function writeDisplay(element, property, value) {
    if (property === 'textContent') element.textContent = value;
    else element.setAttribute(property, value);
}

function refreshMetadata(element, property, key, rawParams) {
    if (!knownKey(key) || (property === 'textContent' && (element.children.length || element.matches('input, select')))) return;
    let params;
    try {
        params = JSON.parse(rawParams || '{}');
        if (!params || Array.isArray(params) || typeof params !== 'object'
            || Object.values(params).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) return;
    } catch {
        return;
    }
    if (!metadataBindings.has(element)) metadataBindings.set(element, new Map());
    const states = metadataBindings.get(element);
    const previous = states.get(property);
    const value = readDisplay(element, property);
    const signature = JSON.stringify([key, params]);
    // Metadata may outlive a status update. Never overwrite text replaced by its owner.
    if (previous?.signature === signature) {
        if (previous.edited || value !== previous.value) {
            states.set(property, { ...previous, edited: true });
            return;
        }
    } else if (!Object.keys(CATALOGS).some(locale => value === t(key, params, locale))) {
        states.set(property, { signature, value, edited: true });
        return;
    }
    const translated = t(key, params);
    writeDisplay(element, property, translated);
    states.set(property, { signature, value: translated });
}

// Only explicitly registered display keys in the plugin shell; no document-wide pass.
export function refreshApiTableTranslations(root = globalThis.document) {
    if (!root) return;
    const roots = isOwned(root) ? [root] : [...(root.querySelectorAll?.(ownedRoots) ?? [])].filter(isOwned);
    if (!roots.length) return;
    const contains = element => isOwned(element) && roots.some(scope => scope === element || scope.contains(element));
    for (const [element, properties] of bindings) {
        if (!element.isConnected) {
            bindings.delete(element);
            continue;
        }
        if (!contains(element)) continue;
        for (const [property, binding] of properties) {
            if (readDisplay(element, property) !== binding.value) {
                properties.delete(property);
                continue;
            }
            binding.value = t(binding.key, binding.resolveParams());
            writeDisplay(element, property, binding.value);
        }
        if (!properties.size) bindings.delete(element);
    }
    const elements = new Set(roots.flatMap(scope => [scope, ...scope.querySelectorAll(selector)]));
    for (const element of elements) {
        if (!isOwned(element)) continue;
        refreshMetadata(element, 'textContent', element.getAttribute('data-api-table-i18n') || element.getAttribute('data-amily-i18n'),
            element.getAttribute('data-api-table-params'));
        for (const attribute of attributes) {
            refreshMetadata(element, attribute, element.getAttribute(`data-api-table-${attribute}`) || element.getAttribute(`data-amily-i18n-${attribute}`),
                element.getAttribute(`data-api-table-${attribute}-params`));
        }
    }
}

subscribeLocaleChange(() => refreshApiTableTranslations());

export { t };
