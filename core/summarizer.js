import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { world_info } from "/scripts/world-info.js";
import { extensionName } from "../utils/settings.js";
import { extractContentByTag, replaceContentByTag, extractFullTagBlock } from '../utils/tagProcessor.js';
import { isGoogleEndpoint, convertToGoogleRequest, parseGoogleResponse, buildGoogleApiUrl, buildPlotOptimizationGoogleRequest, parsePlotOptimizationGoogleResponse } from './utils/googleAdapter.js';
import { applyExclusionRules, extractBlocksByTags } from './utils/rag-tag-extractor.js';
import {
  getCombinedWorldbookContent, getPlotOptimizedWorldbookContent, getOptimizationWorldbookContent,
} from "./lore.js";
import { getBatchFillerFlowTemplate, convertTablesToCsvString, updateTableFromText, saveStateToMessage, getMemoryState } from './table-system/manager.js';
import { saveChat } from "/script.js";
import { renderTables } from '../ui/table-bindings.js';

import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { callAI, generateRandomSeed } from './api.js';
import { callJqyhAI } from './api/JqyhApi.js';
import { callConcurrentAI } from './api/ConcurrentApi.js';

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


async function buildPlotOptimizationMessages(mainPrompt, systemPrompt, worldbookContent, tableContent, history, currentUserMessage, promptType = 'plot_optimization') {
    const settings = extension_settings[extensionName];
    const presetPrompts = await getPresetPrompts(promptType);
    const messages = [
        { role: 'system', content: generateRandomSeed() }
    ];

    const order = getMixedOrder(promptType) || [];
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
                    messages.push({ role: 'user', content: `[核心处理内容]:\n${currentUserMessage.mes}` });
                    break;
            }
        }
    }
    return messages;
}

export async function processPlotOptimization(currentUserMessage, contextMessages, cancellationState = { isCancelled: false }, onProgress = () => {}) {
    const settings = extension_settings[extensionName];

    // 随机文案生成器
    const getRandomText = (options) => options[Math.floor(Math.random() * options.length)];

    onProgress(getRandomText(['正在启动神经记忆引擎...', '正在连接潜意识深层...', '正在初始化思维矩阵...']));

    if (settings.plotOpt_enabled === false) {
        onProgress('记忆管理未启用', false, true);
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

        onProgress(getRandomText(['正在进行情感光谱分析...', '正在解析情绪波动频率...', '正在捕捉微表情信号...']), false);
        onProgress(getRandomText(['正在进行情感光谱分析...', '正在解析情绪波动频率...', '正在捕捉微表情信号...']), true);

        onProgress(getRandomText(['正在检索核心记忆碎片...', '正在唤醒沉睡的过往...', '正在回溯时间线...']), false);
        let worldbookContent = await getPlotOptimizedWorldbookContent(context, settings, false); // Explicitly mark as not concurrent
        onProgress(getRandomText(['正在检索核心记忆碎片...', '正在唤醒沉睡的过往...', '正在回溯时间线...']), true);

        onProgress(getRandomText(['正在解析多维剧情逻辑...', '正在构建动态世界观...', '正在编译因果律...']), false);
        try {
            if (settings.plotOpt_ejsEnabled !== false && globalThis.EjsTemplate?.evalTemplate && globalThis.EjsTemplate?.prepareContext) {
                const safeUser = (userMessageContent ?? '').toString();
                const safeWorld = (worldbookContent ?? '').toString();
                const hasEjsUser = /<%[=_\-]?/.test(safeUser);
                const hasEjsWorld = /<%[=_\-]?/.test(safeWorld);
                const openTagRegex = /<%[=_\-]?/g;
                const closeTagRegex = /[-_]?%>/g;
                const openUser = (safeUser.match(openTagRegex) || []).length;
                const closeUser = (safeUser.match(closeTagRegex) || []).length;
                const openWorld = (safeWorld.match(openTagRegex) || []).length;
                const closeWorld = (safeWorld.match(closeTagRegex) || []).length;
                const balancedUser = hasEjsUser && openUser === closeUser && openUser > 0;
                const balancedWorld = hasEjsWorld && openWorld === closeWorld && openWorld > 0;

                if (hasEjsUser || hasEjsWorld) {
                    const env = await globalThis.EjsTemplate.prepareContext({ runType: 'plot_optimization', isDryRun: false });

                    try {
                        if (balancedUser) {
                            const compiledUser = await globalThis.EjsTemplate.evalTemplate(safeUser, env, { _with: true });
                            if (typeof compiledUser === 'string' && compiledUser.length > 0) {
                                currentUserMessage.mes = compiledUser;
                            }
                        } else if (hasEjsUser) {
                            console.warn('[ST-Amily2-Chat-Optimisation][PlotOpt] 检测到未闭合的 EJS 标签（用户输入），已跳过预处理。');
                        }
                    } catch (errUser) {
                        console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] EJS 預處理-用户输入失败：', errUser);
                        toastr.error('EJS 预处理用户输入失败，已中止。', 'Amily2号');
                        return null;
                    }

                    try {
                        if (balancedWorld) {
                            const compiledWorld = await globalThis.EjsTemplate.evalTemplate(safeWorld, env, { _with: true });
                            if (typeof compiledWorld === 'string' && compiledWorld.length > 0) {
                                worldbookContent = compiledWorld;
                            }
                        } else if (hasEjsWorld) {
                            console.warn('[ST-Amily2-Chat-Optimisation][PlotOpt] 检测到未闭合的 EJS 标签（世界书），已跳过预处理。');
                        }
                    } catch (errWorld) {
                        try {
                            if (globalThis.EjsTemplate?.getSyntaxErrorInfo && typeof errWorld?.message === 'string') {
                                const extra = globalThis.EjsTemplate.getSyntaxErrorInfo(safeWorld);
                                console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] EJS 預處理-世界书失败(含定位)：', errWorld?.message + (extra || ''));
                            } else {
                                console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] EJS 預處理-世界书失败：', errWorld);
                            }
                            // 打印世界书片段（限長）
                            try {
                                const maxLen = 2000;
                                const snippet = typeof safeWorld === 'string' ? safeWorld.slice(0, maxLen) : String(safeWorld).slice(0, maxLen);
                                const isTruncated = (safeWorld?.length || 0) > maxLen;
                                // 存入全局以便用户在控制台直接读取
                                try {
                                    // @ts-ignore
                                    window.Amily2PlotOptDebug = window.Amily2PlotOptDebug || {};
                                    // @ts-ignore
                                    window.Amily2PlotOptDebug.worldErrorMessage = (errWorld?.message || String(errWorld)) + '';
                                    // @ts-ignore
                                    window.Amily2PlotOptDebug.worldSnippet = snippet;
                                    // @ts-ignore
                                    window.Amily2PlotOptDebug.worldSnippetTruncated = isTruncated;
                                    // @ts-ignore
                                    window.Amily2PlotOptDebug.worldOpenClose = { open: openWorld, close: closeWorld };
                                } catch (_) {}

                                // 多级别日志，避免特定环境过滤
                                console.groupCollapsed('[ST-Amily2-Chat-Optimisation][PlotOpt] 失败世界书片段 (截断=' + isTruncated + ')');
                                console.log(snippet);
                                console.groupEnd();
                                console.warn('[ST-Amily2-Chat-Optimisation][PlotOpt] worldOpenClose:', { open: openWorld, close: closeWorld });
                                console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] 以上即失败世界书片段。');
                            } catch (logErr) {
                                console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] 打印失败世界书片段时出错：', logErr);
                            }
                        } catch (sub) {
                            console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] 记录语法位置信息失败：', sub);
                        }
                        toastr.error('EJS 预处理世界书失败，已中止。', 'Amily2号');
                        return null;
                    }
                }
            }
        } catch (e) {
            console.error('[ST-Amily2-Chat-Optimisation][PlotOpt] EJS 預處理初始化失败（可能是上下文环境）：', e);
            toastr.error('EJS 预处理初始化失败，已中止。', 'Amily2号');
            return null; // 直接中止，不送出訊息
        }
        onProgress(getRandomText(['正在解析多维剧情逻辑...', '正在构建动态世界观...', '正在编译因果律...']), true);
        onProgress(getRandomText(['正在校准记忆偏差...', '正在强化神经突触连接...', '正在同步灵魂共鸣率...']), false);
        onProgress(getRandomText(['正在校准记忆偏差...', '正在强化神经突触连接...', '正在同步灵魂共鸣率...']), true);

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
            
            // 复刻 Historiographer 的标签提取与内容排除逻辑
            const useTagExtraction = settings.historiographyTagExtractionEnabled ?? false;
            const tagsToExtract = useTagExtraction ? (settings.historiographyTags || '').split(',').map(t => t.trim()).filter(Boolean) : [];
            const exclusionRules = settings.historiographyExclusionRules || [];

            history = historyMessages
                .map(msg => {
                    if (msg.mes && msg.mes.trim()) {
                        let content = msg.mes.trim();

                        // 1. 标签提取
                        if (useTagExtraction && tagsToExtract.length > 0) {
                            const blocks = extractBlocksByTags(content, tagsToExtract);
                            if (blocks.length > 0) {
                                content = blocks.join('\n\n');
                            }
                        }

                        // 2. 内容排除
                        content = applyExclusionRules(content, exclusionRules);

                        return content ? `${msg.is_user ? userName : charName}: ${content}` : null;
                    }
                    return null;
                })
                .filter(Boolean)
                .join('\n');
        }

        let apiResponse = '';

        if (settings.plotOpt_concurrentEnabled) {
            onProgress(getRandomText(['正在编织思维导图 (LLM-A)...', '正在重构对话上下文 (LLM-A)...']), false);
            const mainMessages = await buildPlotOptimizationMessages(mainPrompt, systemPrompt, worldbookContent, '', history, currentUserMessage);
            onProgress(getRandomText(['正在编织思维导图 (LLM-A)...', '正在重构对话上下文 (LLM-A)...']), true);
            
            console.groupCollapsed(`[${extensionName}] 发送给主AI的最终请求内容`);
            console.dir(mainMessages);
            console.groupEnd();
            
            // 提前通知 LLM-B 开始准备，让进度条尽早出现
            onProgress(getRandomText(['正在检索辅助记忆 (LLM-B)...', '正在扫描平行世界线 (LLM-B)...']), false);

            onProgress(getRandomText(['正在与核心意识同步 (LLM-A)...', '正在等待灵魂共鸣 (LLM-A)...']), false);
            const promise1 = (settings.jqyhEnabled ? callJqyhAI(mainMessages) : callAI(mainMessages, 'plot_optimization')).then(res => {
                onProgress(getRandomText(['正在与核心意识同步 (LLM-A)...', '正在等待灵魂共鸣 (LLM-A)...']), true);
                return res;
            });
            const concurrentApiSettings = {
                plotOpt_worldbook_enabled: settings.plotOpt_concurrentWorldbookEnabled,
                plotOpt_worldbook_source: settings.plotOpt_concurrentWorldbookSource,
                plotOpt_selectedWorldbooks: settings.plotOpt_concurrentSelectedWorldbooks,
                plotOpt_autoSelectWorldbooks: settings.plotOpt_concurrentAutoSelectWorldbooks,
                plotOpt_worldbookCharLimit: settings.plotOpt_concurrentWorldbookCharLimit,
            };
            const concurrentWorldbookContent = await getPlotOptimizedWorldbookContent(context, concurrentApiSettings, true); // Explicitly mark as concurrent
            onProgress(getRandomText(['正在检索辅助记忆 (LLM-B)...', '正在扫描平行世界线 (LLM-B)...']), true);
            
            onProgress(getRandomText(['正在构建辅助思维模型 (LLM-B)...', '正在解析潜意识逻辑 (LLM-B)...']), false);
            const concurrentMainPrompt = settings.plotOpt_concurrentMainPrompt || mainPrompt;
            const concurrentSystemPrompt = settings.plotOpt_concurrentSystemPrompt || systemPrompt;
            
            const concurrentMessages = await buildPlotOptimizationMessages(concurrentMainPrompt, concurrentSystemPrompt, concurrentWorldbookContent, tableContent, history, currentUserMessage, 'concurrent_plot_optimization');
            onProgress(getRandomText(['正在构建辅助思维模型 (LLM-B)...', '正在解析潜意识逻辑 (LLM-B)...']), true);

            console.groupCollapsed(`[${extensionName}] 发送给并发AI的最终请求内容`);
            console.dir(concurrentMessages);
            console.groupEnd();

            onProgress(getRandomText(['正在进行深度逻辑推演 (LLM-B)...', '正在计算情感最优解 (LLM-B)...']), false);
            const promise2 = callConcurrentAI(concurrentMessages).then(res => {
                onProgress(getRandomText(['正在进行深度逻辑推演 (LLM-B)...', '正在计算情感最优解 (LLM-B)...']), true);
                return res;
            });

            const [mainResult, concurrentResult] = await Promise.allSettled([promise1, promise2]);

            const mainResponse = mainResult.status === 'fulfilled' ? (mainResult.value || '').trim() : '';
            const concurrentResponse = concurrentResult.status === 'fulfilled' ? (concurrentResult.value || '').trim() : '';

            if (!mainResponse && !concurrentResponse) {
                console.error(`[${extensionName}] 所有并发API调用均失败或返回空。`);
                toastr.error('并发剧情优化失败，所有模型均未返回有效内容。', '优化失败');
                return null;
            }
            
            apiResponse = [mainResponse, concurrentResponse].filter(Boolean).join('\n\n');
            
        } else {
            onProgress('未启用 LLM-B (并发模型)', false, true);
            onProgress(getRandomText(['正在编织思维导图...', '正在重构对话上下文...']), false);
            const mainMessages = await buildPlotOptimizationMessages(mainPrompt, systemPrompt, worldbookContent, tableContent, history, currentUserMessage);
            onProgress(getRandomText(['正在编织思维导图...', '正在重构对话上下文...']), true);

            console.groupCollapsed(`[${extensionName}] 发送给主AI的最终请求内容`);
            console.dir(mainMessages);
            console.groupEnd();

            onProgress(getRandomText(['正在与核心意识进行深度同步...', '正在等待灵魂共鸣...']), false);
            let attempt = 0;
            const maxAttempts = 3;
            let success = false;

            while (attempt < maxAttempts && !success) {
                if (cancellationState.isCancelled) {
                    console.log(`[${extensionName}] 优化任务在尝试前被中止。`);
                    onProgress(getRandomText(['正在与核心意识进行深度同步...', '正在等待灵魂共鸣...']), false, true);
                    return null;
                }
                attempt++;
                console.log(`[${extensionName}] 剧情优化第 ${attempt} 次尝试...`);
                
                const rawResponse = settings.jqyhEnabled ? await callJqyhAI(mainMessages) : await callAI(mainMessages, 'plot_optimization');

                if (cancellationState.isCancelled) {
                    console.log(`[${extensionName}] 优化任务在API调用后被中止。`);
                    onProgress(getRandomText(['正在与核心意识进行深度同步...', '正在等待灵魂共鸣...']), false, true);
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
                onProgress(getRandomText(['正在与核心意识进行深度同步...', '正在等待灵魂共鸣...']), false, true);
                console.error(`[${extensionName}] 已达到最大重试次数 (${maxAttempts}) 且未获得符合要求的回复，优化任务中止。`);
                toastr.error(`剧情优化在 ${maxAttempts} 次尝试后失败。`, "优化失败");
                return null;
            }
        }

        console.groupCollapsed(`[${extensionName}] 从AI收到的原始回复`);
        console.log(apiResponse);
        console.groupEnd();

        const optimizedContent = settings.plotOpt_concurrentEnabled 
            ? apiResponse 
            : (extractContentByTag(apiResponse, 'plot') || apiResponse).trim();
        
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
            
            onProgress('记忆重构完成，正在注入...', true);
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
