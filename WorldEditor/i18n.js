import { t, subscribeLocaleChange } from '../utils/i18n/index.js';
import { PLAIN } from '../utils/i18n/messages/world-editor.js';
import { escapeHTML } from '../utils/utils.js';

const roots = new Set();
const bindings = new Map();
const metadata = new WeakMap();
const localErrors = new WeakMap();
const attributes = ['title', 'placeholder', 'aria-label', 'data-label'];
const selector = ['[data-world-editor-i18n]', ...attributes.map(name => `[data-world-editor-${name}]`)].join(',');
const escape = value => escapeHTML(String(value ?? ''));
const paramsValue = params => typeof params === 'function' ? params() : params;

function requireKey(key) {
    if (!Object.hasOwn(PLAIN, key)) throw new TypeError('Unknown World Editor UI key');
}

export function worldEditorHtml(key, params = {}) {
    requireKey(key);
    return `<span data-world-editor-i18n="${escape(key)}" data-world-editor-params="${escape(JSON.stringify(params))}">${escape(t(key, params))}</span>`;
}

export function worldEditorAttr(key, params = {}, attribute = 'title') {
    requireKey(key);
    if (!attributes.includes(attribute)) throw new TypeError('Unsupported World Editor display attribute');
    return `${attribute}="${escape(t(key, params))}" data-world-editor-${attribute}="${escape(key)}" data-world-editor-${attribute}-params="${escape(JSON.stringify(params))}"`;
}

export function worldEditorOption(value, key, selected = false) {
    requireKey(key);
    return `<option value="${escape(value)}" data-world-editor-i18n="${escape(key)}" ${selected ? 'selected' : ''}>${escape(t(key))}</option>`;
}

export function setWorldEditorText(target, key, params = {}) {
    const element = target?.[0] ?? target;
    if (!element) return;
    requireKey(key);
    element.removeAttribute('data-world-editor-i18n');
    element.removeAttribute('data-world-editor-params');
    metadata.get(element)?.delete('textContent');
    const value = t(key, paramsValue(params));
    element.textContent = value;
    bindings.set(element, { key, params, rendered: value });
}

function refreshMetadata(element, property, key, rawParams) {
    if (!Object.hasOwn(PLAIN, key)) return;
    if (property === 'textContent' && (element.children.length || element.matches('input, textarea, select, [contenteditable]'))) return;
    let params;
    try {
        params = JSON.parse(rawParams || '{}');
        if (!params || Array.isArray(params) || typeof params !== 'object'
            || Object.values(params).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) return;
    } catch { return; }
    const signature = JSON.stringify([key, params]);
    const current = property === 'textContent' ? element.textContent : element.getAttribute(property);
    const states = metadata.get(element) || new Map();
    const previous = states.get(property);
    if (previous?.signature === signature && (previous.edited || current !== previous.value)) {
        states.set(property, { ...previous, edited: true });
        return;
    }
    const value = t(key, params);
    if (property === 'textContent') element.textContent = value;
    else element.setAttribute(property, value);
    states.set(property, { signature, value });
    metadata.set(element, states);
}

// Explicit panel, dialog and toast roots only. Never render lists, set values or replay events.
export function refreshWorldEditorTranslations(root = null) {
    const scopes = root ? [...roots].filter(scope => scope === root || scope.contains(root)).map(() => root) : [...roots];
    const contains = element => scopes.some(scope => scope === element || scope.contains(element));
    for (const [element, binding] of bindings) {
        if (!contains(element)) continue;
        if (element.textContent !== binding.rendered) { bindings.delete(element); continue; }
        binding.rendered = t(binding.key, paramsValue(binding.params));
        element.textContent = binding.rendered;
    }
    for (const scope of new Set(scopes)) {
        const elements = [scope, ...scope.querySelectorAll(selector)];
        for (const element of elements) {
            refreshMetadata(element, 'textContent', element.getAttribute('data-world-editor-i18n'), element.getAttribute('data-world-editor-params'));
            for (const attribute of attributes) {
                refreshMetadata(element, attribute, element.getAttribute(`data-world-editor-${attribute}`), element.getAttribute(`data-world-editor-${attribute}-params`));
            }
        }
    }
}

export function releaseWorldEditorTranslations(target) {
    const root = target?.[0] ?? target;
    if (!root?.contains) return;
    for (const scope of roots) if (root === scope || root.contains(scope)) roots.delete(scope);
    for (const element of bindings.keys()) if (root === element || root.contains(element)) bindings.delete(element);
}

export function bindWorldEditorTranslations(target) {
    const root = target?.[0] ?? target;
    if (!root) return () => {};
    const dispose = () => releaseWorldEditorTranslations(root);
    if (!roots.has(root) && root.tagName === 'DIALOG') root.addEventListener('close', dispose, { once: true });
    roots.add(root);
    refreshWorldEditorTranslations(root);
    return dispose;
}

export function worldEditorToast(kind, key, params = {}) {
    requireKey(key);
    let root;
    const toast = globalThis.window?.toastr?.[kind]?.(t(key, paramsValue(params)), undefined, {
        escapeHtml: true,
        onHidden: () => releaseWorldEditorTranslations(root),
    });
    root = toast?.[0] ?? toast;
    if (root?.querySelector) {
        bindWorldEditorTranslations(root);
        setWorldEditorText(root.querySelector('.toast-message'), key, params);
    }
}

export function worldEditorError(key, params = {}) {
    requireKey(key);
    const error = new Error(t(key, params));
    localErrors.set(error, { key, params });
    return error;
}

export function worldEditorErrorParams(error) {
    const local = error && typeof error === 'object' ? localErrors.get(error) : null;
    const detail = String(error?.message ?? error ?? '');
    return local ? () => ({ detail: t(local.key, local.params) }) : { detail };
}

subscribeLocaleChange(() => refreshWorldEditorTranslations());

export { t };
