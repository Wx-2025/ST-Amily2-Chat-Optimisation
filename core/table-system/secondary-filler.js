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
        // --- 分步/批量填表逻辑 (重构版) ---
        const bufferSize = parseInt(settings.secondary_filler_buffer || 0, 10);
        const batchSize = parseInt(settings.secondary_filler_batch || 0, 10); // 0 = 实时/单条模式
        const contextLimit = parseInt(settings.secondary_filler_context || 2, 10);

        const chat = context.chat;
        const totalMessages = chat.length;
        
        // 计算有效填表区域的终点（排除 Buffer）
        // 例如：总长10，Buffer 2。ValidEnd = 10 - 1 - 2 = 7。
        // 即 index 8, 9 在 Buffer 内，不能填。
        const validEndIndex = totalMessages - 1 - bufferSize;

        if (validEndIndex < 0) {
            console.log(`[Amily2-副API] 消息数量不足以超出保留区(${bufferSize})，跳过。`);
            return;
        }

        // 收集需要填表的目标消息
        let targetMessages = [];
        let needsProcessing = false;

        // 简单的内容哈希生成器
        const getContentHash = (content) => {
            let hash = 0, i, chr;
            if (content.length === 0) return hash;
            for (i = 0; i < content.length; i++) {
                chr = content.charCodeAt(i);
                hash = ((hash << 5) - hash) + chr;
                hash |= 0; // Convert to 32bit integer
            }
            return hash;
        };

        // 从 ValidEndIndex 往前扫描，寻找未处理或已变更的消息
        for (let i = validEndIndex; i >= 0; i--) {
            const msg = chat[i];
            
            // 默认只处理 AI 消息用于填表核心（用户消息作为上下文）
            // 如果以后需要处理用户消息填表，这里需要调整
            if (msg.is_user) continue;

            // 检查状态
            const currentHash = getContentHash(msg.mes);
            const savedHash = msg.metadata?.Amily2_Process_Hash;
            
            const isUnprocessed = !savedHash;
            const isChanged = savedHash && savedHash !== currentHash;

            if (isUnprocessed || isChanged) {
                targetMessages.unshift({ index: i, msg: msg, hash: currentHash });
                
                // 如果是 Batch 模式，且攒够了
                if (batchSize > 0 && targetMessages.length >= batchSize) {
                    needsProcessing = true;
                    break;
                }
            } else {
                // 如果遇到一个已经处理且没变的消息
                // 在 Batch 模式下，我们要保持连续性吗？
                // 假设我们只处理最新的一批未处理消息。
                // 如果中间夹杂了已处理的，我们可能应该停止扫描？
                // 简化逻辑：只要遇到已处理的，就认为之前的都处理好了（除非用户回删）。
                // 为稳健起见，我们只向回扫描直到遇到已处理消息，或者扫完。
                break;
            }
        }

        // 决策逻辑
        if (targetMessages.length === 0) {
            console.log("[Amily2-副API] 没有发现需要处理的消息。");
            return;
        }

        if (batchSize > 0) {
            // 批量模式
            if (targetMessages.length < batchSize) {
                console.log(`[Amily2-副API] 批量模式: 累积 ${targetMessages.length}/${batchSize} 条，暂不触发。`);
                return;
            }
        } else {
            // 实时模式 (Batch=0)
            // 仅处理最新的一条有效消息（通常是 ValidEndIndex 那条，或者是刚重Roll的那条）
            // 如果扫描出多条（比如之前关了插件），为避免瞬间大量请求，我们只取最后一条（最新的）。
            targetMessages = [targetMessages[targetMessages.length - 1]];
        }

        console.log(`[Amily2-副API] 触发填表: 处理 ${targetMessages.length} 条消息。索引范围: ${targetMessages[0].index} - ${targetMessages[targetMessages.length-1].index}`);

        let tagsToExtract = [];
        let exclusionRules = [];
        if (settings.table_independent_rules_enabled) {
            tagsToExtract = (settings.table_tags_to_extract || '').split(',').map(t => t.trim()).filter(Boolean);
            exclusionRules = settings.table_exclusion_rules || [];
        }

        // 构建核心处理内容 (Core Content)
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

        // 构建上下文 (History Context)
        // 上下文应该截止到 targetMessages 第一条消息的前面
        const historyEndIndex = targetMessages[0].index - 1;
        // 使用用户设置的 history_limit (contextLimit)
        
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
                        // 旧的 contextHistory 逻辑已被上面的 historyContextStr 替代并整合进 coreContent
                        // 但为了兼容 Preset 顺序，我们可以把 historyContextStr 放在这里单独发，
                        // 或者上面的 coreContent 只放核心内容。
                        // 修正：将 historyContextStr 作为 System 消息在这里发送，currentInteractionContent 只包含 coreContent
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

        // 保存状态到最后一条处理的消息（或者所有处理的消息？）
        // 通常表格数据是依附在最后一条消息上的。
        // 但我们需要标记所有 processed 的消息，防止重复处理。
        const memoryState = getMemoryState();
        
        // 我们需要把状态保存到 targetMessages 的最后一条（时间最近的一条）
        const lastProcessedMsg = targetMessages[targetMessages.length - 1].msg;
        
        // 标记所有已处理消息
        for (const target of targetMessages) {
            if (!target.msg.metadata) target.msg.metadata = {};
            target.msg.metadata.Amily2_Process_Hash = target.hash;
        }

        // 保存 MemoryState 到最后一条
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
