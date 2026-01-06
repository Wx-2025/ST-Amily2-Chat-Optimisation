import { getContext, extension_settings } from '/scripts/extensions.js';
import { characters } from '/script.js';
import { loadWorldInfo } from '/scripts/world-info.js';
import { log } from './logger.js';
import { updateTableFromText } from './manager.js';
import { extensionName } from '../../utils/settings.js';
import { renderTables } from '../../ui/table-bindings.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';
import { extractBlocksByTags, applyExclusionRules } from '../utils/rag-tag-extractor.js';

import { getBatchFillerRuleTemplate, getBatchFillerFlowTemplate, convertTablesToCsvString } from './manager.js';

let isFilling = false;
let manualStopRequested = false;
let currentBatch = 0;
let totalBatches = 0;
let chatHistoryLength = 0;
let threshold = 30;
const MAX_RETRIES = 2; 


async function getWorldBookContext() {
    const settings = extension_settings[extensionName];
    if (!settings.table_worldbook_enabled) {
        return '';
    }

    const context = getContext();
    let bookNames = [];
    let content = '';

    if (settings.table_worldbook_source === 'character') {
        const characterId = context.characterId;
        const character = characters[characterId];
        const characterBook = character?.data?.extensions?.world;
        if (characterBook) {
            bookNames.push(characterBook);
        }
    } else {
        bookNames = settings.table_selected_worldbooks || [];
    }

    if (bookNames.length === 0) {
        return '';
    }

    const selectedEntriesConfig = settings.table_selected_entries || {};

    for (const bookName of bookNames) {
        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData || !bookData.entries) continue;

            const entriesToInclude = settings.table_worldbook_source === 'manual'
                ? (selectedEntriesConfig[bookName] || []).map(uid => String(uid))
                : Object.values(bookData.entries).map(entry => String(entry.uid));

            for (const entry of Object.values(bookData.entries)) {
                if (entriesToInclude.includes(String(entry.uid))) {
                    content += `[来源：世界书，条目名字：${entry.comment || '无标题条目'}]\n${entry.content}\n\n`;
                }
            }
        } catch (error) {
            log(`加载世界书 "${bookName}" 失败: ${error.message}`, 'error');
        }
    }

    if (content.length > settings.table_worldbook_char_limit) {
        content = content.substring(0, settings.table_worldbook_char_limit);
    }

    return content.trim() ? `<世界书>\n${content.trim()}\n</世界书>` : '';
}

const fillButton = () => document.getElementById('fill-table-now-btn');

function updateButtonState(state, batchNum = 0, attemptNum = 0) {
    const button = fillButton();
    if (!button) return;

    switch (state) {
        case 'processing':
            let attemptText = attemptNum > 0 ? ` (尝试 ${attemptNum + 1})` : '';
            button.textContent = `点击停止 (${batchNum}/${totalBatches})${attemptText}`;
            button.disabled = false;
            isFilling = true;
            break;
        case 'stopping':
            button.textContent = '正在停止...';
            button.disabled = true;
            break;
        case 'paused':
            button.textContent = '继续填表';
            button.disabled = false;
            isFilling = true;
            break;
        case 'error':
            button.textContent = '继续填表 (出错)';
            button.disabled = false;
            isFilling = true;
            break;
        case 'idle':
        default:
            button.textContent = '立即填表';
            button.disabled = false;
            isFilling = false;
            currentBatch = 0;
            manualStopRequested = false;
            break;
    }
}

async function callTableModel(messages) {
    try {
        const settings = extension_settings[extensionName];

        if (settings.nccsEnabled) {
            log('使用 Nccs API 进行表格填充...', 'info');
            const result = await callNccsAI(messages);
            if (!result) {
                throw new Error('Nccs API返回内容为空。');
            }
            return result;
        } else {
            log('使用默认 API 进行表格填充...', 'info');
            const result = await callAI(messages);
            if (!result) {
                throw new Error('API返回内容为空。');
            }
            return result;
        }
    } catch (error) {
        log(`与模型通讯时发生异常: ${error.message}`, "error");
        toastr.error(`与模型通讯时发生异常: ${error.message}`, "通讯异常");
        return null;
    }
}

function getRawMessagesForSummary(startFloor, endFloor) {
    const context = getContext();
    const chat = context.chat;
    const settings = extension_settings[extensionName];

    const historySlice = chat.slice(startFloor - 1, endFloor);
    if (historySlice.length === 0) return null;

    const userName = context.name1 || '用户';
    const characterName = context.name2 || '角色';
    
    let tagsToExtract = [];
    let exclusionRules = [];

    if (settings.table_independent_rules_enabled) {
        log('批量填表：使用独立提取规则。', 'info');
        tagsToExtract = (settings.table_tags_to_extract || '').split(',').map(t => t.trim()).filter(Boolean);
        exclusionRules = settings.table_exclusion_rules || [];
    }

    const messages = historySlice.map((msg, index) => {
        let content = msg.mes;

        if (tagsToExtract.length > 0) {
            const blocks = extractBlocksByTags(content, tagsToExtract);
            content = blocks.length > 0 ? blocks.join('\n\n') : '';
        }
        
        if (content) {
            content = applyExclusionRules(content, exclusionRules);
        }
        
        if (!content.trim()) return null;

        return {
            floor: startFloor + index,
            author: msg.is_user ? userName : characterName,
            authorType: msg.is_user ? 'user' : 'char',
            content: content.trim()
        };
    }).filter(Boolean);

    return messages;
}

async function runBatchAttempt(batchNum, attemptNum) {
    try {
        if (manualStopRequested) {
            log(`任务已在批次 ${batchNum} 开始前手动暂停。`, 'warn');
            updateButtonState('paused');
            return;
        }

        updateButtonState('processing', batchNum, attemptNum);

        const startFloor = (batchNum - 1) * threshold + 1;
        const endFloor = Math.min(startFloor + threshold - 1, chatHistoryLength);

        log(`正在处理批次 ${batchNum}/${totalBatches} (楼层 ${startFloor}-${endFloor}, 尝试 ${attemptNum + 1}/${MAX_RETRIES + 1})`, 'info');

        const purifiedMessages = getRawMessagesForSummary(startFloor, endFloor);
        if (!purifiedMessages || purifiedMessages.length === 0) {
            throw new Error('净化后无有效内容可处理。');
        }

        const batchContent = purifiedMessages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');
        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        const currentTableDataString = convertTablesToCsvString();
        const finalFlowPrompt = flowTemplate.replace('{{{Amily2TableData}}}', currentTableDataString);

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[批量填表] 加载混合顺序失败:", e);
        }
        const order = getMixedOrder('batch_filler') || [];

        const presetPrompts = await getPresetPrompts('batch_filler');
        
        const worldBookContext = await getWorldBookContext();
        
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

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
                            messages.push({ role: 'system', content: worldBookContext });
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"对话记录"中的内容进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<对话记录>\n${batchContent}\n</对话记录>` });
                        break;
                }
            }
        }

        if (!presetPrompts || presetPrompts.length === 0) {
            const defaultPrompts = [
                { role: 'system', content: generateRandomSeed() }
            ];
            messages.splice(1, 0, ...defaultPrompts);
        }

        console.groupCollapsed(`[Amily2 立即远征] 批次 ${batchNum}/${totalBatches} - 即将发送至 API 的内容`);
        console.dir(messages);
        console.groupEnd();

        const resultText = await callTableModel(messages);
        console.log(`[Amily2 立即远征] 批次 ${batchNum}/${totalBatches} - 收到 API 原始回复:`, resultText);
        if (!resultText) {
            throw new Error('API返回内容为空。');
        }

        // 【V155.0】批量填表时，启用立即删除模式，避免红色待删除行残留
        updateTableFromText(resultText, { immediateDelete: true });
        renderTables();
        log(`批次 ${batchNum} 处理成功。`, 'success');
        
        currentBatch = batchNum; 
        setTimeout(processNextBatch, 1000); 

    } catch (error) {
        log(`批次 ${batchNum} 尝试 ${attemptNum + 1} 失败: ${error.message}`, 'error');
        if (attemptNum >= MAX_RETRIES) {
            log(`批次 ${batchNum} 已达到最大重试次数，任务暂停。`, 'error');
            toastr.error(`批次 ${batchNum} 多次失败，请检查网络或API设置后手动继续。`, '任务暂停');
            currentBatch = batchNum - 1;
            updateButtonState('error');
        } else {
            log(`将在3秒后自动重试批次 ${batchNum}...`, 'warn');
            setTimeout(() => runBatchAttempt(batchNum, attemptNum + 1), 3000);
        }
    }
}

async function processNextBatch() {
    if (manualStopRequested) {
        log(`任务已在批次 ${currentBatch + 1} 开始前手动暂停。`, 'warn');
        updateButtonState('paused');
        return;
    }

    if (currentBatch >= totalBatches) {
        log('所有批次处理完毕！', 'success');
        updateButtonState('idle');
        return;
    }

    runBatchAttempt(currentBatch + 1, 0);
}

export function startBatchFilling() {
    const button = fillButton();
    if (!button) return;

    const settings = extension_settings[extensionName];
    const tableSystemEnabled = settings.table_system_enabled !== false; 
    if (!tableSystemEnabled) {
        log('表格系统总开关已关闭，跳过批量填表。', 'info');
        toastr.info('表格系统总开关已关闭，无法执行批量填表。');
        return;
    }

    if (isFilling) {
        if (button.textContent.startsWith('点击停止')) {
            manualStopRequested = true;
            updateButtonState('stopping');
            log('停战敕令已下达！将在当前批次完成后暂停。', 'warn');
        } else if (button.textContent.startsWith('继续填表')) {
            manualStopRequested = false;
            log('从上次暂停处继续处理...', 'info');
            processNextBatch();
        }
        return;
    }

    manualStopRequested = false;
    const context = getContext();
    chatHistoryLength = context.chat.length;
    threshold = parseInt(document.getElementById('batch-filling-threshold')?.value, 10) || 30;
    
    const ruleTemplate = getBatchFillerRuleTemplate();
    const flowTemplate = getBatchFillerFlowTemplate();

    if (!ruleTemplate || !flowTemplate) {
        log('规则或流程提示词为空，无法开始填表。', 'error');
        toastr.error('请确保"规则提示词"和"流程提示词"都已填写。', '无法开始');
        return;
    }

    if (chatHistoryLength === 0) {
        log('聊天记录为空，无需填表。', 'info');
        return;
    }

    totalBatches = Math.ceil(chatHistoryLength / threshold);
    currentBatch = 0;

    const startFloorInput = document.getElementById('floor-start-input');
    console.log('[Amily2 Debug] startFloorInput found:', !!startFloorInput);
    if (startFloorInput) {
        console.log('[Amily2 Debug] startFloorInput value:', startFloorInput.value);
        const val = parseInt(startFloorInput.value, 10);
        console.log('[Amily2 Debug] Parsed val:', val, 'Threshold:', threshold);
        
        if (!isNaN(val) && val > 1) {
            const startBatch = Math.ceil(val / threshold);
            console.log('[Amily2 Debug] Calculated startBatch:', startBatch);
            currentBatch = startBatch - 1;
            log(`根据设定，将从第 ${startBatch} 批次（包含楼层 ${val}）开始执行。`, 'info');
        } else {
            console.log('[Amily2 Debug] Value is NaN or <= 1');
        }
    } else {
        console.log('[Amily2 Debug] startFloorInput element not found');
    }

    log(`准备开始批量填表任务，共 ${totalBatches} 个批次。`, 'info');
    processNextBatch();
}


export async function startFloorRangeFilling(startFloor, endFloor) {
    const settings = extension_settings[extensionName];
    const tableSystemEnabled = settings.table_system_enabled !== false;
    if (!tableSystemEnabled) {
        log('表格系统总开关已关闭，跳过楼层填表。', 'info');
        toastr.info('表格系统总开关已关闭，无法执行楼层填表。');
        return;
    }

    const context = getContext();
    const currentChatLength = context.chat.length;

    if (endFloor > currentChatLength) {
        toastr.warning(`结束楼层 ${endFloor} 超出了当前聊天记录长度 ${currentChatLength}。`);
        return;
    }

    const ruleTemplate = getBatchFillerRuleTemplate();
    const flowTemplate = getBatchFillerFlowTemplate();

    if (!ruleTemplate || !flowTemplate) {
        log('规则或流程提示词为空，无法开始楼层填表。', 'error');
        toastr.error('请确保"规则提示词"和"流程提示词"都已填写。', '无法开始');
        return;
    }

    try {
        log(`开始处理楼层 ${startFloor}-${endFloor} 的内容...`, 'info');
        
        const purifiedMessages = getRawMessagesForSummary(startFloor, endFloor);
        if (!purifiedMessages || purifiedMessages.length === 0) {
            toastr.warning('指定楼层范围内没有有效内容可处理。');
            return;
        }

        const batchContent = purifiedMessages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');
        const currentTableDataString = convertTablesToCsvString();
        const finalFlowPrompt = flowTemplate.replace('{{{Amily2TableData}}}', currentTableDataString);

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[楼层填表] 加载混合顺序失败:", e);
        }
        const order = getMixedOrder('batch_filler') || [];

        const presetPrompts = await getPresetPrompts('batch_filler');
        
        const worldBookContext = await getWorldBookContext();

        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

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
                            messages.push({ role: 'system', content: worldBookContext });
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"对话记录"中的内容进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<对话记录>\n${batchContent}\n</对话记录>` });
                        break;
                }
            }
        }

        if (!presetPrompts || presetPrompts.length === 0) {
            const defaultPrompts = [
                { role: 'system', content: generateRandomSeed() }
            ];
            messages.splice(1, 0, ...defaultPrompts);
        }

        console.groupCollapsed(`[Amily2 楼层填表] 楼层 ${startFloor}-${endFloor} - 即将发送至 API 的内容`);
        console.dir(messages);
        console.groupEnd();

        const resultText = await callTableModel(messages);
        console.log(`[Amily2 楼层填表] 楼层 ${startFloor}-${endFloor} - 收到 API 原始回复:`, resultText);
        
        if (!resultText) {
            throw new Error('API返回内容为空。');
        }

        updateTableFromText(resultText, { immediateDelete: true });
        renderTables();
        
        toastr.success(`楼层 ${startFloor}-${endFloor} 填表完成！`);
        log(`楼层 ${startFloor}-${endFloor} 填表处理完成。`, 'success');
        
    } catch (error) {
        log(`楼层 ${startFloor}-${endFloor} 填表失败: ${error.message}`, 'error');
        toastr.error(`楼层填表失败: ${error.message}`, '处理失败');
    }
}


export async function startCurrentFloorFilling() {
    const context = getContext();
    const currentFloor = context.chat.length;
    
    if (currentFloor === 0) {
        toastr.info('当前没有聊天记录。');
        return;
    }
    
    log(`准备填写当前楼层（第 ${currentFloor} 楼）...`, 'info');
    await startFloorRangeFilling(currentFloor, currentFloor);
}
