import { t, subscribeLocaleChange } from '../utils/i18n/index.js';
import { PLAIN } from '../utils/i18n/messages/preset-editor.js';
import { escapeHTML } from '../utils/utils.js';

const bindings = new Map();
const dialogRoots = new WeakSet();
const localErrors = new WeakMap();
const attributes = ['title', 'aria-label'];
const selector = ['[data-preset-editor-i18n]', ...attributes.map(name => `[data-preset-editor-${name}]`)].join(',');
export const presetEscape = value => escapeHTML(String(value ?? ''));
const resolveParams = params => typeof params === 'function' ? params() : params;
const fullKey = key => `presetEditorUi.${key}`;

function requireKey(key) {
    if (!Object.hasOwn(PLAIN, fullKey(key))) throw new TypeError('Unknown preset editor UI key');
}

export function presetText(key, params = {}) {
    requireKey(key);
    return t(fullKey(key), params);
}

export function presetHtml(key, params = {}) {
    return `<span data-preset-editor-i18n="${presetEscape(key)}" data-preset-editor-params="${presetEscape(JSON.stringify(params))}">${presetEscape(presetText(key, params))}</span>`;
}

export function presetAttr(key, attribute = 'title') {
    if (!attributes.includes(attribute)) throw new TypeError('Unsupported preset editor display attribute');
    return `${attribute}="${presetEscape(presetText(key))}" data-preset-editor-${attribute}="${presetEscape(key)}"`;
}

export function setPresetText(target, key, params = {}, property = 'textContent') {
    const element = target?.[0] ?? target;
    if (!element?.setAttribute) return;
    requireKey(key);
    if (property !== 'textContent' && !attributes.includes(property)) throw new TypeError('Unsupported preset editor display property');
    if (property === 'textContent' && (element.children.length || element.matches('input, textarea, select, [contenteditable]'))) return;
    const rendered = presetText(key, resolveParams(params));
    if (property === 'textContent') element.textContent = rendered;
    else element.setAttribute(property, rendered);
    if (!bindings.has(element)) bindings.set(element, new Map());
    bindings.get(element).set(property, { key, params, rendered });
}

export function releasePresetTranslations(target) {
    const root = target?.[0] ?? target;
    if (!root?.contains) return;
    for (const element of bindings.keys()) if (root === element || root.contains(element)) bindings.delete(element);
    dialogRoots.delete(root);
}

// Register only nodes supplied by this editor; locale events never scan host/user content.
export function bindPresetTranslations(target) {
    const root = target?.[0] ?? target;
    if (!root?.querySelectorAll) return;
    if (root.tagName === 'DIALOG' && !dialogRoots.has(root)) {
        dialogRoots.add(root);
        root.addEventListener('close', () => releasePresetTranslations(root), { once: true });
    }
    for (const element of [root, ...root.querySelectorAll(selector)]) {
        const key = element.getAttribute('data-preset-editor-i18n');
        if (key && Object.hasOwn(PLAIN, fullKey(key)) && !bindings.get(element)?.has('textContent')) {
            let params;
            try {
                params = JSON.parse(element.getAttribute('data-preset-editor-params') || '{}');
                if (!params || Array.isArray(params) || typeof params !== 'object'
                    || Object.values(params).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) continue;
            } catch { continue; }
            setPresetText(element, key, params);
        }
        for (const attribute of attributes) {
            const attributeKey = element.getAttribute(`data-preset-editor-${attribute}`);
            if (attributeKey && Object.hasOwn(PLAIN, fullKey(attributeKey)) && !bindings.get(element)?.has(attribute)) {
                setPresetText(element, attributeKey, {}, attribute);
            }
        }
    }
}

export function presetSectionTitle(sectionKey) {
    return Object.hasOwn(PLAIN, fullKey(`section.${sectionKey}`)) ? presetText(`section.${sectionKey}`) : String(sectionKey);
}

export function bindPresetModalTitle(dialog, key) {
    const root = dialog?.[0] ?? dialog;
    const title = root?.querySelector('.popup-body > h3');
    if (!title) return;
    const label = title.ownerDocument.createElement('span');
    for (const node of [...title.childNodes]) if (node.nodeType === 3) node.remove();
    title.append(' ', label);
    setPresetText(label, key);
}

export function presetBlockHtml(block, sectionKey, property) {
    const key = `block.${sectionKey}.${block.id}.${property}`;
    if (Object.hasOwn(PLAIN, fullKey(key))) return presetHtml(key);
    if (property === 'description') {
        const raw = String(block.description ?? '');
        for (const prefix of ['固定格式为', '固定格式：']) {
            if (raw.startsWith(prefix)) return presetHtml('block.format', { format: raw.slice(prefix.length) });
        }
        if (raw.startsWith('占位符: ')) return presetHtml('block.placeholder', { format: raw.slice('占位符: '.length) });
        if (sectionKey === 'secondary_filler' && block.id === 'contextHistory' && raw.includes('格式：')) {
            return presetHtml('block.historyFormat', { format: raw.slice(raw.indexOf('格式：') + '格式：'.length) });
        }
    }
    return presetEscape(block[property]);
}

export function presetToast(kind, key, params = {}, options = {}) {
    let root;
    const toast = globalThis.window?.toastr?.[kind]?.(presetText(key, resolveParams(params)), '', {
        ...options,
        escapeHtml: true,
        onHidden: function (...args) {
            releasePresetTranslations(root);
            options.onHidden?.apply(this, args);
        },
    });
    root = toast?.[0] ?? toast;
    setPresetText(root?.querySelector?.('.toast-message'), key, params);
}

export function presetError(key) {
    const error = new Error(presetText(key));
    localErrors.set(error, key);
    return error;
}

export function presetErrorParams(error) {
    const key = error && typeof error === 'object' ? localErrors.get(error) : null;
    const detail = String(error?.message ?? error ?? '');
    return key ? () => ({ detail: presetText(key) }) : { detail };
}

subscribeLocaleChange(() => {
    for (const [element, properties] of bindings) {
        for (const [property, binding] of properties) {
            const current = property === 'textContent' ? element.textContent : element.getAttribute(property);
            if (current !== binding.rendered) { properties.delete(property); continue; }
            binding.rendered = presetText(binding.key, resolveParams(binding.params));
            if (property === 'textContent') element.textContent = binding.rendered;
            else element.setAttribute(property, binding.rendered);
        }
        if (!properties.size) bindings.delete(element);
    }
});
