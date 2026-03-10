import { getContext, extension_settings } from "/scripts/extensions.js";
import { extensionName } from "../utils/settings.js";
import { processMessageUpdate, fillWithSecondaryApi } from './table-system/TableSystemService.js';

import { processOptimization } from "./summarizer.js";
import { executeAutoHide } from './autoHideManager.js';
import { checkAndTriggerAutoSummary } from './historiographer.js';
import { amilyHelper } from './tavern-helper/main.js';

async function handleTableUpdate(messageId) {
    await processMessageUpdate(messageId);
}

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

    const tableSystemEnabled = settings.table_system_enabled !== false;

    await executeAutoHide();

    const isOptimizationEnabled = settings.optimizationEnabled && settings.apiUrl;
    if (isOptimizationEnabled) {
        if (chat.length >= 2 && chat[chat.length - 2].is_user) {
            const contextCount = settings.contextMessages || 2;
            const startIndex = Math.max(0, chat.length - 1 - contextCount);
            const previousMessages = chat.slice(startIndex, chat.length - 1);

            const result = await processOptimization(latestMessage, previousMessages);
            if (result) {
                window.lastPreOptimizationResult = result;
                document.dispatchEvent(new CustomEvent('preOptimizationTextUpdated'));
            }

            if (result && result.optimizedContent && result.optimizedContent !== latestMessage.mes) {
                const messageId = chat.length - 1;
                await amilyHelper.setChatMessage(
                    { message: result.optimizedContent },
                    messageId,
                    { refresh: 'display_and_render_current' }
                );
            }
        } else {
            console.log("[Amily2号-正文优化] 检测到消息并非AI对用户的直接回复，已跳过优化。");
        }
    }

    if (tableSystemEnabled) {
        const fillingMode = settings.filling_mode || 'main-api';
        if (fillingMode === 'secondary-api') {
            fillWithSecondaryApi(latestMessage);
        }
    } else {
        console.log('[分步填表] 表格系统总开关已关闭，跳过分步填表处理。');
    }

    (async () => {
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            await checkAndTriggerAutoSummary();
        } catch (error) {
            console.error('[大史官] 后台自动总结任务执行时发生错误:', error);
        }
    })();
}

export { handleTableUpdate };
