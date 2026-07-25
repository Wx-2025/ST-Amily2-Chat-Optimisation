/**
 * SL/bus/tool/ToolRegistry.js — Bus 工具注册表（Phase A）
 *
 * 历史 Phase A 的 function-call 工具集合实现。当前不再接入全局 Amily2Bus；
 * 若后续复用，只能由内部受控模型任务代理持有并执行。
 *
 * 设计约束：
 *   - 完全 per-plugin 私有：Map<pluginName, Map<toolName, { def, handler }>>。
 *     不跨插件查询、不共享——A 插件看不到也调不到 B 插件的工具。
 *   - def 为标准 OpenAI tool schema（{ type:'function', function:{ name, description, parameters } }）。
 *     define 时只需传 { description, parameters }，name 由参数给出，本类负责包成完整 schema。
 *   - 纯存储 + dispatch，不涉及网络与 loop（那是 ModelCaller 的职责）。
 */

export default class ToolRegistry {
    constructor() {
        /** @type {Map<string, Map<string, { def: Object, handler: Function }>>} */
        this._plugins = new Map();
    }

    /** 取得（必要时创建）某插件的工具表 */
    _bucket(pluginName) {
        let bucket = this._plugins.get(pluginName);
        if (!bucket) {
            bucket = new Map();
            this._plugins.set(pluginName, bucket);
        }
        return bucket;
    }

    /**
     * 定义一个工具。
     * @param {string} pluginName
     * @param {string} name 工具名（function name，需在本插件内唯一）
     * @param {{ description?: string, parameters?: Object }} schema JSONSchema 描述
     * @param {(args: Object) => (any|Promise<any>)} handler 收到 tool_call 时执行，返回值作为 tool result 回喂
     * @returns {boolean}
     */
    define(pluginName, name, schema, handler) {
        if (!name || typeof name !== 'string') {
            throw new Error('[ToolRegistry] tool name must be a non-empty string.');
        }
        if (typeof handler !== 'function') {
            throw new Error(`[ToolRegistry] handler for tool "${name}" must be a function.`);
        }
        const def = {
            type: 'function',
            function: {
                name,
                description: schema?.description ?? '',
                parameters: schema?.parameters ?? { type: 'object', properties: {} },
            },
        };
        this._bucket(pluginName).set(name, { def, handler });
        return true;
    }

    /**
     * 移除一个工具。
     * @returns {boolean} 是否确实删除了
     */
    undefine(pluginName, name) {
        return this._bucket(pluginName).delete(name);
    }

    /**
     * 列出某插件已定义的工具名。
     * @returns {string[]}
     */
    list(pluginName) {
        return Array.from(this._bucket(pluginName).keys());
    }

    /**
     * 取某插件的全部工具 schema 数组（喂给 request 的 tools 字段）。
     * @returns {Object[]} 标准 OpenAI tool def 列表
     */
    getToolDefs(pluginName) {
        return Array.from(this._bucket(pluginName).values()).map(t => t.def);
    }

    /**
     * 是否有可用工具。
     * @returns {boolean}
     */
    has(pluginName) {
        const bucket = this._plugins.get(pluginName);
        return !!bucket && bucket.size > 0;
    }

    /**
     * 派发一次 tool_call 到对应 handler。
     * 找不到工具时抛错（由 loop 决定是否当作 onToolError 回喂）。
     * @param {string} pluginName
     * @param {string} name
     * @param {Object} args 已解析的参数对象
     * @returns {Promise<any>}
     */
    async dispatch(pluginName, name, args) {
        const entry = this._bucket(pluginName).get(name);
        if (!entry) {
            throw new Error(`Tool "${name}" is not defined for plugin "${pluginName}".`);
        }
        return await entry.handler(args ?? {});
    }
}
