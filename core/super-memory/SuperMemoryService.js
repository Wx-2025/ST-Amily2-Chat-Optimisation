/**
 * SuperMemoryService
 * 超级记忆 Bus 服务 — 统一对外入口
 *
 * 职责：
 *   1. 将 super-memory/manager.js 的能力通过 Amily2Bus 暴露给其他模块
 *   2. 向后兼容：保留具名导出，现有直接 import 无需立即修改
 *
 * Bus 注册名：'SuperMemory'
 *
 * 公开接口（query('SuperMemory')）：
 *   initialize()               — 初始化超级记忆系统
 *   forceSyncAll()             — 全量同步到世界书
 *   tryRestoreStateFromMetadata() — 从聊天元数据恢复状态
 *   awaitSync()                — 等待当前同步队列完成（Pipeline Stage 4 使用）
 *   purge()                    — 清空记忆世界书
 */

import {
    initializeSuperMemory,
    tryRestoreStateFromMetadata,
    forceSyncAll,
    awaitSync,
    purgeSuperMemory,
    pushUpdate,
} from './manager.js';

// ── Bus 注册 ──────────────────────────────────────────────────────────────
setTimeout(() => {
    try {
        const _ctx = window.Amily2Bus?.register('SuperMemory');
        if (!_ctx) {
            console.warn('[SuperMemory] Amily2Bus 尚未就绪，服务注册跳过。');
            return;
        }
        _ctx.expose({
            initialize:                  ()        => initializeSuperMemory(),
            forceSyncAll:                ()        => forceSyncAll(),
            tryRestoreStateFromMetadata: ()        => tryRestoreStateFromMetadata(),
            awaitSync:                   ()        => awaitSync(),
            purge:                       ()        => purgeSuperMemory(),
            pushUpdate:                  (payload) => pushUpdate(payload),
        });
        _ctx.log('SuperMemoryService', 'info', 'SuperMemory 服务已注册到 Bus。');
    } catch (e) {
        console.error('[SuperMemory] Bus 注册失败:', e);
    }
}, 0);

// ── 向后兼容具名导出 ──────────────────────────────────────────────────────
export {
    initializeSuperMemory,
    tryRestoreStateFromMetadata,
    forceSyncAll,
    awaitSync,
    purgeSuperMemory,
    pushUpdate,
};
