/**
 * core/memory-blocks/index.js
 *
 * 记忆块工作流系统对外入口。导入此模块即触发：
 *   1. generator-handlers 加载 → 注册内置 'static' handler
 *   2. registerBuiltinBlocks() → 注册首批内置块（sulv1-4）
 *
 * 公开 API：
 *   - register / unregister / getById / listByContext / listAll
 *   - registerHandler / getHandler / listHandlerTypes
 *   - applyToTemplate(template, opts)
 *   - applyToTemplates(templates, opts)  ← 多模板批处理首选
 *   - generateBlockMap(opts)
 *
 * opts 字段：{ context, settings, signal?, extras? }
 *
 * 设计目标：
 *   - BlockDefinition 纯数据，可 JSON 序列化（Phase 3 用户自定义导入导出）
 *   - generator 通过 type 查表，handler 集中注册，便于扩展 ai_call / plugin
 *   - 同一 context 下的块 Promise.all 并发；任一块抛 AbortError 整体中断
 */

export {
    register,
    unregister,
    getById,
    listByContext,
    listAll,
    clear,
    replaceContextBlocks,
} from './registry.js';

export {
    registerHandler,
    unregisterHandler,
    getHandler,
    listHandlerTypes,
} from './generator-handlers.js';

export {
    applyToTemplate,
    applyToTemplates,
    generateBlockMap,
} from './executor.js';

import { registerBuiltinBlocks } from './builtin-blocks.js';

// 导入此模块即完成内置块注册（幂等）
registerBuiltinBlocks();

export { registerBuiltinBlocks };
