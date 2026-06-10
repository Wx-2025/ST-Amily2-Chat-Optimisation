/**
 * core/memory-blocks/types.js — 类型契约（JSDoc 文档，无运行时代码）
 *
 * BlockDefinition 是工作流的最小单位，描述"如何为某个占位符产出内容"。
 * 所有字段必须 JSON 可序列化，为后续支持 JSON 导入导出做准备。
 *
 * 生成器（generator）只承载"用哪个 handler、参数是什么"的元数据，
 * 真正的执行逻辑由 generator-handlers.js 按 type 查表的 handler 函数承担，
 * 因此 BlockDefinition 本身永远不持有函数引用、可直接 JSON.stringify。
 */

/**
 * @typedef {Object} StaticGenerator 直接读取 settings 或常量值
 * @property {'static'} type
 * @property {string} [valueKey]    - 从 ctx.settings[valueKey] 读取
 * @property {*}      [defaultValue]- valueKey 不存在/为空时的兜底
 * @property {*}      [value]       - 硬编码值，优先级高于 valueKey
 */

/**
 * @typedef {Object} AiCallGenerator (Phase 2 预留)
 * @property {'ai_call'} type
 * @property {string} apiSlot
 * @property {string} promptTemplate
 * @property {string} [extractTag]
 */

/**
 * @typedef {Object} PluginGenerator (Phase 3 预留：战斗模块走这条)
 * @property {'plugin'} type
 * @property {string} handlerKey   - 在 handler 注册表里查 handler 函数
 * @property {Object} [params]
 */

/** @typedef {StaticGenerator | AiCallGenerator | PluginGenerator} GeneratorSpec */

/**
 * @typedef {Object} BlockDefinition
 * @property {string} id              - 全局唯一
 * @property {string} placeholder     - 在模板中要被替换的占位符（按字面量匹配，正则元字符自动转义）
 * @property {string} context         - 所属流水线，如 'plotOptimization'
 * @property {GeneratorSpec} generator
 * @property {string}  [name]         - UI 显示名
 * @property {boolean} [enabled=true]
 * @property {number}  [order]        - 仅影响 listByContext 的返回顺序；执行并发，不阻塞
 */

/**
 * @typedef {Object} ExecuteContext
 * @property {Object} settings        - extension_settings[extensionName]
 * @property {AbortSignal} [signal]   - 来自调用方的中断信号
 * @property {string} context
 * @property {Object} [extras]        - 额外上下文，供 handler 自取
 */

export {};
