/**
 * Pipeline Stage 2 — TextOptimize
 * 调用 AI 对正文进行文学优化，结果写入 ctx.optimizationResult。
 * 若优化未开启或 AI 调用失败，不阻断后续阶段。
 */
import { processOptimization } from '../../summarizer.js';

export async function textOptimizeStage(ctx, next) {
    const { latestMessage, chat, messageId } = ctx;
    const previousMessages = chat.slice(0, messageId);
    try {
        ctx.optimizationResult = await processOptimization(latestMessage, previousMessages);
    } catch (e) {
        console.error('[Pipeline:TextOptimize] 阶段异常:', e);
        ctx.optimizationResult = null;
    }
    await next();
}
