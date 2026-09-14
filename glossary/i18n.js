import { t, subscribeLocaleChange } from '../utils/i18n/index.js';
import { PLAIN, TRADITIONAL, EN } from '../utils/i18n/messages/glossary.js';

const bindings = new Map();
const properties = { 'data-glossary-i18n': 'textContent', 'data-glossary-title': 'title', 'data-glossary-placeholder': 'placeholder' };
const ownPanel = '#amily2_glossary_panel';
const excludedText = 'input,select,textarea,pre,.entry-title,.database-file-item,[contenteditable]:not([contenteditable="false"])';
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fullKey(key) {
    const result = key.startsWith('glossaryUi.') ? key : `glossaryUi.${key}`;
    if (!Object.hasOwn(PLAIN, result)) throw new TypeError('Unknown glossary UI key');
    return result;
}

export function glossaryMessage(key, params = {}) {
    return t(fullKey(key), params);
}

function owned(element) {
    return Boolean(element?.closest?.(ownPanel))
        && !element.closest('#chat,.mes,pre,.entry-title,.database-file-item,.entry-content-editor,[contenteditable]:not([contenteditable="false"])');
}

function read(element, property) {
    return property === 'textContent' ? element.textContent : element.getAttribute(property);
}

function write(element, property, value) {
    if (property === 'textContent') element.textContent = value;
    else element.setAttribute(property, value);
}

function clearBinding(element, property) {
    bindings.get(element)?.delete(property);
    if (!bindings.get(element)?.size) bindings.delete(element);
    for (const [attribute, target] of Object.entries(properties)) {
        if (target === property) element.removeAttribute(attribute);
    }
    element.removeAttribute(property === 'textContent' ? 'data-amily-i18n' : `data-amily-i18n-${property}`);
}

export function setGlossaryText(element, key, params = {}, property = 'textContent') {
    if (!owned(element) || !Object.values(properties).includes(property)) return;
    if (property === 'textContent' && (element.children.length || element.matches(excludedText))) return;
    const messageKey = fullKey(key);
    const captured = { ...params };
    clearBinding(element, property);
    const value = t(messageKey, captured);
    write(element, property, value);
    if (!bindings.has(element)) bindings.set(element, new Map());
    bindings.get(element).set(property, { key: messageKey, params: captured, value });
}

export function setGlossaryRawText(element, message) {
    if (!owned(element) || element.children.length || element.matches(excludedText)) return;
    clearBinding(element, 'textContent');
    element.textContent = String(message ?? '');
}

export function glossaryHtml(key, params = {}, tag = 'span', value = '') {
    if (!['span', 'option'].includes(tag)) throw new TypeError('Unsupported glossary display tag');
    const messageKey = fullKey(key);
    return `<${tag}${tag === 'option' ? ` value="${escape(value)}"` : ''} data-glossary-i18n="${messageKey}" data-glossary-params="${escape(JSON.stringify(params))}">${escape(t(messageKey, params))}</${tag}>`;
}

export function releaseGlossaryTranslations(root, { includeRoot = true } = {}) {
    if (!root?.contains) return;
    // Release only the retiring subtree, including when it is already detached.
    for (const element of bindings.keys()) {
        if (element === root ? includeRoot : root.contains(element)) bindings.delete(element);
    }
}

// Register only explicit display markers in the owned panel, never scan user text.
export function bindGlossaryTranslations(root) {
    if (!owned(root)) return;
    for (const [attribute, property] of Object.entries(properties)) {
        for (const element of [root, ...root.querySelectorAll(`[${attribute}]`)]) {
            const key = element.getAttribute(attribute);
            if (!key || !Object.hasOwn(PLAIN, key) || !owned(element)) continue;
            if (property === 'textContent' && (element.children.length || element.matches(excludedText))) continue;
            let params;
            try {
                params = JSON.parse(element.getAttribute('data-glossary-params') || '{}');
                if (!params || Array.isArray(params) || typeof params !== 'object'
                    || Object.values(params).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) continue;
            } catch { continue; }
            const current = read(element, property);
            const matchesCopy = [PLAIN, TRADITIONAL, EN].some(catalog => catalog[key].replace(/\{([\w.-]+)\}/g,
                (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match) === current);
            if (!matchesCopy) continue;
            setGlossaryText(element, key, params, property);
            element.removeAttribute('data-glossary-params');
        }
    }
}

export function setGlossaryButton(button, key, params = {}, iconClass = null) {
    if (!owned(button)) return;
    let label = button.querySelector(':scope > .glossary-button-label');
    if (!label) {
        label = document.createElement('span');
        label.className = 'glossary-button-label';
        button.append(label);
    }
    setGlossaryText(label, key, params);
    if (iconClass !== null) {
        let icon = button.querySelector(':scope > i');
        if (!icon) {
            icon = document.createElement('i');
            button.prepend(icon);
        }
        icon.className = iconClass;
    }
}

export function reportGlossaryStatus(callback, key, params = {}, type = 'info') {
    const captured = { ...params };
    callback(glossaryMessage(key, captured), type, { key, params: captured });
}

subscribeLocaleChange(() => {
    for (const [element, states] of bindings) {
        if (!element.isConnected) {
            bindings.delete(element);
            continue;
        }
        if (!owned(element)) continue;
        for (const [property, binding] of states) {
            if (read(element, property) !== binding.value
                || (property === 'textContent' && (element.children.length || element.matches(excludedText)))) {
                states.delete(property);
                continue;
            }
            binding.value = t(binding.key, binding.params);
            write(element, property, binding.value);
        }
        if (!states.size) bindings.delete(element);
    }
});
