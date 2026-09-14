import { LOCALE_IDS } from './catalogs.js';
import { applyTranslations, setLocale, subscribeLocaleChange } from './index.js';

export const I18N_ONBOARDING_VERSION = 1;
export const I18N_ONBOARDING_VERSION_KEY = 'uiLocaleOnboardingVersion';
export const I18N_ONBOARDING_PENDING_KEY = 'uiLocaleChoicePending';
const onboardingDialogs = new WeakMap();

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCompletedOnboarding(settings) {
    return Number(settings?.[I18N_ONBOARDING_VERSION_KEY]) >= I18N_ONBOARDING_VERSION;
}

function needsInitialLocaleChoice(settings) {
    return isObject(settings)
        && settings[I18N_ONBOARDING_PENDING_KEY] === true
        && !hasCompletedOnboarding(settings);
}

/**
 * Mark first creation for a terminology choice. Preserve existing preferences;
 * configurations without a locale keep the established traditional naming.
 */
export function prepareInitialLocalePreference(settingsRegistry, extensionName) {
    if (!isObject(settingsRegistry)) {
        return Object.freeze({ changed: false, shouldPrompt: false, settings: null });
    }

    const hadNamespace = Object.hasOwn(settingsRegistry, extensionName);
    if (hadNamespace && !isObject(settingsRegistry[extensionName])) {
        return Object.freeze({ changed: false, shouldPrompt: false, settings: null });
    }
    const settings = hadNamespace ? settingsRegistry[extensionName] : {};
    if (!hadNamespace) {
        settings.uiLocale = LOCALE_IDS.ZH_CN_AMILY;
        settings[I18N_ONBOARDING_PENDING_KEY] = true;
        settingsRegistry[extensionName] = settings;
        return Object.freeze({ changed: true, shouldPrompt: true, settings });
    }

    if (hasCompletedOnboarding(settings)) {
        return Object.freeze({ changed: false, shouldPrompt: false, settings });
    }

    // Earlier settings controls could save a locale without clearing pending.
    if (needsInitialLocaleChoice(settings)
        && (settings.uiLocale === undefined || settings.uiLocale === LOCALE_IDS.ZH_CN_AMILY)) {
        const changed = settings.uiLocale === undefined;
        if (changed) settings.uiLocale = LOCALE_IDS.ZH_CN_AMILY;
        return Object.freeze({ changed, shouldPrompt: true, settings });
    }

    if (settings.uiLocale === undefined) settings.uiLocale = LOCALE_IDS.ZH_CN_AMILY;
    settings[I18N_ONBOARDING_VERSION_KEY] = I18N_ONBOARDING_VERSION;
    delete settings[I18N_ONBOARDING_PENDING_KEY];
    return Object.freeze({ changed: true, shouldPrompt: false, settings });
}

function commitLocalePreference(settings, locale, {
    root = globalThis.document,
    save = () => {},
} = {}) {
    const keys = ['uiLocale', I18N_ONBOARDING_VERSION_KEY, I18N_ONBOARDING_PENDING_KEY];
    const previous = keys.map(key => [key, Object.hasOwn(settings, key), settings[key]]);
    if (locale !== undefined) settings.uiLocale = locale;
    settings[I18N_ONBOARDING_VERSION_KEY] = hasCompletedOnboarding(settings)
        ? settings[I18N_ONBOARDING_VERSION_KEY]
        : I18N_ONBOARDING_VERSION;
    delete settings[I18N_ONBOARDING_PENDING_KEY];
    try {
        save();
    } catch (error) {
        for (const [key, existed, value] of previous) {
            if (existed) settings[key] = value;
            else delete settings[key];
        }
        throw error;
    }
    const selected = setLocale(settings.uiLocale, { root });
    // Completing the preference need not change the active locale.
    onboardingDialogs.get(root)?.closeIfFinished?.();
    return selected;
}

export function applyLocalePreference(settings, locale, options = {}) {
    if (!isObject(settings) || !Object.values(LOCALE_IDS).includes(locale)) return null;
    return commitLocalePreference(settings, locale, options);
}

export function applyInitialLocaleChoice(settings, locale, options = {}) {
    if (!needsInitialLocaleChoice(settings)
        || ![LOCALE_IDS.ZH_CN_PLAIN, LOCALE_IDS.ZH_CN_AMILY].includes(locale)) return null;
    return applyLocalePreference(settings, locale, options);
}

export function dismissInitialLocaleChoice(settings, options = {}) {
    if (!needsInitialLocaleChoice(settings)) return null;
    return commitLocalePreference(settings, undefined, options);
}

function appendTextElement(documentRef, parent, tagName, key, className = '') {
    const element = documentRef.createElement(tagName);
    element.setAttribute('data-amily-i18n', key);
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
}

export function showInitialLocaleChoice(settingsOrGetter, {
    root = globalThis.document,
    save = () => {},
} = {}) {
    const getSettings = typeof settingsOrGetter === 'function' ? settingsOrGetter : () => settingsOrGetter;
    if (!needsInitialLocaleChoice(getSettings()) || !root?.body) {
        return false;
    }
    if (onboardingDialogs.has(root)) return Boolean(onboardingDialogs.get(root)?.dialog.isConnected);
    if (root.getElementById?.('amily2-i18n-onboarding')) return true;

    const dialog = root.createElement('dialog');
    onboardingDialogs.set(root, { dialog });
    if (typeof dialog.showModal !== 'function') return false;

    dialog.id = 'amily2-i18n-onboarding';
    dialog.className = 'popup amily2-modal';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${dialog.id}-title`);
    dialog.setAttribute('aria-describedby', `${dialog.id}-description`);
    appendTextElement(root, dialog, 'h3', 'onboarding.title').id = `${dialog.id}-title`;
    appendTextElement(root, dialog, 'p', 'onboarding.description').id = `${dialog.id}-description`;
    const errorMessage = appendTextElement(root, dialog, 'p', 'settings.language.saveFailed');
    errorMessage.setAttribute('role', 'alert');
    errorMessage.hidden = true;

    const previousFocus = root.activeElement;
    let closed = false;
    let unsubscribe = () => {};
    const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus?.();
    };
    const finish = action => {
        if (closed) return;
        try {
            // A panel reload or settings import can replace the namespace.
            const settings = getSettings();
            if (needsInitialLocaleChoice(settings)) action(settings);
            cleanup();
        } catch (error) {
            errorMessage.hidden = false;
            console.error('[Amily2 i18n] Unable to save locale preference:', error);
        }
    };
    const dismiss = () => finish(settings => dismissInitialLocaleChoice(settings, { root, save }));

    const controls = root.createElement('div');
    controls.className = 'popup-controls';
    const addChoice = (key, action) => {
        const button = appendTextElement(root, controls, 'button', key, 'menu_button');
        button.type = 'button';
        button.addEventListener('click', action);
        return button;
    };
    const firstChoice = addChoice('onboarding.plain', () => finish(settings => (
        applyInitialLocaleChoice(settings, LOCALE_IDS.ZH_CN_PLAIN, { root, save })
    )));
    firstChoice.autofocus = true;
    addChoice('onboarding.traditional', () => finish(settings => (
        applyInitialLocaleChoice(settings, LOCALE_IDS.ZH_CN_AMILY, { root, save })
    )));
    addChoice('onboarding.dismiss', dismiss);
    dialog.appendChild(controls);
    const openDialog = () => {
        try {
            dialog.showModal();
            firstChoice.focus();
            return true;
        } catch (error) {
            cleanup();
            console.warn('[Amily2 i18n] Locale dialog unavailable; use the settings selector.', error);
            return false;
        }
    };
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        dismiss();
    });
    dialog.addEventListener('close', () => {
        if (closed) return;
        dismiss();
        if (!closed) openDialog();
    });
    const closeIfFinished = () => {
        if (!dialog.isConnected || !needsInitialLocaleChoice(getSettings())) cleanup();
    };
    onboardingDialogs.set(root, { dialog, closeIfFinished });
    unsubscribe = subscribeLocaleChange(closeIfFinished);
    applyTranslations(dialog);
    root.body.appendChild(dialog);

    return openDialog();
}
