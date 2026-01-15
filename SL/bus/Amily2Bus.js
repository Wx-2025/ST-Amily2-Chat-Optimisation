class Amily2Bus {
    constructor() {
        /** @type {Logger|null} */
        this.Logger = null;
        /** @type {FilePipe|null} */
        this.FilePipe = null;
        
        // 已注册插件列表，防止重复注册
        this.registry = new Set();

        console.log('[Amily2Bus] Core container initialized with secure registry.');
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

// 挂载全局单例
if (!window.Amily2Bus) {
    window.Amily2Bus = new Amily2Bus();
}

export function initializeAmilyBus() {
    if (!window.Amily2Bus) {
        window.Amily2Bus = new Amily2Bus();
        console.log('[Amily2] Amily2Bus 已成功初始化并附加到 window 对象');
    }
}