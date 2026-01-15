import { eventSource, event_types } from '/script.js';

export const LOG_LEVELS = {
    DEBUG: 0b0001,
    INFO: 0b0010,
    WARN: 0b0100,
    ERROR: 0b1000,
    NONE: 0
};

class FilePipe {
    constructor(pluginName, bus) {
        this.pluginName = pluginName;
        this.bus = bus;
        this.basePath = `extensions/${pluginName}`; 
    }

    /**
     * 验证路径是否合法 (仅允许访问插件自己的目录)
     * @param {string} path 
     * @returns {boolean}
     */
    validatePath(path) {
        // 简单示例：防止 ../ 越权，并确保路径以 basePath 或允许的相对路径开头
        // 实际上 SillyTavern 的 writeFile API 通常已经限制在特定目录，
        // 但这里我们做逻辑层的隔离。
        if (path.includes('..')) {
            this.bus.log(this.pluginName, 'FilePipe', 'ERROR', `非法路径尝试: ${path}`);
            return false;
        }
        return true;
    }

    async read(fileName) {
        if (!this.validatePath(fileName)) throw new Error("Access Denied");
        // 这里对接实际的文件读取逻辑，例如 fetch 或 ST 的 API
        // return await readFileContent(this.basePath + '/' + fileName);
        console.log(`[Mock] Reading ${fileName} for ${this.pluginName}`);
    }

    async write(fileName, content) {
        if (!this.validatePath(fileName)) throw new Error("Access Denied");
        // 这里对接实际的文件写入逻辑
        // return await writeFileContent(this.basePath + '/' + fileName, content);
        console.log(`[Mock] Writing to ${fileName} for ${this.pluginName}`);
    }
}

class Amily2Bus {
    constructor() {
        this.plugins = new Map();
        this.logConfig = {
            globalLevel: LOG_LEVELS.INFO,
            filters: {} // e.g., "Amily2.Network": LOG_LEVELS.DEBUG
        };
        console.log("[Amily2-Bus] 总线系统初始化...");
    }

    /**
     * 注册插件
     * @param {Object} manifest - 必须包含 name 字段
     * @param {Object} instance - 插件实例或主要对象
     * @returns {FilePipe|null} - 返回专属的文件管线对象，注册失败返回 null
     */
    register(manifest, instance = {}) {
        if (!manifest || !manifest.name) {
            this.log('System', 'Bus', 'ERROR', '注册失败: 无效的 manifest');
            return null;
        }

        const name = manifest.name;
        if (this.plugins.has(name)) {
            this.log('System', 'Bus', 'WARN', `插件 ${name} 已注册，正在覆盖...`);
        }

        this.plugins.set(name, {
            manifest,
            instance,
            registeredAt: Date.now()
        });

        this.log('System', 'Bus', 'INFO', `插件注册成功: ${name}`);
        
        // 返回该插件专属的 FilePipe
        return new FilePipe(name, this);
    }

    /**
     * 获取已注册的插件实例
     * @param {string} name 
     */
    getPlugin(name) {
        return this.plugins.get(name)?.instance;
    }

    /**
     * 设置日志级别
     * @param {string} target - "Global" 或 "PluginName.ModuleName"
     * @param {string|number} level - "DEBUG", "INFO", etc.
     */
    setLogLevel(target, level) {
        const lvl = typeof level === 'string' ? LOG_LEVELS[level.toUpperCase()] : level;
        if (target === 'Global') {
            this.logConfig.globalLevel = lvl;
        } else {
            this.logConfig.filters[target] = lvl;
        }
    }

    /**
     * 统一日志方法
     * @param {string} plugin - 插件名
     * @param {string} module - 模块名
     * @param {string} level - 级别 (DEBUG, INFO, WARN, ERROR)
     * @param {string|Object} message - 内容
     */
    log(plugin, module, level, message) {
        const currentLevel = LOG_LEVELS[level.toUpperCase()] || LOG_LEVELS.INFO;
        const configKey = `${plugin}.${module}`;
        
        // 检查特定配置，如果没有则使用全局配置
        const requiredLevel = this.logConfig.filters[configKey] !== undefined 
            ? this.logConfig.filters[configKey] 
            : this.logConfig.globalLevel;

        if (currentLevel < requiredLevel) {
            return; // 级别不足，忽略
        }

        const timestamp = new Date().toLocaleTimeString();
        const formattedMsg = typeof message === 'object' ? JSON.stringify(message) : message;
        
        // 样式化输出
        let color = '#7f8c8d'; // Default (INFO)
        if (level === 'WARN') color = '#f39c12';
        if (level === 'ERROR') color = '#c0392b';
        if (level === 'DEBUG') color = '#3498db';

        console.log(
            `%c[${timestamp}] [${plugin}::${module}]%c ${formattedMsg}`,
            `color: ${color}; font-weight: bold;`,
            `color: inherit;`
        );
    }
}

// 单例模式，挂载到 window 方便全局调用
if (!window.Amily2Bus) {
    window.Amily2Bus = new Amily2Bus();
}

export default window.Amily2Bus;
