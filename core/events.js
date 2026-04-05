import { getContext, extension_settings } from "/scripts/extensions.js";
import { extensionName } from "../utils/settings.js";
import { processMessageUpdate } from './table-system/TableSystemService.js';
// MessagePipeline 通过 Bus 查询；此 import 仅作启动时注册的触发
import './pipeline/MessagePipeline.js';

export async function onMessageReceived(data) {
    window.lastPreOptimizationResult = null;
    document.dispatchEvent(new CustomEvent('preOptimizationTextUpdated'));

    const context = getContext();
    if ((data && data.is_user) || context.isWaitingForUserInput) { return; }

    const settings = extension_settings[extensionName];
    const chat = context.chat;
    if (!chat || chat.length === 0) { return; }

    const latestMessage = chat[chat.length - 1];
    if (latestMessage.is_user) { return; }

    const pipeline = window.Amily2Bus?.query('MessagePipeline');
    if (!pipeline) {
        console.error('[Amily2-Events] MessagePipeline 服务未就绪，跳过消息处理。');
        return;
    }
    await pipeline.execute({
        messageId: chat.length - 1,
        latestMessage,
        chat,
        settings,
        optimizationResult: null,
    });
}

// Kept for SWIPED / EDITED event handlers in index.js
export async function handleTableUpdate(messageId) {
    await processMessageUpdate(messageId);
}
