import {
    CATALOGS,
    DEFAULT_LOCALE,
    FALLBACK_LOCALE,
    LOCALE_IDS,
    LOCALE_OPTIONS,
} from './catalogs.js';

const TEXT_SELECTOR = '[data-amily-i18n]';
const ATTRIBUTE_BINDINGS = Object.freeze({
    'data-amily-i18n-title': 'title',
    'data-amily-i18n-placeholder': 'placeholder',
    'data-amily-i18n-aria-label': 'aria-label',
});

let activeLocale = DEFAULT_LOCALE;
const localeListeners = new Set();

export function normalizeLocale(value) {
    const candidate = String(value ?? '').trim();
    if (Object.hasOwn(CATALOGS, candidate)) return candidate;

    const lower = candidate.toLowerCase();
    if (lower === LOCALE_IDS.ZH_CN_PLAIN.toLowerCase()) return LOCALE_IDS.ZH_CN_PLAIN;
    if (lower === LOCALE_IDS.ZH_CN_AMILY.toLowerCase()) return LOCALE_IDS.ZH_CN_AMILY;
    if (lower === LOCALE_IDS.EN_US.toLowerCase() || lower.startsWith('en-') || lower === 'en') {
        return LOCALE_IDS.EN_US;
    }
    if (lower.startsWith('zh-') || lower === 'zh') return DEFAULT_LOCALE;
    return DEFAULT_LOCALE;
}

export function getLocale() {
    return activeLocale;
}

export function getLocaleOptions() {
    return LOCALE_OPTIONS.map(option => ({ ...option }));
}

export function getMessageTemplate(key, locale = activeLocale) {
    const normalizedLocale = normalizeLocale(locale);
    for (const catalog of [CATALOGS[normalizedLocale], CATALOGS[FALLBACK_LOCALE]]) {
        if (Object.hasOwn(catalog, key)) return catalog[key];
    }
    return String(key);
}

export function t(key, params = {}, locale = activeLocale) {
    const template = getMessageTemplate(key, locale);
    return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, name) => (
        Object.hasOwn(params ?? {}, name) ? String(params[name]) : match
    ));
}

function collectTargets(root, selector) {
    if (!root) return [];
    const targets = [];
    if (typeof root.matches === 'function' && root.matches(selector)) {
        targets.push(root);
    }
    if (typeof root.querySelectorAll === 'function') {
        targets.push(...root.querySelectorAll(selector));
    }
    return targets;
}

export function translateElement(element) {
    if (!element || typeof element.getAttribute !== 'function') return false;
    let changed = false;

    const textKey = element.getAttribute('data-amily-i18n');
    if (textKey) {
        element.textContent = t(textKey);
        changed = true;
    }

    for (const [dataAttribute, targetAttribute] of Object.entries(ATTRIBUTE_BINDINGS)) {
        const key = element.getAttribute(dataAttribute);
        if (!key) continue;
        element.setAttribute(targetAttribute, t(key));
        changed = true;
    }
    return changed;
}

export function applyTranslations(root = globalThis.document) {
    if (!root) return 0;
    const selectors = [
        TEXT_SELECTOR,
        ...Object.keys(ATTRIBUTE_BINDINGS).map(attribute => `[${attribute}]`),
    ];
    const seen = new Set();
    let translated = 0;

    for (const selector of selectors) {
        for (const element of collectTargets(root, selector)) {
            if (seen.has(element)) continue;
            seen.add(element);
            if (translateElement(element)) translated += 1;
        }
    }
    return translated;
}

export function setLocale(locale, { root = globalThis.document, notify = true } = {}) {
    const nextLocale = normalizeLocale(locale);
    const previousLocale = activeLocale;
    activeLocale = nextLocale;
    applyTranslations(root);

    if (notify && previousLocale !== nextLocale) {
        for (const listener of [...localeListeners]) {
            try {
                listener({ locale: nextLocale, previousLocale });
            } catch (error) {
                console.error('[Amily2 i18n] Locale listener failed:', error);
            }
        }
    }
    return nextLocale;
}

export function initializeI18n(locale, root = globalThis.document) {
    return setLocale(locale, { root, notify: false });
}

export function subscribeLocaleChange(listener) {
    if (typeof listener !== 'function') return () => {};
    localeListeners.add(listener);
    return () => localeListeners.delete(listener);
}

export {
    CATALOGS,
    DEFAULT_LOCALE,
    FALLBACK_LOCALE,
    LOCALE_IDS,
    LOCALE_OPTIONS,
};
