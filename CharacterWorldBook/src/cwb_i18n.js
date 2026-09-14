import { subscribeLocaleChange, t } from '../../utils/i18n/index.js';
import { PLAIN } from '../../utils/i18n/messages/character-worldbook.js';

const roots = new Map();
const ownership = new WeakMap();
const attributes = {
    'data-cwb-i18n': 'textContent',
    'data-cwb-i18n-title': 'title',
    'data-cwb-i18n-placeholder': 'placeholder',
    'data-cwb-i18n-aria-label': 'aria-label',
};
let unsubscribeLocale = null;

export { t };

export function escapeCwbHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

export function cwbLabel(key, params = {}) {
    if (!validKey(key)) return '';
    return `<span data-cwb-i18n="${escapeCwbHtml(key)}" data-cwb-i18n-params="${escapeCwbHtml(JSON.stringify(params))}">${escapeCwbHtml(t(key, params))}</span>`;
}

export function setCwbHtml(target, html) {
    const node = target?.[0] || target;
    node?.removeAttribute?.('data-cwb-i18n');
    node?.removeAttribute?.('data-cwb-i18n-params');
    node?.removeAttribute?.('data-amily-i18n');
    ownership.get(node)?.delete('textContent');
    target.html(html);
    refreshRoot(node);
    return target;
}

export function setCwbText(target, key, params = {}) {
    if (!validKey(key)) return target;
    const node = target?.[0] || target;
    if (node?.setAttribute) {
        node.removeAttribute('data-amily-i18n');
        node.setAttribute('data-cwb-i18n', key);
        node.setAttribute('data-cwb-i18n-params', JSON.stringify(params));
        node.textContent = t(key, params);
        remember(node, 'textContent', key, JSON.stringify(params), node.textContent);
    } else if (typeof target?.text === 'function') {
        target.text(t(key, params));
    }
    return target;
}

function validKey(key) {
    return key?.startsWith('characterWorldUi.') && Object.hasOwn(PLAIN, key);
}

function remember(node, attribute, key, params, value) {
    if (!ownership.has(node)) ownership.set(node, new Map());
    ownership.get(node).set(attribute, { key, params, value, lost: false });
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

function refreshRoot(root, previousLocale) {
    const selector = Object.keys(attributes).map(name => `[${name}]`).join(',');
    const targets = [...(root?.querySelectorAll?.(selector) || [])];
    if (root?.matches?.(selector)) targets.unshift(root);
    for (const node of targets) {
        for (const [marker, attribute] of Object.entries(attributes)) {
            try {
                const key = node.getAttribute(marker);
                if (!validKey(key)) continue;
                if (attribute === 'textContent' && (node.childElementCount || node.matches('input,textarea,select'))) continue;
                const source = node.getAttribute('data-cwb-i18n-params') || '{}';
                const params = readParams(source);
                if (!params) continue;
                const current = attribute === 'textContent' ? node.textContent : node.getAttribute(attribute);
                const last = ownership.get(node)?.get(attribute);
                if (last && (last.lost || last.key !== key || last.params !== source || last.value !== current)) {
                    last.lost = true;
                    continue;
                }
                // Only adopt newly mounted markup when it still contains its authored copy.
                if (!last && ![t(key, params), t(key, params, previousLocale), t(key, params, 'zh-CN-plain')].includes(current)) continue;
                const value = t(key, params);
                if (attribute === 'textContent') node.textContent = value;
                else node.setAttribute(attribute, value);
                remember(node, attribute, key, source, value);
            } catch {
                // A malformed binding must not prevent other controls from changing language.
            }
        }
    }
}

export function refreshCwbSecretPlaceholder(target) {
    const input = target?.[0] || target;
    if (!input?.dataset) return;
    const key = input.dataset.secretStored === 'true' ? 'characterWorldUi.api.storedKey' : 'characterWorldUi.api.optional';
    input.setAttribute('data-cwb-i18n-placeholder', key);
    input.placeholder = t(key);
    remember(input, 'placeholder', key, input.getAttribute('data-cwb-i18n-params') || '{}', input.placeholder);
}

export function initializeCwbI18n(target, slot = 'settings') {
    const root = target?.[0] || target;
    if (!root?.querySelectorAll) return;
    roots.set(slot, root);
    refreshRoot(root);
    if (!unsubscribeLocale) {
        unsubscribeLocale = subscribeLocaleChange(({ previousLocale }) => {
            for (const [name, element] of roots) {
                if (element.isConnected) refreshRoot(element, previousLocale);
                else roots.delete(name);
            }
        });
    }
}
