/**
 * 日志总类，用于记录日志信息
 * 支持基于位运算的自定义日志级别控制
 */
class Logger {

    static LOG_HEADER_DEBUG = '[DEBUG]';
    static LOG_HEADER_INFO = '[INFO]';
    static LOG_HEADER_WARN = '[WARN]';
    static LOG_HEADER_ERROR = '[ERROR]';

    static LOG_LEVEL_CODE = {
        none: 0x0,  // 0
        debug: 0x1, // 1
        info: 0x2,  // 2
        warn: 0x4,  // 4
        error: 0x8, // 8
        all: 0xF // 15
    };

    constructor(safeConsole = null) {
        // 使用传入的 safeConsole，如果没有则回退到全局 console
        this.safeConsole = safeConsole || (typeof window !== 'undefined' ? window.console : console);
        // 全局默认级别 (默认开启 info, warn, error)
        this.globalLevel = Logger.LOG_LEVEL_CODE.info | Logger.LOG_LEVEL_CODE.warn | Logger.LOG_LEVEL_CODE.error;
        
        // 针对特定插件或模块的配置
        // 结构示例:
        // {
        //   "PluginA": 3,             // PluginA 下所有模块掩码为 3 (debug | info)
        //   "PluginB::ModuleX": 8     // 仅 PluginB 下的 ModuleX 掩码为 8 (error)
        // }
        this.levelConfig = {};
    }

    /**
     * 将输入转换为对应的日志级别掩码
     * @param {number|string|string[]} levelInput 
     * @returns {number} 掩码
     */
    _parseLevelInput(levelInput) {
        if (typeof levelInput === 'number') {
            return levelInput;
        }

        if (typeof levelInput === 'string') {
            if (Logger.LOG_LEVEL_CODE.hasOwnProperty(levelInput)) {
                return Logger.LOG_LEVEL_CODE[levelInput];
            }
            // 支持 "debug|info" 这种写法
            if (levelInput.includes('|')) {
                return levelInput.split('|').reduce((mask, l) => mask | (Logger.LOG_LEVEL_CODE[l.trim()] || 0), 0);
            }
            this.safeConsole.warn(`[Logger] Unknown log level string: ${levelInput}`);
            return 0;
        }

        if (Array.isArray(levelInput)) {
            return levelInput.reduce((mask, l) => mask | (Logger.LOG_LEVEL_CODE[l] || 0), 0);
        }

        return 0;
    }

    /**
     * 设置日志级别（覆盖模式）
     * @param {string} target 目标范围，可以是 'Global'、'PluginName' 或 'PluginName::ModuleName'
     * @param {number|string|string[]} level 输入的级别配置
     */
    setLevel(target, level) {
        const mask = this._parseLevelInput(level);

        if (target === 'Global') {
            this.globalLevel = mask;
            this.safeConsole.log(`[Logger] Global log level mask set to: ${mask.toString(2)}`);
        } else {
            this.levelConfig[target] = mask;
            this.safeConsole.log(`[Logger] Log level mask for '${target}' set to: ${mask.toString(2)}`);
        }
    }

    /**
     * 添加日志级别（增量模式）
     * @param {string} target 
     * @param {number|string|string[]} level 
     */
    addLevel(target, level) {
        const maskToAdd = this._parseLevelInput(level);
        let currentMask;

        if (target === 'Global') {
            currentMask = this.globalLevel;
            this.globalLevel = currentMask | maskToAdd;
            this.safeConsole.log(`[Logger] Added level to Global. New mask: ${this.globalLevel.toString(2)}`);
        } else {
            currentMask = this.levelConfig[target] !== undefined ? this.levelConfig[target] : this.globalLevel;
            this.levelConfig[target] = currentMask | maskToAdd;
            this.safeConsole.log(`[Logger] Added level to '${target}'. New mask: ${this.levelConfig[target].toString(2)}`);
        }
    }

    /**
     * 移除日志级别（减量模式）
     * @param {string} target 
     * @param {number|string|string[]} level 
     */
    removeLevel(target, level) {
        const maskToRemove = this._parseLevelInput(level);
        let currentMask;

        if (target === 'Global') {
            currentMask = this.globalLevel;
            // 使用 & ~mask 实现移除
            this.globalLevel = currentMask & ~maskToRemove;
            this.safeConsole.log(`[Logger] Removed level from Global. New mask: ${this.globalLevel.toString(2)}`);
        } else {
            currentMask = this.levelConfig[target] !== undefined ? this.levelConfig[target] : this.globalLevel;
            this.levelConfig[target] = currentMask & ~maskToRemove;
            this.safeConsole.log(`[Logger] Removed level from '${target}'. New mask: ${this.levelConfig[target].toString(2)}`);
        }
    }

    /**
     * 获取指定上下文的生效日志级别掩码（级联查找）
     * @param {string} plugin 
     * @param {string} origin (Module)
     */
    _getEffectiveLevelMask(plugin, origin) {
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

    /**
     * 标准日志处理方法 (Core Processing)
     * 统一处理过滤、格式化和输出，支持默认归属 Global
     */
    process(plugin, origin, type, message, inFile = false) {
        // [DEBUG] 强制输出以确认方法被调用 (使用 error 级别防止被过滤)
        // 【核心修改】：使用 safeConsole 替代全局 console
        this.safeConsole.error('[Logger DEBUG] Process called:', { plugin, origin, type, message });

        // 1. 默认归属处理
        const safePlugin = plugin || 'Global';
        const safeOrigin = origin || 'System';

        // 2. 获取当前上下文生效的日志级别掩码
        const effectiveMask = this._getEffectiveLevelMask(safePlugin, safeOrigin);
        
        // 3. 获取当前日志类型的位码
        const typeCode = Logger.LOG_LEVEL_CODE[type];

        // 4. 级别筛选：位与运算结果为0则表示该级别未开启
        if (typeCode === undefined || (effectiveMask & typeCode) === 0) {
            return;
        }

        const timestamp = new Date().toLocaleTimeString();
        // 格式: [12:00:00] [PluginName::ClassName] [INFO: message
        const fullMessage = `[${timestamp}] [${safePlugin}::${safeOrigin}] [${type.toUpperCase()}]: ${message}`;

        // 5. Console Output
        // 【核心修改】：使用 safeConsole 替代全局 console
        switch (type) {
            case 'debug':
                this.safeConsole.debug(fullMessage);
                break;
            case 'info':
                this.safeConsole.info(fullMessage);
                break;
            case 'warn':
                this.safeConsole.warn(fullMessage);
                break;
            case 'error':
                this.safeConsole.error(fullMessage);
                break;
            default:
                this.safeConsole.log(fullMessage);
                break;
        }

        // 6. File Output (via FilePipe)
        if (inFile) {
            // Logger 自身也需要作为系统组件注册，获取写入权限
            if (!this.sysBus) {
                if (window.Amily2Bus && window.Amily2Bus.register) {
                    this.sysBus = window.Amily2Bus.register('SystemLogger');
                }
            }

            if (this.sysBus && this.sysBus.file) {
                // 使用注册后的安全接口写入，无需再手动传 'SystemLogger'
                this.sysBus.file.write('runtime.log', fullMessage + '\n');
            } else {
                // Fallback: 如果总线未就绪，仅在控制台警告一次，避免死循环
                if (!this._warned) {
                    this.safeConsole.warn('[Logger] FilePipe system not linked. Log not saved to file.');
                    this._warned = true;
                }
            }
        }
    }

    log(plugin, origin, type, message, inFile = false) {
        this.process(plugin, origin, type, message, inFile);
    }

}

export default Logger;