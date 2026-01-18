/**
 * ModelCaller 请求配置类
 * 支持构造函数直接传入对象，或使用 Builder 链式调用
 */
export class Options {
    constructor(config = {}) {
        /** @type {'direct'|'preset'} */
        this.mode = config.mode || 'direct';
        /** @type {boolean} */
        this.fakeStream = config.fakeStream ?? false;
        /** @type {string} */
        this.apiUrl = config.apiUrl || '';
        /** @type {string} */
        this.apiKey = config.apiKey || '';
        /** @type {string} */
        this.model = config.model || '';
        /** @type {string} */
        this.presetId = config.presetId || '';
        /** @type {number} */
        this.maxTokens = config.maxTokens || 4000;
        /** @type {number} */
        this.temperature = config.temperature || 0.7;
        /** @type {Object} 额外透传参数 */
        this.params = config.params || {};
    }

    /**
     * 获取 Builder 实例
     * @returns {OptionsBuilder}
     */
    static builder() {
        return new OptionsBuilder();
    }
}

/**
 * Options 构建器类
 */
class OptionsBuilder {
    constructor() {
        this.config = {};
    }

    setMode(mode) {
        this.config.mode = mode;
        return this;
    }

    setFakeStream(enabled) {
        this.config.fakeStream = enabled;
        return this;
    }

    setApiUrl(url) {
        this.config.apiUrl = url;
        return this;
    }

    setApiKey(key) {
        this.config.apiKey = key;
        return this;
    }

    setModel(model) {
        this.config.model = model;
        return this;
    }

    setPresetId(id) {
        this.config.presetId = id;
        return this;
    }

    setMaxTokens(tokens) {
        this.config.maxTokens = tokens;
        return this;
    }

    setTemperature(temp) {
        this.config.temperature = temp;
        return this;
    }

    setParams(params) {
        this.config.params = { ...(this.config.params || {}), ...params };
        return this;
    }

    /**
     * 构建最终的 Options 对象
     * @returns {Options}
     */
    build() {
        return new Options(this.config);
    }
}

export default Options;