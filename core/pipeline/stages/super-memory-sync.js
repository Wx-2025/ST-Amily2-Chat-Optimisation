/**
 * Pipeline Stage 4 — SuperMemorySync
 * 等待本轮所有世界书写入完成，确保后续阶段（AutoSummary）读到最新状态。
 * 通过 Bus 调用，Bus 未就绪时静默跳过（不阻断管道）。
 */
export async function superMemorySyncStage(ctx, next) {
    try {
        const sm = window.Amily2Bus?.query('SuperMemory');
        if (sm?.awaitSync) {
            await sm.awaitSync();
        }
    } catch (e) {
        console.error('[Pipeline:SuperMemorySync] 阶段异常:', e);
    }
    await next();
}
