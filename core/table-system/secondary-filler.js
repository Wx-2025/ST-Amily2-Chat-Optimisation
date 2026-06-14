import { getContext, extension_settings } from "/scripts/extensions.js";
import { loadWorldInfo } from "/scripts/world-info.js";
import { saveChat } from "/script.js";
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { extensionName } from "../../utils/settings.js";
import { updateTableFromText, updateTableFromOps, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate, convertTablesToCsvString, saveStateToMessage, getMemoryState, clearHighlights } from './manager.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, callAIForTools, generateRandomSeed } from '../api.js';
import { TABLE_FILL_TOOL, parseToolCallArgs } from './formatters/tool-call.js';
import { callNccsAI } from '../api/NccsApi.js';
import { extractBlocksByTags, applyExclusionRules } from '../utils/rag-tag-extractor.js';
import { resolveTableRuleConfig } from '../../utils/config/RuleProfileManager.js';
import { safeLorebookEntries } from '../tavernhelper-compatibility.js';
import { log } from './logger.js';
import { showTableFillReviewModal } from '../../ui/page-window.js';

const CONTINUE_PROMPT_SECONDARY = '上一条回复不完整或缺少 <Amily2Edit> 指令块。请直接从中断处继续生成剩余内容，不要重复已输出的文本，也不要添加任何解释或寒暄，确保最终输出中包含完整的 <Amily2Edit>...</Amily2Edit> 指令块。';

let secondaryFillerDebounceTimer = null;
let secondaryFillerRunning = false;
let currentAbortController = null;

async function callSecondaryModel(messages, signal) {
    const settings = extension_settings[extensionName] || {};
    if (settings.nccsEnabled) {
        return await callNccsAI(messages, { signal });
    }
    return await callAI(messages, { signal });
}

async function requestSecondaryContinuation(baseMessages, partialResponse) {
    const continueMessages = [
        ...baseMessages,
        { role: 'assistant', content: partialResponse || '' },
        { role: 'user', content: CONTINUE_PROMPT_SECONDARY },
    ];
    const continued = await callSecondaryModel(continueMessages);
    if (!continued) return null;
    return `${partialResponse || ''}${continued}`;
}

async function markTargetsProcessed(targetMessages, { skipTableSave = false } = {}) {
    if (!targetMessages || targetMessages.length === 0) return;

    const lastProcessedMsg = targetMessages[targetMessages.length - 1].msg;

    for (const target of targetMessages) {
        if (!target.msg.extra) target.msg.extra = {};
        target.msg.extra.amily2_process_hash = target.hash;
    }

    if (!skipTableSave) {
        const memoryState = getMemoryState();
        if (saveStateToMessage(memoryState, lastProcessedMsg)) {
            renderTables();
            updateOrInsertTableInChat();
        }
    }

    await saveChat();
}

async function commitSecondaryFillResult(rawContent, targetMessages) {
    // skipPersist：不让 updateTableFromText 把状态写到最新楼 L，改由 markTargetsProcessed
    // 存到 lastProcessedMsg(E)——否则保留楼层场景下 swipe 最新楼会回退掉本轮已填内容。
    await updateTableFromText(rawContent, { skipPersist: true });
    await markTargetsProcessed(targetMessages);
}


async function getWorldBookContext() {
    const settings = extension_settings[extensionName] || {};

    if (!settings.table_worldbook_enabled) {
        return '';
    }

    const selectedEntriesByBook = settings.table_selected_entries || {};
    const booksToInclude = Object.keys(selectedEntriesByBook);
    const selectedEntryUids = new Set(Object.values(selectedEntriesByBook).flat());

    if (booksToInclude.length === 0 || selectedEntryUids.size === 0) {
        return '';
    }

    let allEntries = [];
    for (const bookName of booksToInclude) {
        try {
            const entries = await safeLorebookEntries(bookName);
            if (entries?.length) {
                entries.forEach(entry => allEntries.push({ ...entry, bookName }));
            }
        } catch (error) {
            console.error(`[Amily2-副API] Error loading entries for world book: ${bookName}`, error);
        }
    }

    const userEnabledEntries = allEntries.filter(entry => {
        return entry && selectedEntryUids.has(String(entry.uid));
    });

    if (userEnabledEntries.length === 0) {
        return '';
    }

    let content = userEnabledEntries.map(entry => 
        `[来源：世界书，条目名字：${entry.comment || '无标题条目'}]\n${entry.content}`
    ).join('\n\n');
    
    const maxChars = settings.table_worldbook_char_limit || 30000;
    if (content.length > maxChars) {
        content = content.substring(0, maxChars);
        const lastNewline = content.lastIndexOf('\n');
        if (lastNewline !== -1) {
            content = content.substring(0, lastNewline);
        }
        content += '\n[...内容已截断]';
    }

    return content.trim() ? `<世界书>\n${content.trim()}\n</世界书>` : '';
}

export async function fillWithSecondaryApi(latestMessage, forceRun = false, opts = {}) {
    if (secondaryFillerRunning) {
        log('分步填表正在进行中，跳过本次触发。', 'warn');
        return;
    }
    const settings = extension_settings[extensionName] || {};

    // 【V2.1.1】分步填表触发延迟 / 防抖：自动触发时若配置了延迟，则延后执行，
    // 延迟期内再次到来的事件会重置计时器，避免消息连续到达时重复拉起填表。
    // 注意：防抖与早返路径都不持锁，避免 setTimeout 回调撞上自己的锁导致死锁。
    const delay = Math.max(0, parseInt(settings.secondary_filler_delay || 0, 10));
    if (!forceRun && delay > 0) {
        if (secondaryFillerDebounceTimer) {
            clearTimeout(secondaryFillerDebounceTimer);
        }
        secondaryFillerDebounceTimer = setTimeout(() => {
            secondaryFillerDebounceTimer = null;
            fillWithSecondaryApi(latestMessage, forceRun, opts);
        }, delay);
        console.log(`[Amily2-副API] 分步填表已按防抖延迟 ${delay}ms 调度。`);
        return;
    }
    if (secondaryFillerDebounceTimer) {
        clearTimeout(secondaryFillerDebounceTimer);
        secondaryFillerDebounceTimer = null;
    }

    clearHighlights();

    // 总开关关闭时，分步填表同样禁用
    if (settings.table_system_enabled === false) {
        log('【分步填表】表格系统总开关已关闭，跳过。', 'info');
        return;
    }

    const context = getContext();
    if (context.chat.length <= 1) {
        console.log("[Amily2-副API] 聊天刚开始，跳过本次自动填表。");
        return;
    }

    const fillingMode = settings.filling_mode || 'main-api';
    if (fillingMode !== 'secondary-api' && !forceRun) {
        log('当前非分步填表模式，且未强制执行，跳过。', 'info');
        return;
    }

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }

    // 所有早返检查通过后再获取锁，确保 finally 一定能解锁
    secondaryFillerRunning = true;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    try {
        const bufferSize = parseInt(settings.secondary_filler_buffer || 0, 10);
        const batchSize = parseInt(settings.secondary_filler_batch || 0, 10);
        const contextLimit = parseInt(settings.secondary_filler_context || 2, 10);

        // 【V1.7.7 修复】限制最大回溯深度，防止更新后无限填补旧历史
        // 扫描深度 = 上下文 + 填表批次 + 冗余量(10)
        // bufferSize（保留楼层）仅用于限定尾部边界 validEndIndex，
        // 不再回流到扫描起点，避免重复影响范围
        const redundancy = 10;
        const maxScanDepth = contextLimit + batchSize + redundancy;

        const chat = context.chat;
        const totalMessages = chat.length;

        const getContentHash = (content) => {
            let hash = 0, i, chr;
            if (content.length === 0) return hash;
            for (i = 0; i < content.length; i++) {
                chr = content.charCodeAt(i);
                hash = ((hash << 5) - hash) + chr;
                hash |= 0;
            }
            return hash;
        };

        let targetMessages = [];

        // 【SWIPED 旁路】swipe 后强制处理刚切出来的最新消息：
        // 跳过扫描 / bufferSize / batchSize 累积逻辑，直接锁定目标
        if (opts.targetMessage) {
            const targetIndex = chat.indexOf(opts.targetMessage);
            if (targetIndex < 0) {
                console.log("[Amily2-副API] 旁路目标消息不在聊天列表中，跳过。");
                return;
            }
            if (opts.targetMessage.is_user) {
                console.log("[Amily2-副API] 旁路目标是用户消息，跳过。");
                return;
            }
            targetMessages.push({
                index: targetIndex,
                msg: opts.targetMessage,
                hash: getContentHash(opts.targetMessage.mes),
            });
        } else {
            // 常规扫描路径
            const validEndIndex = totalMessages - 1 - bufferSize;
            const scanStartIndex = Math.max(0, validEndIndex - maxScanDepth);

            if (validEndIndex < 0) {
                console.log(`[Amily2-副API] 消息数量不足以超出保留区(${bufferSize})，跳过。`);
                return;
            }

            // 【修复】改为正向扫描，优先处理最老的未处理消息，防止遗留消息被挤出扫描区
            for (let i = scanStartIndex; i <= validEndIndex; i++) {
                const msg = chat[i];

                if (msg.is_user) continue;

                const currentHash = getContentHash(msg.mes);
                const savedHash = msg.extra?.amily2_process_hash;

                const isUnprocessed = !savedHash;
                const isChanged = savedHash && savedHash !== currentHash;

                if (isUnprocessed || isChanged) {
                    targetMessages.push({ index: i, msg: msg, hash: currentHash });

                    if (batchSize > 0 && targetMessages.length >= batchSize) {
                        break;
                    }
                }
            }

            if (targetMessages.length === 0) {
                console.log("[Amily2-副API] 没有发现需要处理的消息。");
                return;
            }

            if (batchSize > 0) {
                if (targetMessages.length < batchSize) {
                    console.log(`[Amily2-副API] 批量模式: 当前累积 ${targetMessages.length}/${batchSize} 条未处理消息，暂不触发。`);
                    return;
                }
            } else {
                targetMessages = [targetMessages[targetMessages.length - 1]];
            }
        }

        console.log(`[Amily2-副API] 触发填表: 处理 ${targetMessages.length} 条消息。索引范围: ${targetMessages[0].index} - ${targetMessages[targetMessages.length-1].index}`);
        toastr.info(`分步填表正在执行，正在填写 ${targetMessages[0].index + 1} 楼至 ${targetMessages[targetMessages.length-1].index + 1} 楼的内容`, "Amily2-分步填表");

        let tagsToExtract = [];
        let exclusionRules = [];
        const tableRuleConfig = resolveTableRuleConfig(settings);
        if (tableRuleConfig.tags || (tableRuleConfig.exclusionRules && tableRuleConfig.exclusionRules.length)) {
            tagsToExtract = (tableRuleConfig.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            exclusionRules = tableRuleConfig.exclusionRules || [];
        }

        let coreContentText = "";
        const userName = context.name1 || '用户';
        const characterName = context.name2 || '角色';

        for (const target of targetMessages) {
            let textToProcess = target.msg.mes;
            
            if (tagsToExtract.length > 0) {
                const blocks = extractBlocksByTags(textToProcess, tagsToExtract);
                textToProcess = blocks.join('\n\n');
            }
            textToProcess = applyExclusionRules(textToProcess, exclusionRules);
            
            if (!textToProcess.trim()) continue;

            coreContentText += `\n【第 ${target.index + 1} 楼】${characterName}（AI）消息：\n${textToProcess}\n`;
        }

        if (!coreContentText.trim()) {
            console.log("[Amily2-副API] 目标内容处理后为空，跳过。");
            return;
        }

        const historyEndIndex = targetMessages[0].index - 1;
        
        let historyContextStr = "";
        if (contextLimit > 0 && historyEndIndex >= 0) {
            historyContextStr = await getHistoryContext(contextLimit, historyEndIndex, tagsToExtract, exclusionRules) || "";
        }

        const currentInteractionContent = (historyContextStr ? `${historyContextStr}\n\n` : '') + 
                                          `<核心填表内容>\n${coreContentText}\n</核心填表内容>`;

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[副API填表] 加载混合顺序失败:", e);
        }

        const order = getMixedOrder('secondary_filler') || [];
        const presetPrompts = await getPresetPrompts('secondary_filler');
        
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

        const worldBookContext = await getWorldBookContext();

        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        const currentTableDataString = convertTablesToCsvString();
        const finalFlowPrompt = flowTemplate.replace('{{{Amily2TableData}}}', currentTableDataString);

        let promptCounter = 0; 
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++; 
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'worldbook':
                        if (worldBookContext) {
                            messages.push({ role: "system", content: worldBookContext });
                        }
                        break;
                    case 'contextHistory':
                        if (historyContextStr) {
                             messages.push({ role: "system", content: historyContextStr });
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"核心填表内容"进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<核心填表内容>\n${coreContentText}\n</核心填表内容>` });
                        break;
                }
            }
        }

        console.groupCollapsed(`[Amily2 分步填表] 即将发送至 API 的内容`);
        console.log("发送给AI的提示词: ", JSON.stringify(messages, null, 2));
        console.dir(messages);
        console.groupEnd();

        if (settings.tableFillFunctionCall) {
            // Function Call 路径
            const argsString = await callAIForTools(messages, TABLE_FILL_TOOL, { slot: 'tableFilling', signal });
            if (!argsString) {
                console.error('[Amily2-副API] Function Call 返回为空。');
                return;
            }
            const ops = parseToolCallArgs(argsString);
            if (ops.length === 0) {
                let parseHint = '';
                try {
                    const rawParsed = JSON.parse(argsString);
                    const rawOpsLen = rawParsed?.operations?.length ?? 0;
                    if (rawOpsLen > 0) parseHint = `（响应含 ${rawOpsLen} 条操作，但全部未通过格式校验）`;
                } catch {
                    parseHint = '（响应 JSON 解析失败）';
                }
                console.warn(`[Amily2-副API] Function Call 返回操作列表为空${parseHint}，原始响应：\n${argsString}`);
                toastr.info('AI 判断此范围无需修改。', 'Amily2-分步填表');
                await markTargetsProcessed(targetMessages, { skipTableSave: true });
            } else {
                // skipPersist：状态由 markTargetsProcessed 存到 E，不写最新楼（同文本路径）
                await updateTableFromOps(ops, { skipPersist: true });
                await markTargetsProcessed(targetMessages);
                toastr.success('分步填表（Function Call）执行完毕。', 'Amily2-分步填表');
            }
        } else {
            // Legacy 文本路径
            let rawContent;
            if (settings.nccsEnabled) {
                console.log('[Amily2-副API] 使用 Nccs API 进行分步填表...');
                rawContent = await callNccsAI(messages, { signal });
            } else {
                console.log('[Amily2-副API] 使用 tableFilling slot 进行分步填表...');
                rawContent = await callAI(messages, { slot: 'tableFilling', signal });
            }

            if (!rawContent) {
                console.error('[Amily2-副API] 未能获取AI响应内容。');
                return;
            }

            console.log('[Amily2号-副API-原始回复]:', rawContent);

            if (!rawContent.includes('<Amily2Edit>')) {
                const rangeLabel = `${targetMessages[0].index + 1} - ${targetMessages[targetMessages.length - 1].index + 1}`;
                console.warn(`[Amily2-副API] 响应未包含 <Amily2Edit> 指令块（楼层 ${rangeLabel}），弹出检查窗口等待用户处理。`);
                toastr.warning(`分步填表（楼层 ${rangeLabel}）的响应缺少 <Amily2Edit> 指令块，请在弹窗中处理。`, 'Amily2-分步填表');
                if (latestMessage && latestMessage.extra) {
                    delete latestMessage.extra.amily2_retry_count;
                }
                showTableFillReviewModal(rawContent, {
                    title: `分步填表响应检查 - 楼层 ${rangeLabel}`,
                    subtitle: `分步填表（楼层 ${rangeLabel}）的 AI 响应未包含有效的 <Amily2Edit> 指令块。请检查原始响应并选择处理方式。`,
                    onContinue: async (currentText) => {
                        const merged = await requestSecondaryContinuation(messages, currentText);
                        if (!merged) { toastr.error('补全请求失败或返回为空。', '继续补全'); return null; }
                        if (!merged.includes('<Amily2Edit>')) {
                            toastr.warning('补全后仍未包含 <Amily2Edit> 指令块，可继续补全、手动应用或重新填表。', '继续补全');
                        } else {
                            toastr.success('已获得包含指令块的补全内容，可点击”手动应用”写入。', '继续补全');
                        }
                        return merged;
                    },
                    onApply: async (editedText) => {
                        if (!editedText || !editedText.includes('<Amily2Edit>')) {
                            toastr.warning('应用的文本中未检测到 <Amily2Edit> 指令块，已按原文尝试写入。', '手动应用');
                        }
                        try {
                            await commitSecondaryFillResult(editedText, targetMessages);
                            toastr.success('分步填表已由用户手动处理完成。', 'Amily2-分步填表');
                        } catch (err) {
                            console.error('[Amily2-副API] 手动应用失败:', err);
                            toastr.error(`手动应用失败: ${err.message}`, '写入异常');
                        }
                    },
                    onRetry: () => {
                        if (latestMessage && latestMessage.extra) {
                            delete latestMessage.extra.amily2_retry_count;
                        }
                        toastr.info('将重新执行分步填表...', 'Amily2-分步填表');
                        setTimeout(() => fillWithSecondaryApi(latestMessage, forceRun, opts), 300);
                    },
                    onCancel: () => {
                        toastr.info('已取消本次分步填表。', 'Amily2-分步填表');
                    },
                });
                return;
            }

            await commitSecondaryFillResult(rawContent, targetMessages);
        }
        toastr.success("分步填表执行完毕。", "Amily2-分步填表");

    } catch (error) {
        if (error?.name === 'AbortError' || signal.aborted) {
            console.warn('[Amily2-副API] 分步填表已被用户中断，跳过结果处理与重试。');
            toastr.info('分步填表已中断。', 'Amily2-分步填表');
            if (latestMessage && latestMessage.extra) {
                delete latestMessage.extra.amily2_retry_count;
            }
            return;
        }
        console.error(`[Amily2-副API] 发生严重错误:`, error);

        // 【新增】自定义重试逻辑
        const maxRetries = parseInt(settings.secondary_filler_max_retries || 0, 10);
        const currentRetryCount = latestMessage?.extra?.amily2_retry_count || 0;

        if (currentRetryCount < maxRetries) {
            const nextRetryCount = currentRetryCount + 1;
            console.log(`[Amily2-副API] 准备进行第 ${nextRetryCount}/${maxRetries} 次重试...`);
            toastr.warning(`副API填表失败: ${error.message}。将在3秒后进行第 ${nextRetryCount} 次重试...`, "自动重试");

            // 记录重试次数到最新消息的 extra 中，以便跨调用传递状态（跟 amily2_tables_data 一起持久化）
            if (latestMessage) {
                if (!latestMessage.extra) latestMessage.extra = {};
                latestMessage.extra.amily2_retry_count = nextRetryCount;
            }

            setTimeout(() => {
                fillWithSecondaryApi(latestMessage, forceRun, opts);
            }, 3000);
        } else {
            console.log(`[Amily2-副API] 已达到最大重试次数 (${maxRetries})，放弃本次填表。`);
            toastr.error(`副API填表失败: ${error.message}。已达到最大重试次数，任务终止。`, "严重错误");

            // 清除重试计数器
            if (latestMessage && latestMessage.extra) {
                delete latestMessage.extra.amily2_retry_count;
            }
        }
    } finally {
        secondaryFillerRunning = false;
        currentAbortController = null;
    }
}

export function resetSecondaryFillerLock() {
    const wasLocked = secondaryFillerRunning;
    if (secondaryFillerDebounceTimer) {
        clearTimeout(secondaryFillerDebounceTimer);
        secondaryFillerDebounceTimer = null;
    }
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch {}
        currentAbortController = null;
    }
    secondaryFillerRunning = false;
    return wasLocked;
}

export function isSecondaryFillerRunning() {
    return secondaryFillerRunning;
}

export function abortCurrentSecondaryFiller() {
    if (!secondaryFillerRunning && !currentAbortController) {
        return false;
    }
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch {}
    }
    // 锁的释放由 finally 完成；这里只发出中断信号
    return true;
}

    async function getHistoryContext(messagesToFetch, historyEndIndex, tagsToExtract, exclusionRules) {
        const context = getContext();
        const chat = context.chat;
        
        if (!chat || chat.length === 0 || messagesToFetch <= 0) {
            return null;
        }

        const historyUntil = Math.max(0, historyEndIndex); 
        // 【修复】slice 的 end 索引是不包含的，为了包含 historyUntil，end 必须 +1
        const sliceEnd = historyUntil + 1;
        const messagesToExtract = Math.min(messagesToFetch, sliceEnd);
        const sliceStart = Math.max(0, sliceEnd - messagesToExtract);

        const historySlice = chat.slice(sliceStart, sliceEnd);
        const userName = context.name1 || '用户';
        const characterName = context.name2 || '角色';

        const messages = historySlice.map((msg, index) => {
            let content = msg.mes;

            if (!msg.is_user && tagsToExtract && tagsToExtract.length > 0) {
                const blocks = extractBlocksByTags(content, tagsToExtract);
                content = blocks.join('\n\n');
            }
            
            if (content && exclusionRules) {
                content = applyExclusionRules(content, exclusionRules);
            }

            if (!content.trim()) return null;
            
            return {
                floor: sliceStart + index + 1, 
                author: msg.is_user ? userName : characterName,
                authorType: msg.is_user ? 'user' : 'char',
                content: content.trim()
            };
        }).filter(Boolean);
    
    if (messages.length === 0) {
        return null;
    }

    const formattedHistory = messages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');

    return `<对话记录>\n${formattedHistory}\n</对话记录>`;
}
