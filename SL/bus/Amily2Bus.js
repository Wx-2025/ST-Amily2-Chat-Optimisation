import Logger from './log/Logger.js';
import FilePipe from './file/FilePipe.js';
import ModelCaller from './api/ModelCaller.js';
import Options from './api/Options.js';

// 【逃生通道】创建一个纯净的 Console 对象，绕过任何潜在的劫持
const getSafeConsole = () => {
    try {
        if (window._amilySafeConsole) return window._amilySafeConsole;
        
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        const safe = iframe.contentWindow.console;
        // document.body.removeChild(iframe); // 保持 iframe 以维持 console 引用有效
        window._amilySafeConsole = safe;
        return safe;
    } catch (e) {
        return window.console; // Fallback
    }
};

class Amily2Bus {
    constructor() {
        this.safeConsole = getSafeConsole();

        // 1. 初始化 Logger
        /** @type {Logger} */
        this.Logger = new Logger(this.safeConsole);
        /** @type {FilePipe} */
        this.FilePipe = new FilePipe();

        // 2. 依赖注入 (Dependency Injection)
        // 创建一个 Logger 代理适配器传给 ModelCaller
        const loggerDelegate = {
            log: (type, message, origin, plugin) => {
                // 回调 Bus 的 Logger 实例
                this.Logger.process(plugin || 'Global', origin || 'Model', type, message);
            }
        };

        // ModelCaller 不再包含 Bus，只包含 logger 代理
        /** @type {ModelCaller} */
        this.ModelCaller = new ModelCaller(loggerDelegate);

        // 存储上下文引用（严格锁：每个插件名仅限一次成功注册）
        this.registry = new Map();
        // 存储公开的联动接口（联动模块）
        this.publicRegistry = new Map();

        this.safeConsole.log('[Amily2Bus] Core Initialized (Decoupled Architecture).');

        // 3. 自动注册并锁定 PUBLIC 命名空间
        this._initPublicNamespace();
        this.register('Amily2');
    }

    /**
     * 初始化系统保留的 PUBLIC 模块
     * 用于提供系统级信息的联动查询，防止 PUBLIC 命名被滥用
     */
    _initPublicNamespace() {
        try {
            // 这里利用 register 的机制，直接抢占 'PUBLIC' 并加上严格锁
            const sysCtx = this.register('PUBLIC');

            // 暴露系统级能力给 query('PUBLIC')
            sysCtx.expose({
                description: 'Amily2 System Public Interface',
                version: '2.0.0-Core',

                // 允许查询当前有哪些插件暴露了公共接口
                getAvailableModules: () => {
                    return Array.from(this.publicRegistry.keys());
                },

                // 允许查询当前所有已注册（被锁定的）插件名
                getRegisteredPlugins: () => {
                    return Array.from(this.registry.keys());
                },

                // 简单的系统状态检查
                ping: () => 'pong'
            });

            // 内部记录一条初始化日志
            sysCtx.log('System', 'info', 'PUBLIC namespace reserved and strictly locked.');

        } catch (e) {
            this.safeConsole.error('[Amily2Bus] CRITICAL: Failed to init PUBLIC namespace.', e);
        }
    }
    /**
     * 直接记录系统级日志 (Global Scope)
     * 支持手动指定来源，方便终端调试或非插件环境调用
     * @param {string} type 日志级别 (debug, info, warn, error)
     * @param {string} message 消息内容
     * @param {string} [origin='Bus' 来源模块，默认为 'Bus'
     * @param {string} [plugin='Global'] 来源插件/命名空间，调试时可指定如 'Console'
     */
    log(type, message, origin = 'Bus', plugin = 'Global') {
        if (this.Logger) {
            this.Logger.process(plugin, origin, type, message);
        }
    }
    /**
     * 注册插件并获取专属上下文 (严格锁机制)
     * @param {string} pluginName 插件名称
     * @returns {Object} 包含该插件专属 API 的上下文对象
     */
    register(pluginName) {
        if (!pluginName || typeof pluginName !== 'string') {
            throw new Error('[Amily2Bus] Invalid plugin name.');
        }

        if (this.registry.has(pluginName)) {
            const errorMsg = `[Amily2Bus] Security Error: Plugin '${pluginName}' is already registered and locked.`;
            this.safeConsole.error(errorMsg);
            throw new Error(errorMsg);
        }

        // 返回该插件专属的 API 上下文 (Capability Token)
        const context = {
            // 1. 日志能力 (绑定了身份的日志接口)
            log: (origin, type, message) => this.Logger.log(pluginName, origin, type, message),

            // 2. 文件能力 (绑定了身份的文件接口)
            file: {
                read: (path) => {
                    return this.FilePipe ? this.FilePipe.read(pluginName, path) : null;
                },
                write: (path, data) => {
                    return this.FilePipe ? this.FilePipe.write(pluginName, path, data) : false;
                }
            },

            // 3. 网络能力 (ModelCaller)
            model: {
                // 暴露 Options 类，方便插件直接 new context.model.Options() 或使用 builder
                Options: Options,
                // 插件调用时，Bus 负责将 pluginName 传给无状态的 ModelCaller
                call: (messages, options) => this.ModelCaller.call(pluginName, messages, options)
            },

            /**
             * 将本插件的能力暴露给公共查询池，实现插件间联动
             * @param {Object} apiMethods
             */
            expose: (apiMethods) => {
                if (typeof apiMethods !== 'object') throw new Error('Exposed API must be an object');
                this.publicRegistry.set(pluginName, Object.freeze(apiMethods));
                this.log('info', `Module exposed to public registry.`, 'Bus', pluginName);
            }
        };

        this.registry.set(pluginName, context);
        this.safeConsole.log(`[Amily2Bus] Plugin registered: ${pluginName}`);
        return context;
    }

    /**
     * 联动查询：获取其他插件通过 expose 暴露的能力
     * @param {string} pluginName 目标插件名称
     * @returns {Object|null}
     */
    query(pluginName) {
        return this.publicRegistry.get(pluginName) || null;
    }
}
// 挂载全局单例
if (!window.Amily2Bus) {
    window.Amily2Bus = new Amily2Bus();
}
export function initializeAmilyBus() {
    if (!(window.Amily2Bus instanceof Amily2Bus)) {
        window.Amily2Bus = new Amily2Bus();
        console.log('[Amily2] Amily2Bus 已成功初始化并附加到 window 对象');
    }
}

