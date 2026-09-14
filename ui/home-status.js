import { pluginAuthStatus, subscribePluginAuthStatus } from '../utils/auth-state.js';
import { registry } from '../SL/module/ModuleRegistry.js';
import { isActiveChatContext } from '../core/utils/chat-context-state.js';
import { getLocale, normalizeLocale, subscribeLocaleChange, t } from '../utils/i18n/index.js';
import { PLAIN, TRADITIONAL, EN } from '../utils/i18n/messages/home-status.js';

const CACHE_KEYS = Object.freeze(['plugin_activated', 'plugin_valid_until', 'plugin_user_type']);
const MAX_TIMEOUT = 2 ** 31 - 1;
const mountedPanels = new WeakMap();
const MODULE_LABELS = Object.freeze({
    AdditionalFeatures: 'nav.summary',
    Historiography: 'nav.textOptimization',
    Hanlinyuan: 'nav.vector',
    Table: 'nav.tables',
    PlotOptimization: 'homeStatus.module.plot',
    CharacterWorldBook: 'nav.characterWorld',
    WorldEditor: 'nav.worldEditor',
    Glossary: 'nav.glossary',
    Renderer: 'nav.renderer',
    SuperMemory: 'nav.superMemory',
    ProgressiveMemory: 'nav.progressiveMemory',
    TimeRiver: 'nav.timeRiver',
    Combat: 'homeStatus.module.combat',
    ApiConfig: 'nav.apiConfig',
    SecurityAudit: 'nav.cardSecurity',
    RuleConfig: 'nav.ruleConfig',
    SfiGen: 'nav.imageGeneration',
});

function message(key, params = {}, locale = getLocale()) {
    const normalized = normalizeLocale(locale);
    const catalog = normalized === 'en-US' ? EN
        : normalized === 'zh-CN-amily' ? TRADITIONAL : PLAIN;
    const template = Object.hasOwn(catalog, key) ? catalog[key] : PLAIN[key];
    if (typeof template !== 'string') return t(key, params, locale);
    return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, name) => (
        Object.hasOwn(params, name) ? String(params[name]) : match
    ));
}

function readPermission(authState) {
    try {
        const { authorized, expired, userType } = authState;
        if (typeof authorized !== 'boolean' || typeof expired !== 'boolean'
            || !Number.isSafeInteger(userType) || userType < 0 || userType > 4) {
            return Object.freeze({ state: 'unknown', level: null });
        }
        const state = expired ? 'expired' : authorized ? 'active' : 'inactive';
        return Object.freeze({ state, level: state === 'active' ? userType : null });
    } catch {
        return Object.freeze({ state: 'unknown', level: null });
    }
}

function readCapabilities(environment) {
    try {
        if (environment.isSecureContext === false) return 'insecure';
        if (environment.isSecureContext !== true) return 'unknown';
        const crypto = environment.crypto;
        const methods = ['digest', 'generateKey', 'importKey', 'exportKey', 'encrypt', 'decrypt'];
        return typeof crypto?.getRandomValues === 'function'
            && methods.every(key => typeof crypto?.subtle?.[key] === 'function') ? 'ready' : 'limited';
    } catch {
        return 'unknown';
    }
}

function readModules(moduleRegistry) {
    try {
        const names = moduleRegistry.names();
        if (!Array.isArray(names) || names.length > 64
            || names.some(name => typeof name !== 'string' || !Object.hasOwn(MODULE_LABELS, name))
            || new Set(names).size !== names.length) throw new TypeError('Invalid registry');
        const items = names.map(name => {
            let state = 'unknown';
            try {
                // getInstance reads the registry; query() would execute expose().
                state = moduleRegistry.getInstance(name) ? 'mounted' : 'pending';
            } catch { /* Keep a failed read distinct from an unmounted module. */ }
            return Object.freeze({ name, state });
        });
        const mounted = items.filter(item => item.state === 'mounted').length;
        return Object.freeze({
            state: !items.length ? 'empty' : mounted === items.length ? 'ready' : 'partial',
            mounted, total: items.length, items: Object.freeze(items),
        });
    } catch {
        return Object.freeze({ state: 'unknown', mounted: 0, total: 0, items: Object.freeze([]) });
    }
}

function readCache(environment, permission, now) {
    const result = (state, expiresAt = null) => Object.freeze({ state, expiresAt });
    try {
        const storage = environment.localStorage;
        const activated = storage.getItem(CACHE_KEYS[0]);
        if (activated !== 'true') return result(activated == null || activated === 'false' ? 'absent' : 'invalid');
        const expiry = storage.getItem(CACHE_KEYS[1]);
        const level = storage.getItem(CACHE_KEYS[2]);
        if (level === null || !/^[0-4]$/.test(level)) return result('invalid');
        let expiresAt = null;
        if (expiry !== null) {
            // auth.js persists ISO timestamps via toISOString(), never free-form text.
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiry)) return result('invalid');
            expiresAt = Date.parse(expiry);
            if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expiry) return result('invalid');
            if (now > expiresAt) return result('expired', expiresAt);
        }
        if (permission.state !== 'active') return result('inactive', expiresAt);
        if (Number(level) !== permission.level) return result('mismatch', expiresAt);
        return result(expiresAt === null ? 'no-expiry' : 'valid', expiresAt);
    } catch {
        return result('unavailable');
    }
}

function readChat(getContext) {
    try {
        const context = getContext?.();
        if (!context || typeof context !== 'object') return 'unknown';
        if (!isActiveChatContext(context)) return 'none';
        return Array.isArray(context.chat) ? 'available' : 'pending';
    } catch {
        return 'unknown';
    }
}

/** Read only. No host context, module instance, storage value or error is retained. */
export function readHomeStatus({
    authState = pluginAuthStatus,
    moduleRegistry = registry,
    environment = globalThis,
    getContext,
    now = Date.now(),
} = {}) {
    const permission = readPermission(authState);
    return Object.freeze({
        permission,
        secure: readCapabilities(environment),
        modules: readModules(moduleRegistry),
        cache: readCache(environment, permission, now),
        chat: readChat(getContext),
    });
}

/**
 * Mount into a dedicated home slot after registry.mountAll(). The parent supplies
 * getContext/eventSource/eventTypes from the host imports and calls refresh()
 * after same-level authorization renewal and module lifecycle changes.
 */
export function mountHomeStatus(container, {
    getContext,
    eventSource,
    eventTypes = {},
    environment = globalThis,
    moduleRegistry = registry,
    authState = pluginAuthStatus,
    subscribeAuthorization = subscribePluginAuthStatus,
    subscribeLocale = subscribeLocaleChange,
    now = Date.now,
    scheduleTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancelTimeout = timer => globalThis.clearTimeout(timer),
} = {}) {
    if (!container?.ownerDocument?.createElement) throw new TypeError('A home status container is required.');
    mountedPanels.get(container)?.dispose();
    const document = container.ownerDocument;
    const cleanups = [];
    let disposed = false;
    let expiryTimer = null;
    let expiryGeneration = 0;
    let latestSnapshot = null;

    function element(tag, className, parent) {
        const node = document.createElement(tag);
        node.className = className;
        parent?.appendChild(node);
        return node;
    }
    function listen(target, event, handler) {
        if (!target?.addEventListener || !target?.removeEventListener) return;
        target.addEventListener(event, handler);
        cleanups.push(() => target.removeEventListener(event, handler));
    }
    const root = element('details', 'amily2-home-status', container);
    const header = element('summary', 'amily2-home-status__header', root);
    const chevron = element('i', 'fa-solid fa-chevron-right amily2-home-status__chevron', header);
    chevron.setAttribute('aria-hidden', 'true');
    const title = element('span', 'amily2-home-status__title', header);
    const button = element('button', 'menu_button amily2-home-status__refresh', header);
    button.type = 'button';
    const icon = element('i', 'fa-solid fa-rotate-right', button);
    icon.setAttribute('aria-hidden', 'true');
    const list = element('dl', 'amily2-home-status__list', root);
    list.setAttribute('aria-live', 'polite');
    const rows = {};
    for (const key of ['permission', 'secure', 'modules', 'cache', 'chat']) {
        const row = element('div', 'amily2-home-status__row', list);
        rows[key] = {
            label: element('dt', 'amily2-home-status__label', row),
            value: element('dd', 'amily2-home-status__value', row),
        };
    }
    const note = element('p', 'amily2-home-status__note', root);
    const details = element('details', 'amily2-home-status__details', root);
    const summary = element('summary', '', details);
    const moduleList = element('ul', 'amily2-home-status__modules', details);

    function render(snapshot) {
        const tr = (key, params) => message(key, params);
        title.textContent = tr('homeStatus.title');
        root.setAttribute('aria-label', title.textContent);
        button.title = tr('homeStatus.refresh');
        button.setAttribute('aria-label', button.title);
        for (const [key, row] of Object.entries(rows)) {
            const status = snapshot[key];
            const state = typeof status === 'string' ? status : status.state;
            const params = key === 'cache' && status.expiresAt !== null
                ? { expiry: new Date(status.expiresAt).toLocaleString(getLocale() === 'en-US' ? 'en-US' : 'zh-CN') }
                : status;
            row.label.textContent = tr(`homeStatus.${key}`);
            row.value.textContent = tr(`homeStatus.${key}.${state}`, params);
            row.value.setAttribute('data-state', state);
        }
        note.textContent = tr('homeStatus.cache.note');
        summary.textContent = tr('homeStatus.modules.detail');
        moduleList.replaceChildren();
        for (const item of snapshot.modules.items) {
            const li = element('li', 'amily2-home-status__module', moduleList);
            element('span', '', li).textContent = tr(MODULE_LABELS[item.name]);
            const state = element('span', '', li);
            state.textContent = tr(`homeStatus.module.${item.state}`);
            state.setAttribute('data-state', item.state);
        }
        details.hidden = snapshot.modules.items.length === 0;
    }

    function clearExpiryTimer() {
        expiryGeneration += 1;
        if (expiryTimer !== null) cancelTimeout(expiryTimer);
        expiryTimer = null;
    }
    function armExpiry(expiresAt) {
        if (expiresAt === null) return;
        const generation = expiryGeneration;
        // Only a known deadline wakes this timer. Long deadlines are split to
        // avoid the platform timeout overflow, without polling any status source.
        const waitForDeadline = () => {
            if (disposed || generation !== expiryGeneration) return;
            const delay = expiresAt - now() + 1;
            if (delay <= 0) {
                expiryTimer = null;
                refresh();
                return;
            }
            expiryTimer = scheduleTimeout(waitForDeadline, Math.min(MAX_TIMEOUT, delay));
        };
        waitForDeadline();
    }
    function refresh() {
        if (disposed) return null;
        clearExpiryTimer();
        const snapshot = readHomeStatus({ authState, moduleRegistry, environment, getContext, now: now() });
        // Compare only detached, redacted snapshots; no chat/auth event payloads.
        if (JSON.stringify(snapshot) !== JSON.stringify(latestSnapshot)) render(snapshot);
        latestSnapshot = snapshot;
        if (snapshot.cache.state !== 'expired') armExpiry(snapshot.cache.expiresAt);
        return latestSnapshot;
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        clearExpiryTimer();
        for (const cleanup of cleanups.splice(0)) {
            try { cleanup(); } catch { /* Continue disposing the remaining listeners. */ }
        }
        latestSnapshot = null;
        root.remove();
        if (mountedPanels.get(container) === controller) mountedPanels.delete(container);
    }
    const controller = Object.freeze({ refresh, dispose });
    mountedPanels.set(container, controller);
    try {
        const authCleanup = subscribeAuthorization(() => refresh());
        if (typeof authCleanup === 'function') cleanups.push(authCleanup);
        const localeCleanup = subscribeLocale(() => {
            latestSnapshot = null;
            refresh();
        });
        if (typeof localeCleanup === 'function') cleanups.push(localeCleanup);
        listen(button, 'click', event => {
            event.preventDefault();
            event.stopPropagation();
            refresh();
        });
        listen(root, 'toggle', () => {
            if (root.open) refresh();
        });
        listen(environment, 'focus', () => refresh());
        listen(environment, 'pageshow', () => refresh());
        listen(document, 'visibilitychange', () => {
            if (document.visibilityState !== 'hidden') refresh();
        });
        listen(environment, 'storage', event => {
            if (event.key === null || CACHE_KEYS.includes(event.key)) refresh();
        });
        const removeEvent = eventSource?.off ?? eventSource?.removeListener;
        if (typeof eventSource?.on === 'function' && typeof removeEvent === 'function') {
            const events = new Set(['CHAT_CHANGED', 'CHAT_CREATED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED']
                .map(key => eventTypes[key]).filter(event => typeof event === 'string' && event));
            for (const event of events) {
                const handler = () => refresh();
                eventSource.on(event, handler);
                cleanups.push(() => removeEvent.call(eventSource, event, handler));
            }
        }
        refresh();
    } catch (error) {
        dispose();
        throw error;
    }
    return controller;
}
