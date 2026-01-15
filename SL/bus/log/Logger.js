/**
 * 日志总类，用于记录日志信息
 */
class Logger {

    static LOG_HEADER_DEBUG = '[DEBUG]';
    static LOG_HEADER_INFO = '[INFO]';
    static LOG_HEADER_WARN = '[WARN]';
    static LOG_HEADER_ERROR = '[ERROR]';

    static LEVEL_WEIGHTS = {
        'debug': 0,
        'info': 1,
        'warn': 2,
        'error': 3
    };

    constructor() {
        // 全局默认级别
        this.globalLevel = 'info';
        
        // 针对特定插件或模块的配置
        // 结构示例:
        // {
        //   "PluginA": "debug",             // PluginA 下所有模块默认为 debug
        //   "PluginB::ModuleX": "error"     // 仅 PluginB 下的 ModuleX 为 error
        // }
        this.levelConfig = {};
    }

    /**
     * 设置日志级别
     * @param {string} target 目标范围，可以是 'Global'、'PluginName' 或 'PluginName::ModuleName'
     * @param {string} level 'debug' | 'info' | 'warn' | 'error'
     */
    setLevel(target, level) {
        if (!Logger.LEVEL_WEIGHTS.hasOwnProperty(level)) {
            console.warn(`[Logger] Invalid log level: ${level}`);
            return;
        }

        if (target === 'Global') {
            this.globalLevel = level;
            console.log(`[Logger] Global log level set to: ${level}`);
        } else {
            this.levelConfig[target] = level;
            console.log(`[Logger] Log level for '${target}' set to: ${level}`);
        }
    }

    /**
     * 获取指定上下文的生效日志级别（级联查找）
     * @param {string} plugin 
     * @param {string} origin (Module)
     */
    _getEffectiveLevel(plugin, origin) {
        // 1. 检查精确匹配 "Plugin::Module"
        const specificKey = `${plugin}::${origin}`;
        if (this.levelConfig.hasOwnProperty(specificKey)) {
            return this.levelConfig[specificKey];
        }

        // 2. 检查插件级匹配 "Plugin"
        if (this.levelConfig.hasOwnProperty(plugin)) {
            return this.levelConfig[plugin];
        }

        // 3. 返回全局默认
        return this.globalLevel;
    }

    log(plugin, origin, type, message, inFile = false) {
        // 获取当前上下文生效的日志级别权重
        const effectiveLevelName = this._getEffectiveLevel(plugin, origin);
        const currentWeight = Logger.LEVEL_WEIGHTS[effectiveLevelName];
        
        const weight = Logger.LEVEL_WEIGHTS[type] !== undefined ? Logger.LEVEL_WEIGHTS[type] : 1;

        // 级别筛选
        if (weight < currentWeight) {
            return;
        }

        const timestamp = new Date().toLocaleTimeString();
        // 格式: [12:00:00] [PluginName::ClassName] [INFO]: message
        const fullMessage = `[${timestamp}] [${plugin}::${origin}] [${type.toUpperCase()}]: ${message}`;

        // 1. Console Output
        switch (type) {
            case 'debug':
                console.debug(fullMessage);
                break;
            case 'info':
                console.info(fullMessage);
                break;
            case 'warn':
                console.warn(fullMessage);
                break;
            case 'error':
                console.error(fullMessage);
                break;
            default:
                console.log(fullMessage);
                break;
        }

        // 2. File Output (via FilePipe)
        if (inFile) {
            // Logger 自身也需要作为系统组件注册，获取写入权限
            // 注意：为了性能，建议在 constructor 里注册一次保存起来，这里为了逻辑展示暂时简化
            if (!this.sysBus) {
                if (window.Amily2Bus && window.Amily2Bus.register) {
                    this.sysBus = window.Amily2Bus.register('SystemLogger');
                }
            }

            if (this.sysBus && this.sysBus.file) {
                // 使用注册后的安全接口写入，无需再手动传 'SystemLogger'
                // TODO: 这里的路径 'runtime.log' 后续可以做成配置项
                this.sysBus.file.write('runtime.log', fullMessage + '\n');
            } else {
                // Fallback: 如果总线未就绪，仅在控制台警告一次，避免死循环
                if (!this._warned) {
                    console.warn('[Logger] FilePipe system not linked. Log not saved to file.');
                    this._warned = true;
                }
            }
        }
    }

}

// Ensure Amily2Bus namespace exists to prevent crash if loaded out of order
window.Amily2Bus = window.Amily2Bus || {};
window.Amily2Bus.Logger = new Logger();

export default Logger;