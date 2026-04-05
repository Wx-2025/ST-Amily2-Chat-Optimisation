/**
 * Pipeline Stage 3 — TableUpdate
 * 主 API 填表 + 分步 API 填表（各自内部自带模式判断，互不干扰）。
 */
import { processMessageUpdate, fillWithSecondaryApi } from '../../table-system/TableSystemService.js';

export async function tableUpdateStage(ctx, next) {
    const { messageId, latestMessage } = ctx;
    try {
        // 主 API 模式（secondary-api / optimized 模式下函数内部自行跳过）
        await processMessageUpdate(messageId);
        // 分步 / 优化中填表（main-api 模式下函数内部自行跳过）
        await fillWithSecondaryApi(latestMessage);
    } catch (e) {
        console.error('[Pipeline:TableUpdate] 阶段异常:', e);
    }
    await next();
}
