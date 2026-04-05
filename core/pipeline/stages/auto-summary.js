/**
 * Pipeline Stage 5 — AutoSummary
 * 触发大史官自动总结。属于非阻塞收尾任务，不等待完成即释放管道。
 */
import { checkAndTriggerAutoSummary } from '../../historiographer.js';

export async function autoSummaryStage(ctx, next) {
    await next();
    // 非阻塞：总结任务在后台执行，不阻断响应流
    checkAndTriggerAutoSummary().catch(e => {
        console.error('[Pipeline:AutoSummary] 后台总结任务异常:', e);
    });
}
