import Logger from './log/Logger.js';
import FilePipe from './file/FilePipe.js';

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
        /** @type {Logger|null} */
        this.Logger = new Logger();
        /** @type {FilePipe|null} */
        this.FilePipe = new FilePipe();
        
        // 已注册插件列表，防止重复注册
        this.registry = new Set();

        this.safeConsole.log('[Amily2Bus] Core container initialized with secure registry.');
    }

    /**
     * 直接记录系统级日志 (Global Scope)
     * 支持手动指定来源，方便终端调试或非插件环境调用
     * @param {string} type 日志级别 (debug, info, warn, error)
     * @param {string} message 消息内容
     * @param {string} [origin='Bus'] 来源模块，默认为 'Bus'
     * @param {string} [plugin='Global'] 来源插件/命名空间，调试时可指定如 'Console'
     */
    log(type, message, origin = 'Bus', plugin = 'Global') {
        this.safeConsole.error('[Amily2Bus DEBUG] log called (via SafeConsole):', { type, loggerExists: !!this.Logger });
        if (this.Logger) {
            this.Logger.process(plugin, origin, type, message);
        }
    }

    /**
     * 注册插件并获取专属上下文
     * @param {string} pluginName 插件名称
     * @returns {Object} 包含该插件专属 API 的上下文对象
     */
    register(pluginName) {
        if (!pluginName || typeof pluginName !== 'string') {
            throw new Error('[Amily2Bus] Invalid plugin name.');
        }

        if (this.registry.has(pluginName)) {
            console.warn(`[Amily2Bus] Plugin '${pluginName}' is already registered.`);
        } else {
            this.registry.add(pluginName);
            console.log(`[Amily2Bus] Plugin registered: ${pluginName}`);
        }

        // 返回该插件专属的 API 上下文 (Capability Token)
        return {
            // 绑定了身份的日志接口
            log: (origin, type, message) => {
                if (this.Logger) {
                    // 自动填充 plugin 参数
                    this.Logger.log(pluginName, origin, type, message);
                }
            },
            
            // 绑定了身份的文件接口
            file: {
                read: (path) => {
                    return this.FilePipe ? this.FilePipe.read(pluginName, path) : null;
                },
                write: (path, data) => {
                    return this.FilePipe ? this.FilePipe.write(pluginName, path, data) : false;
                }
            }
        };
    }
}
// 挂载全局单例 (自动初始化)
if (!window.Amily2Bus || !(window.Amily2Bus instanceof Amily2Bus)) {
    window.Amily2Bus = new Amily2Bus();
}

export function initializeAmilyBus() {
    if (!window.Amily2Bus || !(window.Amily2Bus instanceof Amily2Bus)) {
        window.Amily2Bus = new Amily2Bus();
        console.log('[Amily2] Amily2Bus 已成功初始化并附加到 window 对象');
    }
}