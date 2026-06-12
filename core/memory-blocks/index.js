/**
 * core/memory-blocks/index.js
 *
 * 记忆块工作流系统对外入口。导入此模块即触发：
 *   1. generator-handlers 加载 → 注册内置 'static' handler
 *   2. ai-call-handler 加载 → 注册 'ai_call' handler（Phase 2）
 *   3. registerBuiltinBlocks() → 注册首批内置块（sulv1-4）
 *   4. syncCustomBlocksFromSettings() → 重放用户自定义块（Phase 2）
 *
 * 两种组合范式：
 *   - 模板替换式（executor.js）：prompt 里挖空 placeholder，块填料 → 适合 sulv1-4
 *   - 顺序拼接式（chain.js）   ：块各自产出一段，按 order 拼接成完整注入块 →
 *                                适合记忆注入、战报底部块
 *
 * 公开 API：
 *   Block：
 *     register / unregister / getById / listByContext / listAll
 *     replaceContextBlocks (批量替换某 context 下全部块，JSON 导入用)
 *   Handler：
 *     registerHandler / unregisterHandler / getHandler / listHandlerTypes
 *   模板替换式：
 *     applyToTemplate(template, opts)
 *     applyToTemplates(templates, opts)   ← 多模板批处理首选
 *     generateBlockMap(opts)
 *   顺序拼接式：
 *     registerChain(def) / unregisterChain / getChain / listChains
 *     composeChain(chainId, opts) → string
 *     inspectChain(chainId, opts) → Array<{block, value}>（调试/自定义后处理）
 *   自定义块 CRUD（Phase 2，用户在 UI 增删改）：
 *     listCustomBlocks / getCustomBlock / addCustomBlock /
 *     updateCustomBlock / deleteCustomBlock / syncCustomBlocksFromSettings
 *     CUSTOM_ID_PREFIX / isCustomBlockId
 *
 * opts 字段：{ settings, signal?, extras? }
 *   （context 对应 chainId / Block.context，由各 API 自行传或从 chainId 推导）
 *
 * 设计目标：
 *   - BlockDefinition / ChainDefinition 都是纯数据，JSON 可序列化（Phase 3 用户自定义导入导出）
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

export {
    registerChain,
    unregisterChain,
    getChain,
    listChains,
    composeChain,
    inspectChain,
} from './chain.js';

export {
    CUSTOM_ID_PREFIX,
    isCustomBlockId,
    listCustomBlocks,
    getCustomBlock,
    addCustomBlock,
    updateCustomBlock,
    deleteCustomBlock,
    syncCustomBlocksFromSettings,
} from './custom-blocks.js';

import './ai-call-handler.js'; // 副作用：注册 'ai_call' handler
import { registerBuiltinBlocks } from './builtin-blocks.js';
import { syncCustomBlocksFromSettings } from './custom-blocks.js';

// 导入此模块即完成内置块注册与自定义块重放（均幂等）。
// ST 在 import 扩展脚本前已加载完 extension_settings，此时读取是安全的。
registerBuiltinBlocks();
syncCustomBlocksFromSettings();

export { registerBuiltinBlocks };
