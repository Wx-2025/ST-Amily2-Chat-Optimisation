import { subscribeLocaleChange, t } from '../../utils/i18n/index.js';
import { PLAIN } from '../../utils/i18n/messages/auto-char-card.js';

const roots = new Map();
const ownership = new WeakMap();
const attributes = {
    'data-acc-i18n': 'textContent',
    'data-acc-i18n-title': 'title',
    'data-acc-i18n-placeholder': 'placeholder',
    'data-acc-i18n-label': 'label',
    'data-acc-i18n-aria-label': 'aria-label',
};
let unsubscribeLocale;

export { t };

function validKey(key) {
    return typeof key === 'string' && key.startsWith('autoCardUi.') && Object.hasOwn(PLAIN, key);
}

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
}

function readParams(source) {
    const params = JSON.parse(source);
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    if (Object.entries(params).some(([key, value]) =>
        ['__proto__', 'constructor', 'prototype'].includes(key)
        || !/^[A-Za-z0-9_.-]+$/.test(key)
        || (value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) return null;
    return params;
}

function remember(node, attribute, key, params, value) {
    if (!ownership.has(node)) ownership.set(node, new Map());
    ownership.get(node).set(attribute, { key, params, value, lost: false });
}

function isOwned(node, attribute, key, source, current, params, previousLocale) {
    const last = ownership.get(node)?.get(attribute);
    if (last && (last.lost || last.key !== key || last.params !== source || last.value !== current)) {
        last.lost = true;
        return false;
    }
    return Boolean(last) || [t(key, params), t(key, params, previousLocale), t(key, params, 'zh-CN-plain')].includes(current);
}

function refreshRoot(root, previousLocale) {
    const selector = Object.keys(attributes).map(marker => `[${marker}]`).join(',');
    const targets = [...(root?.querySelectorAll?.(selector) || [])];
    if (root?.matches?.(selector)) targets.unshift(root);
    for (const node of targets) {
        for (const [marker, attribute] of Object.entries(attributes)) {
            try {
                const key = node.getAttribute(marker);
                if (!validKey(key)) continue;
                if (attribute === 'textContent' && (node.childElementCount
                    || node.closest('input,textarea,pre,code,script,style,iframe,[contenteditable]:not([contenteditable="false"])')
                    || node.matches('select'))) continue;
                const source = node.getAttribute('data-acc-i18n-params') || '{}';
                const params = readParams(source);
                if (!params) continue;
                const current = attribute === 'textContent' ? node.textContent : node.getAttribute(attribute);
                if (!isOwned(node, attribute, key, source, current, params, previousLocale)) continue;
                const value = t(key, params);
                if (value !== current) {
                    if (attribute === 'textContent') node.textContent = value;
                    else node.setAttribute(attribute, value);
                }
                remember(node, attribute, key, source, value);
            } catch {
                // A malformed local marker must not block other controls.
            }
        }
    }
}

export function autoCardLabel(key, params = {}) {
    if (!validKey(key)) return '';
    return `<span data-acc-i18n="${escape(key)}" data-acc-i18n-params="${escape(JSON.stringify(params))}">${escape(t(key, params))}</span>`;
}

export function autoCardOption(value, key, params = {}, disabled = false) {
    if (!validKey(key)) return '';
    return `<option value="${escape(value)}" data-acc-i18n="${escape(key)}" data-acc-i18n-params="${escape(JSON.stringify(params))}"${disabled ? ' disabled' : ''}>${escape(t(key, params))}</option>`;
}

export function setAutoCardText(target, key, params = {}) {
    if (!validKey(key)) return target;
    const node = target?.[0] || target;
    if (node?.setAttribute) {
        const source = JSON.stringify(params);
        node.setAttribute('data-acc-i18n', key);
        node.setAttribute('data-acc-i18n-params', source);
        node.textContent = t(key, params);
        remember(node, 'textContent', key, source, node.textContent);
    } else if (typeof target?.text === 'function') target.text(t(key, params));
    return target;
}

export function setAutoCardAttribute(target, attribute, key, params = {}) {
    const marker = Object.keys(attributes).find(name => attributes[name] === attribute);
    if (!marker || attribute === 'textContent' || !validKey(key)) return target;
    const node = target?.[0] || target;
    if (node?.setAttribute) {
        const source = JSON.stringify(params);
        node.setAttribute(marker, key);
        node.setAttribute('data-acc-i18n-params', source);
        node.setAttribute(attribute, t(key, params));
        remember(node, attribute, key, source, node.getAttribute(attribute));
    } else if (typeof target?.attr === 'function') target.attr(attribute, t(key, params));
    return target;
}

export function refreshAutoCardSecretPlaceholder(target) {
    const node = target?.[0] || target;
    if (!node?.dataset) return;
    setAutoCardAttribute(target, 'placeholder', node.dataset.secretStored === 'true'
        ? 'autoCardUi.api.storedKey' : 'autoCardUi.api.keyPlaceholder');
}

// The model-request lease compares option markup. Canonicalize only owned copy,
// so a locale change is harmless while real list edits still invalidate the lease.
export function autoCardOptionsSignature(target) {
    const node = target?.[0] || target;
    if (!node?.cloneNode) return target.html();
    const clone = node.cloneNode(true);
    const options = [...node.querySelectorAll('option')];
    [...clone.querySelectorAll('option')].forEach((copy, index) => {
        try {
            const option = options[index];
            const key = option.getAttribute('data-acc-i18n');
            if (!validKey(key) || option.childElementCount) return;
            const source = option.getAttribute('data-acc-i18n-params') || '{}';
            const params = readParams(source);
            if (params && isOwned(option, 'textContent', key, source, option.textContent, params)) {
                copy.textContent = t(key, params, 'zh-CN-plain');
            }
        } catch { /* Preserve malformed or externally supplied options verbatim. */ }
    });
    return clone.innerHTML;
}

export function initializeAutoCardI18n(target, slot = 'window') {
    const root = target?.[0] || target;
    if (!root?.querySelectorAll) return;
    roots.set(slot, root);
    refreshRoot(root);
    if (!unsubscribeLocale) unsubscribeLocale = subscribeLocaleChange(({ previousLocale }) => {
        for (const [name, element] of roots) {
            if (element.isConnected) refreshRoot(element, previousLocale);
            else roots.delete(name);
        }
    });
}
