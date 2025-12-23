import { getContext, extension_settings } from "/scripts/extensions.js";
import { loadWorldInfo } from "/scripts/world-info.js";
import { saveChat } from "/script.js";
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { extensionName } from "../../utils/settings.js";
import { updateTableFromText, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate, convertTablesToCsvString, saveStateToMessage, getMemoryState, clearHighlights } from './manager.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';
import { extractBlocksByTags, applyExclusionRules } from '../utils/rag-tag-extractor.js';
import { safeLorebookEntries } from '../tavernhelper-compatibility.js';


async function getWorldBookContext() {
    const settings = extension_settings[extensionName];

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

export async function fillWithSecondaryApi(latestMessage, forceRun = false) {
    clearHighlights();

    const context = getContext();
    if (context.chat.length <= 1) {
        console.log("[Amily2-副API] 聊天刚开始，跳过本次自动填表。");
        return;
    }

    const settings = extension_settings[extensionName];

    const fillingMode = settings.filling_mode || 'main-api';
    if (fillingMode !== 'secondary-api' && !forceRun) {
        log('当前非分步填表模式，且未强制执行，跳过。', 'info');
        return; 
    }

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }

    const { apiUrl, apiKey, model, temperature, maxTokens, forceProxyForCustomApi } = settings;
    if (!apiUrl || !model) {
        if (!window.secondaryApiUrlWarned) {
            toastr.error("主API的URL或模型未配置，分步填表功能无法启动。", "Amily2-分步填表");
            window.secondaryApiUrlWarned = true;
        }
        return;
    }

    try {
        const bufferSize = parseInt(settings.secondary_filler_buffer || 0, 10);
        const batchSize = parseInt(settings.secondary_filler_batch || 0, 10); 
        const contextLimit = parseInt(settings.secondary_filler_context || 2, 10);

        const chat = context.chat;
        const totalMessages = chat.length;
        
        const validEndIndex = totalMessages - 1 - bufferSize;

        if (validEndIndex < 0) {
            console.log(`[Amily2-副API] 消息数量不足以超出保留区(${bufferSize})，跳过。`);
            return;
        }

        let targetMessages = [];
        let needsProcessing = false;

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

        for (let i = validEndIndex; i >= 0; i--) {
            const msg = chat[i];
            
            if (msg.is_user) continue;

            const currentHash = getContentHash(msg.mes);
            const savedHash = msg.metadata?.Amily2_Process_Hash;
            
            const isUnprocessed = !savedHash;
            const isChanged = savedHash && savedHash !== currentHash;

            if (isUnprocessed || isChanged) {
                targetMessages.unshift({ index: i, msg: msg, hash: currentHash });
                
                if (batchSize > 0 && targetMessages.length >= batchSize) {
                    needsProcessing = true;
                    break;
                }
            } else {
                continue;
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

        console.log(`[Amily2-副API] 触发填表: 处理 ${targetMessages.length} 条消息。索引范围: ${targetMessages[0].index} - ${targetMessages[targetMessages.length-1].index}`);

        let tagsToExtract = [];
        let exclusionRules = [];
        if (settings.table_independent_rules_enabled) {
            tagsToExtract = (settings.table_tags_to_extract || '').split(',').map(t => t.trim()).filter(Boolean);
            exclusionRules = settings.table_exclusion_rules || [];
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

        let rawContent;
        if (settings.nccsEnabled) {
            console.log('[Amily2-副API] 使用 Nccs API 进行分步填表...');
            rawContent = await callNccsAI(messages);
        } else {
            console.log('[Amily2-副API] 使用默认 API 进行分步填表...');
            rawContent = await callAI(messages);
        }

        if (!rawContent) {
            console.error('[Amily2-副API] 未能获取AI响应内容。');
            return;
        }

        console.log("[Amily2号-副API-原始回复]:", rawContent);

        updateTableFromText(rawContent);

        const memoryState = getMemoryState();
        
        const lastProcessedMsg = targetMessages[targetMessages.length - 1].msg;
        
        for (const target of targetMessages) {
            if (!target.msg.metadata) target.msg.metadata = {};
            target.msg.metadata.Amily2_Process_Hash = target.hash;
        }

        if (saveStateToMessage(memoryState, lastProcessedMsg)) {
            renderTables();
            updateOrInsertTableInChat();
        }
        
        saveChat();

    } catch (error) {
        console.error(`[Amily2-副API] 发生严重错误:`, error);
        toastr.error(`副API填表失败: ${error.message}`, "严重错误");
    }
}

async function getHistoryContext(messagesToFetch, historyEndIndex, tagsToExtract, exclusionRules) {
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length === 0 || messagesToFetch <= 0) {
        return null;
    }

    const historyUntil = Math.max(0, historyEndIndex); 
    const messagesToExtract = Math.min(messagesToFetch, historyUntil);
    const startIndex = Math.max(0, historyUntil - messagesToExtract);
    const endIndex = historyUntil;

    const historySlice = chat.slice(startIndex, endIndex);
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
            floor: startIndex + index + 1, 
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
