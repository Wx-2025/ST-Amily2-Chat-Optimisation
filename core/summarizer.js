import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { world_info } from "/scripts/world-info.js";
import { extensionName } from "../utils/settings.js";
import { extractContentByTag, replaceContentByTag, extractFullTagBlock } from '../utils/tagProcessor.js';
import { isGoogleEndpoint, convertToGoogleRequest, parseGoogleResponse, buildGoogleApiUrl, buildPlotOptimizationGoogleRequest, parsePlotOptimizationGoogleResponse } from './utils/googleAdapter.js';
import { applyExclusionRules } from './utils/rag-tag-extractor.js';
import {
  getCombinedWorldbookContent, getPlotOptimizedWorldbookContent, getOptimizationWorldbookContent,
} from "./lore.js";
import { getBatchFillerFlowTemplate, convertTablesToCsvString, updateTableFromText, saveStateToMessage, getMemoryState } from './table-system/manager.js';
import { saveChat } from "/script.js";
import { renderTables } from '../ui/table-bindings.js';

import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { callAI, generateRandomSeed } from './api.js';
import { callJqyhAI } from './api/JqyhApi.js';

export async function processOptimization(latestMessage, previousMessages) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }
 
    const settings = extension_settings[extensionName];
    const isOptimizationEnabled = settings.optimizationEnabled;

    if (!isOptimizationEnabled) {
        return null;
    }
 
    console.groupCollapsed(`[Amily2号-正文优化任务] ${new Date().toLocaleTimeString()}`);
    console.time("优化任务总耗时");
 
    try {
        window.Amily2PreOptimizationSnapshot = {
            original: null,
            optimized: null,
            raw: latestMessage.mes, 
        };

        const originalFullMessage = latestMessage.mes;
        let textToProcess = originalFullMessage;

        if (settings.optimizationExclusionEnabled && settings.optimizationExclusionRules?.length > 0) {
            const originalLength = textToProcess.length;
            textToProcess = applyExclusionRules(textToProcess, settings.optimizationExclusionRules);
            const newLength = textToProcess.length;
            if (originalLength !== newLength) {
                console.log(`[Amily2-内容排除] 正文优化内容排除规则已生效，文本长度从 ${originalLength} 变为 ${newLength}。`);
            }
        }

        const targetTag = settings.optimizationTargetTag || 'content';
        const extractedBlock = extractFullTagBlock(textToProcess, targetTag);
        
        if (!extractedBlock || extractContentByTag(extractedBlock, targetTag)?.trim() === '') {
             console.log(`[Amily2-外交部] 目标标签 <${targetTag}> 未找到或为空，或内容已被完全排除，优化任务已跳过。`);
             window.Amily2PreOptimizationSnapshot = null;
             document.dispatchEvent(new CustomEvent('preOptimizationStateUpdated'));
             console.timeEnd("优化任务总耗时");
             console.groupEnd();
             return null;
        }
        
        window.Amily2PreOptimizationSnapshot.original = extractContentByTag(extractedBlock, targetTag);
        document.dispatchEvent(new CustomEvent('preOptimizationStateUpdated'));

        textToProcess = extractedBlock;

        const context = getContext();
        const userName = context.name1 || '用户';
        const characterName = context.name2 || '角色';
 
        const lastUserMessage = previousMessages.length > 0 && previousMessages[previousMessages.length - 1].is_user ? previousMessages[previousMessages.length - 1] : null;
        const historyMessages = lastUserMessage ? previousMessages.slice(0, -1) : previousMessages;
        const history = historyMessages.map(m => (m.mes && m.mes.trim() ? `${m.is_user ? userName : characterName}: ${m.mes.trim()}` : null)).filter(Boolean).join("\n");
 
        const worldbookContent = await getOptimizationWorldbookContent();
        const presetPrompts = await getPresetPrompts('optimization');
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

        let currentInteractionContent = lastUserMessage ? `${userName}（用户）最新消息：${lastUserMessage.mes}\n${characterName}（AI）最新消息，[核心处理内容]：${textToProcess}` : `${characterName}（AI）最新消息，[核心处理内容]：${textToProcess}`;
        const fillingMode = settings.filling_mode || 'main-api';


        const order = getMixedOrder('optimization') || [];
        let promptCounter = 0;
        
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++;
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'mainPrompt':
                        if (settings.mainPrompt?.trim()) {
                            messages.push({ role: "system", content: settings.mainPrompt.trim() });
                        }
                        break;
                    case 'systemPrompt':
                        if (settings.systemPrompt?.trim()) {
                            messages.push({ role: "system", content: settings.systemPrompt.trim() });
                        }
                        break;
                    case 'worldbook':
                        if (worldbookContent) {
                            messages.push({ role: "user", content: `[世界书档案]:\n${worldbookContent}` });
                        }
                        break;
                    case 'history':
                        if (history) {
                            messages.push({ role: "user", content: `[上下文参考]:\n${history}` });
                        }
                        break;
                    case 'fillingMode':
                        if (isOptimizationEnabled && fillingMode === 'optimized') {
                            const flowTemplate = getBatchFillerFlowTemplate();
                            const tableData = convertTablesToCsvString();
                            const filledFlowTemplate = flowTemplate.replace('{{{Amily2TableData}}}', tableData);
                            
                            messages.push({ role: "user", content: currentInteractionContent });
                            messages.push({ role: "system", content: `请你在优化完成后，在正文标签外结合最新消息中的剧情、当前的表格内容进行填表任务：\n\n${filledFlowTemplate}\n\n<Amily2Edit>\n<!--\n（这里是你的填表内容）\n-->\n</Amily2Edit><Additional instructionsv>Optimisation and form filling have been completed.<Additional instructions>` });
                        } else {
                            messages.push({ role: "user", content: `[目标内容]:\n${currentInteractionContent}<Additional instructionsv>Start and end labels correctly.<Additional instructions>` });
                        }
                        break;
                }
            }
        }

        console.groupCollapsed("[Amily2号-最终国书内容 (发往AI)]");
        console.dir(messages);
        console.groupEnd();
        const rawContent = await callAI(messages);
        
        if (!rawContent) {
            console.error('[Amily2-外交部] 未能获取AI响应内容');
            return null;
        }

        console.groupCollapsed("[Amily2号-原始回复]");
        console.log(rawContent);
        console.groupEnd();

        let finalMessage = originalFullMessage;
        const purifiedTextFromAI = extractContentByTag(rawContent, targetTag);
        
        if (purifiedTextFromAI?.trim()) {
            finalMessage = replaceContentByTag(originalFullMessage, targetTag, purifiedTextFromAI);
            window.Amily2PreOptimizationSnapshot.optimized = purifiedTextFromAI;
        } else {
            console.warn(`[Amily2-外交部] AI的回复中未找到有效的目标标签 <${targetTag}>，将保留原始消息。`);
            window.Amily2PreOptimizationSnapshot.optimized = window.Amily2PreOptimizationSnapshot.original;
        }
        document.dispatchEvent(new CustomEvent('preOptimizationStateUpdated'));

        if (isOptimizationEnabled && fillingMode === 'optimized') {
            await updateTableFromText(rawContent);

            const finalContext = getContext();
            if (finalContext.chat && finalContext.chat.length > 0) {
                const lastMessage = finalContext.chat[finalContext.chat.length - 1];
                if (saveStateToMessage(getMemoryState(), lastMessage)) {
                    await saveChat();
                    renderTables();
                    console.log('[Amily2-优化中填表] 流程已全部完成，并已强制保存和刷新UI。');
                }
            }
        }

        const result = {
            originalContent: originalFullMessage,
            optimizedContent: finalMessage,
        };

        if (settings.showOptimizationToast) {
            toastr.success("正文优化成功！", "Amily2号");
        }

        console.timeEnd("优化任务总耗时");
        console.groupEnd();
        return result;
 
    } catch (error) {
        console.error(`[Amily2-外交部] 发生严重错误:`, error);
        toastr.error(`Amily2号任务失败: ${error.message}`, "严重错误");
        console.timeEnd("优化任务总耗时");
        console.groupEnd();
        return null;
    }
}


export async function processPlotOptimization(currentUserMessage, contextMessages, cancellationState = { isCancelled: false }) {
    const settings = extension_settings[extensionName];

    if (settings.plotOpt_enabled === false) {
        return null;
    }

    console.groupCollapsed(`[${extensionName}] 剧情优化任务启动... ${new Date().toLocaleTimeString()}`);
    console.time('剧情优化任务总耗时');

    try {
        const userMessageContent = currentUserMessage.mes;
        if (!userMessageContent || userMessageContent.trim() === '') {
            console.log(`[${extensionName}] 用户输入为空，跳过优化。`);
            return null;
        }

        const context = getContext();
        const userName = context.name1 || '用户';
        const charName = context.name2 || '角色';

        const presetPrompts = await getPresetPrompts('plot_optimization');
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

        const replacements = {
            'sulv1': settings.plotOpt_rateMain ?? 1.0,
            'sulv2': settings.plotOpt_ratePersonal ?? 1.0,
            'sulv3': settings.plotOpt_rateErotic ?? 1.0,
            'sulv4': settings.plotOpt_rateCuckold ?? 1.0,
        };

        let mainPrompt = settings.plotOpt_mainPrompt || '';
        let systemPrompt = settings.plotOpt_systemPrompt || '';
        
        for (const key in replacements) {
            const value = replacements[key];
            const regex = new RegExp(key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
            mainPrompt = mainPrompt.replace(regex, value);
            systemPrompt = systemPrompt.replace(regex, value);
        }

        const worldbookContent = await getPlotOptimizedWorldbookContent(context, settings);

        let tableContent = '';
        if (settings.plotOpt_tableEnabled) {
            try {
                const { convertTablesToCsvStringForContentOnly } = await import('./table-system/manager.js');
                const contentOnlyTemplate = "##以下内容是故事发生的剧情中提取出的内容，已经转化为表格形式呈现给你，请将以下内容作为后续剧情的一部分参考：<表格内容>\n{{{Amily2TableDataContent}}}</表格内容>";
                const tableData = convertTablesToCsvStringForContentOnly();
                
                if (tableData.trim()) {
                    tableContent = contentOnlyTemplate.replace('{{{Amily2TableDataContent}}}', tableData);
                }
            } catch (error) {
                console.error('[Amily2-表格系统] 注入表格内容时出错:', error);
            }
        }

        let history = '';
        const contextLimit = settings.plotOpt_contextLimit || 0;
        if (contextLimit > 0 && contextMessages.length > 0) {
            const historyMessages = contextMessages.slice(-contextLimit);
            history = historyMessages
                .map(msg => {
                    if (msg.mes && msg.mes.trim()) {
                        const commentExclusionRules = [{ start: '<!--', end: '-->' }];
                        const cleanedMessage = applyExclusionRules(msg.mes.trim(), commentExclusionRules);
                        return cleanedMessage ? `${msg.is_user ? userName : charName}: ${cleanedMessage}` : null;
                    }
                    return null;
                })
                .filter(Boolean)
                .join('\n');
        }

        const order = getMixedOrder('plot_optimization') || [];
        let promptCounter = 0;
        
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++;
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'mainPrompt':
                        if (mainPrompt.trim()) {
                            messages.push({ role: "system", content: mainPrompt.trim() });
                        }
                        break;
                    case 'systemPrompt':
                        if (systemPrompt.trim()) {
                            messages.push({ role: "system", content: systemPrompt.trim() });
                        }
                        break;
                    case 'worldbook':
                        if (worldbookContent.trim()) {
                            messages.push({ role: "user", content: `<世界书内容>\n${worldbookContent.trim()}</世界书内容>` });
                        }
                        break;
                    case 'tableEnabled':
                        if (tableContent) {
                            messages.push({ role: "user", content: tableContent });
                        }
                        break;
                    case 'contextLimit':
                        if (history) {
                            messages.push({ role: "user", content: `<前文内容>\n${history}\n</前文内容>` });
                        }
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `[核心处理内容]:\n${userMessageContent}` });
                        break;
                    case 'plotTag':
                        messages.push({ role: 'assistant', content: '<plot>' });
                        break;
                }
            }
        }

        console.groupCollapsed(`[${extensionName}] 发送给AI的最终请求内容`);
        console.dir(messages);
        console.groupEnd();

        let apiResponse = '';
        let attempt = 0;
        const maxAttempts = 3;
        let success = false;

        while (attempt < maxAttempts && !success) {
            if (cancellationState.isCancelled) {
                console.log(`[${extensionName}] 优化任务在尝试前被中止。`);
                return null;
            }
            attempt++;
            console.log(`[${extensionName}] 剧情优化第 ${attempt} 次尝试...`);
            
            const rawResponse = settings.jqyhEnabled ? await callJqyhAI(messages) : await callAI(messages, 'plot_optimization');

            if (cancellationState.isCancelled) {
                console.log(`[${extensionName}] 优化任务在API调用后被中止。`);
                return null;
            }

            if (!rawResponse) {
                console.warn(`[${extensionName}] 第 ${attempt} 次尝试获取响应失败，AI返回为空。`);
                continue; 
            }

            const plotContent = extractContentByTag(rawResponse, 'plot');
            const optimizedContent = (plotContent?.trim()) ? plotContent.trim() : rawResponse.trim();

            if (optimizedContent.length >= 100) {
                apiResponse = rawResponse;
                success = true;
                console.log(`[${extensionName}] 第 ${attempt} 次尝试成功，内容长度 (${optimizedContent.length}) 符合要求。`);
            } else {
                console.warn(`[${extensionName}] 第 ${attempt} 次尝试失败，回复内容长度为 ${optimizedContent.length}，小于100字符。`);
            }
        }

        if (!success) {
            console.error(`[${extensionName}] 已达到最大重试次数 (${maxAttempts}) 且未获得符合要求的回复，优化任务中止。`);
            toastr.error(`剧情优化在 ${maxAttempts} 次尝试后失败。`, "优化失败");
            return null;
        }

        console.groupCollapsed(`[${extensionName}] 从AI收到的原始回复`);
        console.log(apiResponse);
        console.groupEnd();

        const plotContent = extractContentByTag(apiResponse, 'plot');
        const optimizedContent = (plotContent?.trim()) ? plotContent.trim() : apiResponse.trim();
        
        if (optimizedContent) {
            let finalContentToAppend = '';
            let finalDirectiveTemplate = settings.plotOpt_finalSystemDirective?.trim() || '';

            const replacements = {
                'sulv1': settings.plotOpt_rateMain ?? 1.0,
                'sulv2': settings.plotOpt_ratePersonal ?? 1.0,
                'sulv3': settings.plotOpt_rateErotic ?? 1.0,
                'sulv4': settings.plotOpt_rateCuckold ?? 1.0,
            };
            for (const key in replacements) {
                const value = replacements[key];
                const regex = new RegExp(key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
                finalDirectiveTemplate = finalDirectiveTemplate.replace(regex, value);
            }

            if (finalDirectiveTemplate) {
                finalContentToAppend = finalDirectiveTemplate.replace('<plot>', optimizedContent);
            } else {
                finalContentToAppend = optimizedContent;
            }
            
            return { contentToAppend: finalContentToAppend };
        } else {
            return null;
        }

    } catch (error) {
        console.error(`[${extensionName}] 剧情优化任务发生严重错误:`, error);
        toastr.error(`剧情优化任务失败: ${error.message}`, '严重错误');
        return null;
    } finally {
        console.timeEnd('剧情优化任务总耗时');
        console.groupEnd();
    }
}
