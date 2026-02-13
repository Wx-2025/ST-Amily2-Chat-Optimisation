export class Module {
    constructor(builder) {
        if (!builder || typeof builder.build !== 'function') {
            throw new Error('[Module] Invalid builder.');
        }
        this.builder = builder;
        this.config = builder.build();
        this.ctx = null;
        this.el = null;
        this.viewEl = null;
        this._bindings = [];
        this._disposables = [];
        this._state = { ...(this.config.state || {}) };
    }

    async init(ctx = {}) {
        this.ctx = ctx;
        await this._loadView();
        this._bindAll();
        return this;
    }

    async mount() {
        if (this._isStrict('mount')) {
            this._abstract('mount');
        }
    }

    dispose() {
        if (this._isStrict('dispose')) {
            this._abstract('dispose');
        }
        this._unbindAll();
        for (const d of this._disposables) {
            try { d(); } catch (_) { /* noop */ }
        }
        this._disposables = [];
    }

    expose() {
        return {};
    }

    getState() {
        return { ...this._state };
    }

    setState(next) {
        if (!next || typeof next !== 'object') return;
        Object.assign(this._state, next);
        this._applyStateToBindings();
    }

    registerDisposable(fn) {
        if (typeof fn === 'function') {
            this._disposables.push(fn);
        }
    }

    _abstract(methodName) {
        throw new Error(`[Module] Method not implemented: ${methodName}`);
    }

    _isStrict(methodName) {
        if (!this.config.strict) return false;
        const required = this.config.requiredMethods || [];
        return required.includes(methodName);
    }

    async _loadView() {
        const viewPath = this.config.view;
        if (!viewPath) return;

        const rootTarget = this._resolveRoot();
        if (!rootTarget) {
            throw new Error('[Module] Root element not found.');
        }

        const url = this._resolveViewUrl(viewPath);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`[Module] Failed to load view: ${viewPath}`);
        }
        const html = await res.text();

        const wrapper = document.createElement('div');
        wrapper.className = this.config.wrapperClass || 'amily2-module';
        wrapper.dataset.module = this.config.name || 'Module';
        wrapper.innerHTML = html;

        rootTarget.appendChild(wrapper);
        this.el = wrapper;
        this.viewEl = wrapper;
    }

    _resolveRoot() {
        if (this.config.rootSelector) {
            return document.querySelector(this.config.rootSelector);
        }
        if (this.ctx && this.ctx.root instanceof HTMLElement) {
            return this.ctx.root;
        }
        return document.body;
    }

    _resolveViewUrl(viewPath) {
        if (/^(https?:)?\/\//.test(viewPath) || viewPath.startsWith('/')) {
            return viewPath;
        }
        if (this.ctx && this.ctx.baseUrl) {
            const baseUrl = this.ctx.baseUrl;
            const absoluteBase = /^(https?:)?\/\//.test(baseUrl)
                ? baseUrl
                : `${window.location.origin}/${String(baseUrl).replace(/^\/+/, '')}`;
            return new URL(viewPath, absoluteBase).toString();
        }
        return new URL(viewPath, import.meta.url).toString();
    }

    _bindAll() {
        this._bindVars();
        this._bindEvents();
    }

    _bindVars() {
        const bindings = this._normalizeBindings(this.config.bindVars);
        for (const [selector, spec] of Object.entries(bindings)) {
            const el = this._query(selector);
            if (!el) continue;

            const normalized = this._normalizeVarSpec(spec);
            const { key, attr, event, parser, formatter } = normalized;

            const applyValue = () => {
                const value = formatter ? formatter(this._state[key]) : this._state[key];
                if (attr === 'checked') {
                    el.checked = !!value;
                } else if (attr in el) {
                    el[attr] = value ?? '';
                } else {
                    el.setAttribute(attr, value ?? '');
                }
            };

            const onInput = (e) => {
                let value;
                if (attr === 'checked') {
                    value = e.target.checked;
                } else if (attr in e.target) {
                    value = e.target[attr];
                } else {
                    value = e.target.getAttribute(attr);
                }
                this._state[key] = parser ? parser(value) : value;
            };

            applyValue();
            el.addEventListener(event, onInput);
            this._bindings.push(() => el.removeEventListener(event, onInput));
        }
    }

    _bindEvents() {
        const bindings = this._normalizeBindings(this.config.bindEvents);
        for (const [selector, events] of Object.entries(bindings)) {
            const el = this._query(selector);
            if (!el) continue;

            for (const [eventName, handler] of Object.entries(events)) {
                const fn = typeof handler === 'function'
                    ? handler.bind(this)
                    : (this[handler] ? this[handler].bind(this) : null);
                if (!fn) continue;
                el.addEventListener(eventName, fn);
                this._bindings.push(() => el.removeEventListener(eventName, fn));
            }
        }
    }

    _applyStateToBindings() {
        const bindings = this._normalizeBindings(this.config.bindVars);
        for (const [selector, spec] of Object.entries(bindings)) {
            const el = this._query(selector);
            if (!el) continue;
            const normalized = this._normalizeVarSpec(spec);
            const { key, attr, formatter } = normalized;
            const value = formatter ? formatter(this._state[key]) : this._state[key];
            if (attr === 'checked') {
                el.checked = !!value;
            } else if (attr in el) {
                el[attr] = value ?? '';
            } else {
                el.setAttribute(attr, value ?? '');
            }
        }
    }

    _normalizeVarSpec(spec) {
        if (typeof spec === 'string') {
            return {
                key: spec,
                attr: 'value',
                event: 'input',
                parser: null,
                formatter: null,
            };
        }
        const attr = spec.attr || (spec.type === 'checkbox' ? 'checked' : 'value');
        const event = spec.event || (attr === 'checked' ? 'change' : 'input');
        return {
            key: spec.key,
            attr,
            event,
            parser: spec.parser || null,
            formatter: spec.formatter || null,
        };
    }

    _normalizeBindings(bindings) {
        if (!bindings) return {};
        if (Array.isArray(bindings)) {
            const out = {};
            for (const pair of bindings) {
                if (pair && typeof pair.selector === 'string') {
                    out[pair.selector] = pair.value;
                }
            }
            return out;
        }
        if (bindings && typeof bindings === 'object') {
            return bindings;
        }
        return {};
    }

    _query(selector) {
        if (!selector) return null;
        if (this.viewEl) {
            return this.viewEl.querySelector(selector);
        }
        return document.querySelector(selector);
    }

    _unbindAll() {
        for (const unbind of this._bindings) {
            try { unbind(); } catch (_) { /* noop */ }
        }
        this._bindings = [];
    }
}

export class ModuleBuilder {
    constructor() {
        this._config = {
            name: '',
            view: '',
            rootSelector: '',
            wrapperClass: '',
            strict: false,
            requiredMethods: [],
            bindVars: {},
            bindEvents: {},
            state: {},
        };
    }

    name(value) {
        this._config.name = value;
        return this;
    }

    view(path) {
        this._config.view = path;
        return this;
    }

    root(selector) {
        this._config.rootSelector = selector;
        return this;
    }

    wrapperClass(name) {
        this._config.wrapperClass = name;
        return this;
    }

    strict(flag = true) {
        this._config.strict = !!flag;
        return this;
    }

    required(methods = []) {
        this._config.requiredMethods = Array.isArray(methods) ? methods : [];
        return this;
    }

    state(initialState = {}) {
        this._config.state = { ...initialState };
        return this;
    }

    bindVar(map = {}) {
        this._config.bindVars = this._mergeBindings(this._config.bindVars, map);
        return this;
    }

    bindEvent(map = {}) {
        this._config.bindEvents = this._mergeBindings(this._config.bindEvents, map);
        return this;
    }

    build() {
        if (!this._config.name) {
            this._config.name = 'Module';
        }
        return { ...this._config };
    }

    _mergeBindings(current, next) {
        const base = Array.isArray(current) ? this._pairsToObject(current) : { ...(current || {}) };
        if (Array.isArray(next)) {
            return { ...base, ...this._pairsToObject(next) };
        }
        if (next && typeof next === 'object') {
            return { ...base, ...next };
        }
        return base;
    }

    _pairsToObject(pairs) {
        const out = {};
        for (const pair of pairs) {
            if (pair && typeof pair.selector === 'string') {
                out[pair.selector] = pair.value;
            }
        }
        return out;
    }
}

export default ModuleBuilder;

export class BindingPair {
    constructor(selector, value) {
        if (!selector || typeof selector !== 'string') {
            throw new Error('[BindingPair] selector must be a string.');
        }
        this.selector = selector;
        this.value = value;
    }
}
