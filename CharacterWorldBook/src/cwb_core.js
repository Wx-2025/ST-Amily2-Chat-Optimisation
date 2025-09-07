import { getContext } from '/scripts/extensions.js';
import { state, SCRIPT_ID_PREFIX } from './cwb_state.js';
import { logDebug, logError, showToastr, escapeHtml, cleanChatName, parseCustomFormat, isCwbEnabled } from './cwb_utils.js';
import { callCustomOpenAI } from './cwb_apiService.js';
import { saveDescriptionToLorebook, updateCharacterRosterLorebookEntry, manageAutoCardUpdateLorebookEntry, getTargetWorldBook } from './cwb_lorebookManager.js';
import { extractBlocksByTags, applyExclusionRules } from '../../core/utils/rag-tag-extractor.js';
import { getExtensionSettings } from '../../utils/settings.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { generateRandomSeed } from '../../core/api.js';

const { SillyTavern, TavernHelper, jQuery } = window;

let isUpdatingCard = false;
let isBatchUpdating = false;
let manualBatchStopRequested = false;
let currentBatchNum = 0;
let totalBatchesNum = 0;
const MAX_BATCH_RETRIES = 2;

export async function updateCardUpdateStatusDisplay($panel) {
    if (!$panel || !$panel.length) return;
    const $statusDisplay = $panel.find(`#${SCRIPT_ID_PREFIX}-card-update-status-display`);
    const $totalMessagesDisplay = $panel.find(`#${SCRIPT_ID_PREFIX}-total-messages-display`);

    $totalMessagesDisplay.text(`上下文总层数: ${state.allChatMessages.length}`);

    if (!state.currentChatFileIdentifier || state.currentChatFileIdentifier.startsWith('unknown_chat')) {
        $statusDisplay.text('当前聊天未知，无法获取更新状态。');
        return;
    }

    try {
        const context = SillyTavern.getContext();
        if (!context || !context.characterId) {
            $statusDisplay.text('没有选择角色。');
            return;
        }
        const bookName = await getTargetWorldBook();
        if (!bookName) {
            $statusDisplay.text('当前角色未设置主世界书或自定义世界书。');
            return;
        }
        const entries = await TavernHelper.getLorebookEntries(bookName);
        const entryPrefixForCurrentChat = `角色卡更新-${state.currentChatFileIdentifier}-`;

        let latestEntryToShow = null;
        let maxEndFloorOverall = -1;

        for (const entry of entries) {
            if (entry.comment && entry.comment.startsWith(entryPrefixForCurrentChat)) {
                const match = entry.comment.match(/-(\d+)-(\d+)$/);
                if (match && match[2]) {
                    const endFloor = parseInt(match[2], 10);
                    if (endFloor > maxEndFloorOverall) {
                        maxEndFloorOverall = endFloor;
                        latestEntryToShow = entry;
                    }
                }
            }
        }

        if (latestEntryToShow) {
            const commentParts = latestEntryToShow.comment.split('-');
            const charNameInComment = commentParts.slice(2, -2).join('-');
            const startFloorStr = commentParts[commentParts.length - 2];
            const endFloorStr = commentParts[commentParts.length - 1];
            $statusDisplay.html(
                `最新更新: 角色 <b>${escapeHtml(charNameInComment)}</b> (基于楼层 <b>${startFloorStr}-${endFloorStr}</b>)`
            );
        } else {
            $statusDisplay.text('当前聊天信息尚未在世界书中更新。');
        }
    } catch (e) {
        logError('加载/解析世界书条目以更新UI状态时失败:', e);
        $statusDisplay.text('获取世界书更新状态时出错。');
    }
}

async function loadAllChatMessages($panel) {
    logDebug('尝试加载所有聊天消息...');
    if (!TavernHelper || !SillyTavern) {
        logError('用于加载消息的API不可用。');
        state.allChatMessages = [];
        return;
    }

    try {
        const context = SillyTavern.getContext();
        const chatLength = context?.chat?.length || 0;

        if (chatLength === 0) {
            logDebug('聊天为空，无需加载消息。');
            state.allChatMessages = [];
        } else {
            const lastMessageId = chatLength - 1;
            const messagesFromApi = await TavernHelper.getChatMessages(`0-${lastMessageId}`, { include_swipes: false });
            state.allChatMessages = Array.isArray(messagesFromApi) ? messagesFromApi.map((msg, idx) => ({ ...msg, id: idx })) : [];
        }
        
        logDebug(`成功为 ${state.currentChatFileIdentifier} 加载了 ${state.allChatMessages.length} 条消息。`);
        await updateCardUpdateStatusDisplay($panel);

    } catch (error) {
        logError('获取聊天消息时发生严重错误:', error);
        state.allChatMessages = [];
    }
}

function processChatMessages(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        logDebug('[CWB] processChatMessages: 没有可处理的消息。');
        return '';
    }

    logDebug(`[CWB] processChatMessages: 开始处理 ${messages.length} 条消息。`);
    
    try {
        const mainSettings = getExtensionSettings();
        if (!mainSettings) {
            logError('[CWB] 无法访问主扩展设置。将使用原始消息。');
            return messages.map(msg => `${msg.is_user ? SillyTavern?.name1 || '用户' : msg.name || '角色'}: ${msg.message}`).join('\n\n');
        }
        
        const useTagExtraction = mainSettings.historiographyTagExtractionEnabled ?? false;
        const tagsToExtract = useTagExtraction ? (mainSettings.historiographyTags || '').split(',').map(t => t.trim()).filter(Boolean) : [];
        const exclusionRules = mainSettings.historiographyExclusionRules || [];

        logDebug(`[CWB] 标签提取: ${useTagExtraction}, 标签: ${tagsToExtract.join(', ')}, 排除规则: ${exclusionRules.length}`);

        if (!useTagExtraction && exclusionRules.length === 0) {
            logDebug('[CWB] 未激活任何处理规则。返回合并后的原始消息。');
            return messages.map(msg => `${msg.is_user ? SillyTavern?.name1 || '用户' : msg.name || '角色'}: ${msg.message}`).join('\n\n');
        }

        const processedMessages = messages.map((msg) => {
            let content = msg.message;

            if (useTagExtraction && tagsToExtract.length > 0) {
                const blocks = extractBlocksByTags(content, tagsToExtract);
                if (blocks.length > 0) {
                    content = blocks.join('\n\n');
                }
            }
            
            content = applyExclusionRules(content, exclusionRules);
            
            if (!content.trim()) return null;

                    return `【${msg.is_user ? SillyTavern?.name1 || '用户' : msg.name || '角色'}】:\n${content.trim()}`;
        }).filter(Boolean);

        logDebug(`[CWB] processChatMessages: 处理完成。${messages.length} -> ${processedMessages.length} 条有效消息。`);
        return processedMessages.join('\n\n');
        
    } catch (error) {
        logError('[CWB] processChatMessages 中发生错误:', error);
        return messages.map(msg => `${msg.is_user ? SillyTavern?.name1 || '用户' : msg.name || '角色'}: ${msg.message}`).join('\n\n');
    }
}


async function proceedWithCardUpdate($panel, messagesToUse) {
    const statusUpdater = text => {
        if ($panel && $panel.length) {
            $panel.find(`#${SCRIPT_ID_PREFIX}-status-message`).text(text);
        }
    };
    statusUpdater('正在生成角色卡描述...');

    try {
        const mode = state.isIncrementalUpdateEnabled ? 'cwb_summarizer_incremental' : 'cwb_summarizer';
        const presetPrompts = getPresetPrompts(mode);
        const order = getMixedOrder(mode) || [];
        
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];
        let promptCounter = 0;
        let existingData = {};

        if (state.isIncrementalUpdateEnabled) {
            statusUpdater('增量更新模式：正在获取现有角色数据...');
            try {
                const bookName = await getTargetWorldBook();
                if (bookName) {
                    const entries = (await TavernHelper.getLorebookEntries(bookName)) || [];
                    let chatIdentifier = state.currentChatFileIdentifier.replace(/ imported/g, '');
                    
                    const characterEntries = entries.filter(e => 
                        e.enabled &&
                        Array.isArray(e.keys) &&
                        e.keys.includes(chatIdentifier) &&
                        !e.keys.includes('Amily2角色总集')
                    );

                    for (const entry of characterEntries) {
                        try {
                            const parsedData = parseCustomFormat(entry.content);
                            const entryCharName = parsedData?.name?.trim() || parsedData?.core_identity?.name?.trim();
                            if (entryCharName) {
                                existingData[entryCharName] = entry.content;
                            }
                        } catch (parseError) {
                            logError(`解析现有角色条目时出错 (UID: ${entry.uid}):`, parseError);
                        }
                    }
                    logDebug(`为 '${chatIdentifier}' 找到了 ${Object.keys(existingData).length} 个现有角色条目。`);
                }
            } catch (e) {
                logError('在增量更新中获取现有角色数据时出错:', e);
                showToastr('error', '获取旧档案失败，请检查控制台。');
            }
        }

        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++;
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'cwb_break_armor_prompt':
                        if (state.currentBreakArmorPrompt) {
                            messages.push({ role: "system", content: state.currentBreakArmorPrompt });
                        }
                        break;
                    case 'cwb_char_card_prompt':
                        if (state.currentCharCardPrompt) {
                            messages.push({ role: "system", content: state.currentCharCardPrompt });
                        }
                        break;
                    case 'cwb_incremental_char_card_prompt':
                        if (state.isIncrementalUpdateEnabled && state.currentIncrementalCharCardPrompt) {
                            messages.push({ role: "system", content: state.currentIncrementalCharCardPrompt });
                        }
                        break;
                    case 'oldFiles':
                        if (state.isIncrementalUpdateEnabled) {
                            let oldFilesContent = "【旧档案】\n";
                            if (Object.keys(existingData).length > 0) {
                                for (const charName in existingData) {
                                    oldFilesContent += `${existingData[charName]}\n`;
                                }
                            } else {
                                oldFilesContent += "无\n";
                            }
                            messages.push({ role: 'user', content: oldFilesContent });
                        }
                        break;
                    case 'newContext':
                        const processedText = processChatMessages(messagesToUse);
                        let newContextContent = "";
                        if (state.isIncrementalUpdateEnabled) {
                            newContextContent = "【新对话】\n";
                        } else {
                            newContextContent = "最近的聊天记录摘要:\n";
                        }

                        if (processedText) {
                            newContextContent += processedText;
                        } else {
                            newContextContent += "(无有效对话内容)";
                        }

                        if (!state.isIncrementalUpdateEnabled) {
                            newContextContent += "\n\n请根据以上聊天记录更新角色描述：";
                        }
                        messages.push({ role: 'user', content: newContextContent });
                        break;
                }
            }
        }

        statusUpdater('正在调用AI生成角色卡...');
        const aiResponse = await callCustomOpenAI(messages);
        if (!aiResponse) throw new Error('AI未能生成有效描述。');

        const endFloor_0idx = state.allChatMessages.length - 1;
        const startFloor_0idx = Math.max(0, state.allChatMessages.length - messagesToUse.length);

        const characterBlocks = aiResponse.split(/(?=\[--Amily2::CHAR_START--\])/).filter(block => block.trim());
        if (characterBlocks.length === 0) throw new Error('AI未能生成任何角色描述块。');

        let allSucceeded = true;
        let processedNames = [];

        for (const block of characterBlocks) {
            const trimmedBlock = block.trim();
            if (!trimmedBlock) continue;

            const parsedData = parseCustomFormat(trimmedBlock);
            const charName = (parsedData?.core_identity?.name?.trim() || parsedData?.name?.trim()) || 'UnknownCharacter';

            if (charName === 'UnknownCharacter') {
                logError('无法在块中找到角色名:', trimmedBlock);
                continue;
            }

            const success = await saveDescriptionToLorebook(charName, trimmedBlock, startFloor_0idx, endFloor_0idx);
            if (success) {
                processedNames.push(charName);
            } else {
                allSucceeded = false;
            }
        }

        if (processedNames.length > 0) {
            await updateCharacterRosterLorebookEntry([...new Set(processedNames)], startFloor_0idx, endFloor_0idx);
            statusUpdater(`已为 ${processedNames.length} 个角色更新描述！`);
        } else {
            throw new Error('AI生成了内容，但未能成功提取任何有效的角色卡。');
        }

        updateCardUpdateStatusDisplay($panel);
        return allSucceeded;
    } catch (error) {
        logError('角色卡更新过程出错:', error);
        showToastr('error', `更新失败: ${error.message}`);
        statusUpdater('错误：更新失败。');
        return false;
    }
}

async function triggerAutomaticUpdate($panel) {
    logDebug(`检查是否需要更新。总消息数: ${state.allChatMessages.length}, 自动更新启用: ${state.autoUpdateEnabled}`);
    if (!state.autoUpdateEnabled || isUpdatingCard || !state.customApiConfig.url || !state.customApiConfig.model || state.allChatMessages.length === 0) {
        logDebug('更新检查已跳过（未启用、正在更新、未配置或无消息）。');
        return;
    }

    let maxEndFloorInLorebook = 0;
    try {
        const context = SillyTavern.getContext();
        if (!context || !context.characterId) {
            logDebug('角色上下文未准备好，跳过自动更新的世界书检查。');
            return;
        }
        const bookName = await getTargetWorldBook();
        if (bookName) {
            const entries = (await TavernHelper.getLorebookEntries(bookName)) || [];
            const cleanChatId = state.currentChatFileIdentifier.replace(/ imported/g, '');
            const rosterEntry = entries.find(e => 
                Array.isArray(e.keys) &&
                e.keys.includes('Amily2角色总集') &&
                e.keys.includes(cleanChatId)
            );

            if (rosterEntry && rosterEntry.content) {
                const floorMatch = rosterEntry.content.match(/【前(\d+)楼角色世界书已更新完成】/);
                if (floorMatch && floorMatch[1]) {
                    maxEndFloorInLorebook = parseInt(floorMatch[1], 10);
                } else {
                    // Fallback for older entries
                    const floorRangeKey = rosterEntry.keys.find(k => /^\d+-\d+$/.test(k));
                    if (floorRangeKey) {
                        maxEndFloorInLorebook = parseInt(floorRangeKey.split('-')[1], 10);
                    }
                }
            }
        }
    } catch (e) {
        logError('从世界书获取最大结束楼层时出错:', e);
    }

    const unupdatedCount = state.allChatMessages.length - maxEndFloorInLorebook;
    logDebug(`未更新消息数: ${unupdatedCount} (阈值: ${state.autoUpdateThreshold}). 上次更新楼层: ${maxEndFloorInLorebook}.`);

    if (unupdatedCount >= state.autoUpdateThreshold) {
        showToastr('info', `检测到 ${unupdatedCount} 条新消息，将自动更新角色卡。`);
        const messagesToUse = state.allChatMessages.slice(maxEndFloorInLorebook);
        isUpdatingCard = true;
        await proceedWithCardUpdate($panel, messagesToUse);
        isUpdatingCard = false;
    }
}

export async function getLatestChatName() {
    let newChatFileIdentifier = 'unknown_chat_fallback';
    try {
        let chatNameFromCommand = await TavernHelper.triggerSlash('/getchatname');
        if (chatNameFromCommand && typeof chatNameFromCommand === 'string' && chatNameFromCommand.trim() && !['null', 'undefined'].includes(chatNameFromCommand.trim())) {
            newChatFileIdentifier = cleanChatName(chatNameFromCommand.trim());
        } else {
            const contextFallback = SillyTavern.getContext();
            if (contextFallback && contextFallback.chat) {
                newChatFileIdentifier = cleanChatName(contextFallback.chat);
            }
        }
    } catch (error) {
        logError('获取最新聊天名称时出错:', error);
    }
    return newChatFileIdentifier;
}

export async function handleMessageReceived($panel) {
    if (!isCwbEnabled('消息接收处理')) {
        return;
    }
    
    const context = SillyTavern.getContext();
    if (!context || !context.chat || !context.chat.length === 0) return;
    const latestMessage = context.chat[context.chat.length - 1];
    if (!latestMessage || latestMessage.is_user) {
        return;
    }

    await loadAllChatMessages($panel);
    await triggerAutomaticUpdate($panel);
}

export async function resetScriptStateForNewChat($panel, newChatName) {
    logDebug(`为新聊天重置脚本状态: "${newChatName}"`);
    state.allChatMessages = [];
    state.currentChatFileIdentifier = newChatName || 'unknown_chat_fallback';

    await loadAllChatMessages($panel);
    await manageAutoCardUpdateLorebookEntry();

    logDebug('状态重置完成。');
}

function updateBatchButtonState($panel, state, batchNum = 0, attemptNum = 0) {
    if (!$panel || !$panel.length) return;
    
    const $button = $panel.find('#cwb-batch-update-card');
    const $progress = $panel.find('#cwb-batch-progress');
    
    if (!$button.length) return;

    switch (state) {
        case 'processing':
            let attemptText = attemptNum > 0 ? ` (尝试 ${attemptNum + 1})` : '';
            $button.text(`点击停止 (${batchNum}/${totalBatchesNum})${attemptText}`);
            $button.prop('disabled', false);
            $progress.show().text(`正在处理批次 ${batchNum}/${totalBatchesNum}...`);
            isBatchUpdating = true;
            break;
        case 'stopping':
            $button.text('正在停止...');
            $button.prop('disabled', true);
            $progress.text('正在停止批量更新...');
            break;
        case 'paused':
            $button.text('继续批量更新');
            $button.prop('disabled', false);
            $progress.text('批量更新已暂停，点击继续...');
            isBatchUpdating = true;
            break;
        case 'error':
            $button.text('继续批量更新 (出错)');
            $button.prop('disabled', false);
            $progress.text('批量更新出错，请检查后继续...');
            isBatchUpdating = true;
            break;
        case 'idle':
        default:
            $button.text('立即批量更新');
            $button.prop('disabled', false);
            $progress.hide();
            isBatchUpdating = false;
            currentBatchNum = 0;
            manualBatchStopRequested = false;
            break;
    }
}


function getMessagesForFloorRange(startFloor, endFloor) {
    if (!state.allChatMessages || state.allChatMessages.length === 0) {
        return [];
    }
    
    // 转换为0-based索引
    const startIndex = Math.max(0, startFloor - 1);
    const endIndex = Math.min(state.allChatMessages.length, endFloor);
    
    if (startIndex >= endIndex) {
        return [];
    }
    
    return state.allChatMessages.slice(startIndex, endIndex);
}


async function runBatchUpdateAttempt($panel, batchNum, attemptNum) {
    try {
        if (manualBatchStopRequested) {
            logDebug(`批次 ${batchNum} 在开始前被手动停止。`);
            updateBatchButtonState($panel, 'paused');
            return;
        }

        updateBatchButtonState($panel, 'processing', batchNum, attemptNum);
        
        const startFloor = (batchNum - 1) * state.autoUpdateThreshold + 1;
        const endFloor = Math.min(startFloor + state.autoUpdateThreshold - 1, state.allChatMessages.length);

        logDebug(`正在处理批次 ${batchNum}/${totalBatchesNum} (楼层 ${startFloor}-${endFloor}, 尝试 ${attemptNum + 1}/${MAX_BATCH_RETRIES + 1})`);

        const messagesToProcess = getMessagesForFloorRange(startFloor, endFloor);
        if (!messagesToProcess || messagesToProcess.length === 0) {
            throw new Error('指定范围内无有效消息可处理。');
        }

        const success = await proceedWithCardUpdate($panel, messagesToProcess);
        if (!success) {
            throw new Error('角色卡更新失败。');
        }

        logDebug(`批次 ${batchNum} 处理成功。`);
        currentBatchNum = batchNum;

        setTimeout(() => processNextBatch($panel), 1000);

    } catch (error) {
        logError(`批次 ${batchNum} 尝试 ${attemptNum + 1} 失败: ${error.message}`);
        if (attemptNum >= MAX_BATCH_RETRIES) {
            logError(`批次 ${batchNum} 已达到最大重试次数，任务暂停。`);
            showToastr('error', `批次 ${batchNum} 多次失败，请检查网络或API设置后手动继续。`);
            currentBatchNum = batchNum - 1;
            updateBatchButtonState($panel, 'error');
        } else {
            logDebug(`将在3秒后自动重试批次 ${batchNum}...`);
            setTimeout(() => runBatchUpdateAttempt($panel, batchNum, attemptNum + 1), 3000);
        }
    }
}

async function processNextBatch($panel) {
    if (manualBatchStopRequested) {
        logDebug(`批次 ${currentBatchNum + 1} 在开始前被手动停止。`);
        updateBatchButtonState($panel, 'paused');
        return;
    }

    if (currentBatchNum >= totalBatchesNum) {
        logDebug('所有批次处理完毕！');
        showToastr('success', '批量更新完成！');
        updateBatchButtonState($panel, 'idle');
        return;
    }

    await runBatchUpdateAttempt($panel, currentBatchNum + 1, 0);
}

export async function startBatchUpdate($panel) {
    if (!state.customApiConfig.url || !state.customApiConfig.model) {
        showToastr('warning', '请先配置API信息。');
        return;
    }

    if (isBatchUpdating) {
        const $button = $panel.find('#cwb-batch-update-card');
        if ($button.text().startsWith('点击停止')) {
            manualBatchStopRequested = true;
            updateBatchButtonState($panel, 'stopping');
            logDebug('批量更新停止请求已发出！将在当前批次完成后暂停。');
        } else if ($button.text().startsWith('继续批量更新')) {
            manualBatchStopRequested = false;
            logDebug('从上次暂停处继续批量更新...');
            await processNextBatch($panel);
        }
        return;
    }

    manualBatchStopRequested = false;
    await loadAllChatMessages($panel);
    
    if (state.allChatMessages.length === 0) {
        showToastr('info', '当前没有聊天记录，无需更新。');
        return;
    }

    totalBatchesNum = Math.ceil(state.allChatMessages.length / state.autoUpdateThreshold);
    currentBatchNum = 0;

    logDebug(`准备开始批量更新任务，共 ${totalBatchesNum} 个批次。`);
    showToastr('info', `开始批量更新，共 ${totalBatchesNum} 个批次...`);
    
    await processNextBatch($panel);
}

export async function handleFloorRangeUpdate($panel) {
    if (isUpdatingCard || isBatchUpdating) {
        showToastr('info', '已有更新任务在进行中。');
        return;
    }
    
    if (!state.customApiConfig.url || !state.customApiConfig.model) {
        showToastr('warning', '请先配置API信息。');
        return;
    }

    const startFloor = parseInt($panel.find('#cwb-start-floor').val(), 10);
    const endFloor = parseInt($panel.find('#cwb-end-floor').val(), 10);

    if (!startFloor || !endFloor || startFloor <= 0 || endFloor <= 0) {
        showToastr('warning', '请输入有效的楼层范围。');
        return;
    }

    if (startFloor > endFloor) {
        showToastr('warning', '起始楼层不能大于结束楼层。');
        return;
    }

    await loadAllChatMessages($panel);
    
    if (endFloor > state.allChatMessages.length) {
        showToastr('warning', `结束楼层 ${endFloor} 超出了当前聊天记录长度 ${state.allChatMessages.length}。`);
        return;
    }

    const messagesToProcess = getMessagesForFloorRange(startFloor, endFloor);
    if (!messagesToProcess || messagesToProcess.length === 0) {
        showToastr('warning', '指定楼层范围内没有有效内容可处理。');
        return;
    }

    isUpdatingCard = true;
    const $button = $panel.find('#cwb-floor-range-update');
    $button.prop('disabled', true).text('更新中...');

    try {
        logDebug(`开始处理楼层 ${startFloor}-${endFloor} 的内容...`);
        const success = await proceedWithCardUpdate($panel, messagesToProcess);
        
        if (success) {
            showToastr('success', `楼层 ${startFloor}-${endFloor} 更新完成！`);
        }
    } finally {
        isUpdatingCard = false;
        $button.prop('disabled', false).text('楼层范围更新');
    }
}

export async function manualUpdateLogic($panel = null) {
    if (isUpdatingCard) {
        showToastr('info', '已有更新任务在进行中。');
        return;
    }
    if (!state.customApiConfig.url || !state.customApiConfig.model) {
        showToastr('warning', '请先配置API信息。');
        return;
    }

    isUpdatingCard = true;
    await loadAllChatMessages($panel);
    const messagesToProcess = state.allChatMessages.slice(-state.autoUpdateThreshold);
    await proceedWithCardUpdate($panel, messagesToProcess);
    isUpdatingCard = false;

    logDebug('手动更新完成。');
}

export async function handleManualUpdateCard($panel) {
    const $button = $panel.find(`#${SCRIPT_ID_PREFIX}-manual-update-card`);
    $button.prop('disabled', true).text('更新中...');
    await manualUpdateLogic($panel);
    $button.prop('disabled', false).text('立即更新角色描述');
}

export async function initializeCore($panel) {
    const initialChatName = await getLatestChatName();
    await resetScriptStateForNewChat($panel, initialChatName);
    logDebug('CWB 核心已初始化。基于事件的检查已激活。');
}
