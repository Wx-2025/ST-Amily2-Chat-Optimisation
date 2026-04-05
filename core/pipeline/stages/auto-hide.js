/**
 * Pipeline Stage 1 — AutoHide
 * 自动隐藏超出阈值的旧消息。
 */
import { executeAutoHide } from '../../autoHideManager.js';

export async function autoHideStage(ctx, next) {
    try {
        await executeAutoHide();
    } catch (e) {
        console.error('[Pipeline:AutoHide] 阶段异常:', e);
    }
    await next();
}
