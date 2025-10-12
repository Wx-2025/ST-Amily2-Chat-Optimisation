import { getContext, extension_settings } from "/scripts/extensions.js";
import { saveChatConditional } from "/script.js";
import { extensionName } from "../utils/settings.js";
import * as TableManager from './table-system/manager.js';
import * as Executor from './table-system/executor.js';
import { renderTables } from '../ui/table-bindings.js';
import { log } from "./table-system/logger.js";

async function handleTableUpdate(messageId) {
    TableManager.clearHighlights();

    const settings = extension_settings[extensionName];
    const tableSystemEnabled = settings.table_system_enabled !== false; 
    if (!tableSystemEnabled) {
        log('【监察系统】表格系统总开关已关闭，跳过所有表格处理。', 'info');
        return;
    }
    
    const fillingMode = settings.filling_mode || 'main-api';
    if (fillingMode === 'secondary-api' || fillingMode === 'optimized') {
        log('【监察系统】检测到"分步填表"或"优化中填表"模式已启用，主API填表逻辑已自动禁用。', 'info');
        return;
    }

    log(`【监察系统】接到圣旨，开始处理消息 ID: ${messageId}`, 'warn');
    const context = getContext();
    const message = context.chat[messageId];

    if (!message) {
        log(`【监察系统】错误：未找到消息 ID: ${messageId}，流程中止。`, 'error');
        return;
    }
    if (message.is_user) {
        log(`【监察系统】消息 ID: ${messageId} 是用户消息，无需处理。`, 'info');
        return;
    }

    log(`【监察系统】正在处理的奏折内容: "${message.mes.substring(0, 50)}..."`, 'info');
    const initialState = TableManager.loadTables(messageId);
    log(`【监察系统-步骤1】为消息 ${messageId} 加载了基准状态。`, 'info', initialState);
    const { finalState, hasChanges, changes } = Executor.executeCommands(message.mes, initialState);
    log(`【监察系统-步骤2】推演完毕。是否有变化: ${hasChanges}`, 'info', finalState);
    if (hasChanges) {
        if (changes && changes.length > 0) {
            changes.forEach(change => {
                TableManager.addHighlight(change.tableIndex, change.rowIndex, change.colIndex);
            });
        }

        TableManager.saveStateToMessage(finalState, message);
        TableManager.setMemoryState(finalState);
        await saveChatConditional();
        log(`【监察系统-步骤3】检测到变化，已将新状态写入消息 ${messageId} 并保存。`, 'success');
    } else {
        log(`【监察系统-步骤3】未检测到有效指令或变化，无需写入。`, 'info');
    }
    if (hasChanges) {
        renderTables();
    }
}



import { processOptimization } from "./summarizer.js";
import { executeAutoHide } from './autoHideManager.js';
import { checkAndTriggerAutoSummary } from './historiographer.js';
import { fillWithSecondaryApi } from './table-system/secondary-filler.js';

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
                latestMessage.mes = result.optimizedContent;
                await saveChatConditional();
                if (settings.optimizationMode === 'refresh') {
                    await reloadCurrentChat();
                }
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
        log('[分步填表] 表格系统总开关已关闭，跳过分步填表处理。', 'info');
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
