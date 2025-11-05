import { getContext, extension_settings } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { extractBlocksByTags, applyExclusionRules } from './utils/rag-tag-extractor.js';
import {
  world_names,
  loadWorldInfo,
  createNewWorldInfo,
  createWorldInfoEntry,
  saveWorldInfo,
} from "/scripts/world-info.js";
import { extensionName } from "../utils/settings.js";
import { getChatIdentifier } from "./lore.js";
import { compatibleWriteToLorebook } from "./tavernhelper-compatibility.js";
import { ingestTextToHanlinyuan } from "./rag-processor.js";
import { showSummaryModal, showHtmlModal } from "../ui/page-window.js";
import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { callAI, generateRandomSeed } from "./api.js";
import { callNgmsAI } from "./api/Ngms_api.js";

let isExpeditionRunning = false; 
let manualStopRequested = false; 

const RUNNING_LOG_COMMENT = "【敕史局】对话流水总帐";
const PROGRESS_SEAL_REGEX =
  /本条勿动【前(\d+)楼总结已完成】否则后续总结无法进行。$/;

async function readGoldenLedgerProgress(targetLorebookName) {
  if (!targetLorebookName) return 0;
  try {
    const bookData = await loadWorldInfo(targetLorebookName);
    if (!bookData || !bookData.entries) return 0;
    const ledgerEntry = Object.values(bookData.entries).find(
      (e) => e.comment === RUNNING_LOG_COMMENT && !e.disable,
    );
    if (!ledgerEntry) return 0;
    const match = ledgerEntry.content.match(PROGRESS_SEAL_REGEX);
    return match ? parseInt(match[1], 10) : 0;
  } catch (error) {
    console.error(`[大史官] 阅览《${targetLorebookName}》天机时出错:`, error);
    return 0;
  }
}

export async function checkAndTriggerAutoSummary() {
  if (isExpeditionRunning) {
    return;
  }

  const settings = extension_settings[extensionName];
  if (!settings.historiographySmallAutoEnable) return;

  const context = getContext();
  let targetLorebookName = null;
  switch (settings.lorebookTarget) {
    case "character_main":
      targetLorebookName =
        characters[context.characterId]?.data?.extensions?.world;
      break;
    case "dedicated":
      const chatIdentifier = await getChatIdentifier();
      targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
      break;
    default:
      return;
  }

  if (!targetLorebookName) return;

  const characterCount = await readGoldenLedgerProgress(targetLorebookName);
  const currentChatLength = context.chat.length;
  const retentionCount = settings.historiographyRetentionCount ?? 5;
  const summarizableLength = currentChatLength - retentionCount;
  const unsummarizedCount = summarizableLength - characterCount;

  if (unsummarizedCount >= settings.historiographySmallTriggerThreshold) {
    const batchSize = settings.historiographySmallTriggerThreshold;
    const startFloor = characterCount + 1;
    const endFloor = Math.min(characterCount + batchSize, summarizableLength);
    
    console.log(`[大史官] 自动微言录已触发，处理 ${startFloor} 至 ${endFloor} 楼。`);
    const isInteractive = settings.historiographyAutoSummaryInteractive ?? false;
    await executeManualSummary(startFloor, endFloor, !isInteractive);
  }
}

export async function getAvailableWorldbooks() {
  return [...world_names];
}

export async function getLoresForWorldbook(bookName) {
  if (!bookName) return [];
  try {
    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) return [];
    return Object.entries(bookData.entries)
      .filter(([, entry]) => !entry.disable)
      .map(([key, entry]) => ({
        key: key,
        comment: entry.comment || "无标题条目",
      }));
  } catch (error) {
    console.error(`[大史官] 检阅《${bookName}》时出错:`, error);
    return [];
  }
}

export async function executeManualSummary(startFloor, endFloor, isAuto = false) {
    return new Promise(async (resolve) => {
        const toastTitle = isAuto ? "微言录 (自动)" : "微言录 (手动)";
        const context = getContext();
        
        if (isAuto) {
            const messages = getRawMessagesForSummary(startFloor, endFloor);
            if (!messages || messages.length === 0) {
                toastr.warning("自动巡录：未找到符合条件的消息。", toastTitle);
                return resolve(false);
            }
            const textToSummarize = messages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');
            const summary = await getSummary(textToSummarize, toastTitle);
            
            if (summary) {
                showSummaryModal(summary, {
                    onConfirm: async (finalSummary) => {
                        const success = await writeSummary(finalSummary, startFloor, endFloor, toastTitle);
                        resolve(success);
                    },
                    onRegenerate: async (summaryDialog) => {
                        summaryDialog.find('textarea').prop('disabled', true).val('正在重新生成，请稍候...');
                        const newSummary = await getSummary(textToSummarize, toastTitle);
                        if (newSummary) {
                            summaryDialog.find('textarea').prop('disabled', false).val(newSummary);
                        } else {
                            summaryDialog.find('textarea').prop('disabled', false).val(summary);
                            toastr.error("重新生成失败，已恢复原始内容。", "模型召唤失败");
                        }
                    },
                    onCancel: () => {
                        toastr.info("本批次总结已取消。", toastTitle);
                        resolve(false);
                    },
                });
            } else {
                resolve(false);
            }
            return;
        }

        const messages = getRawMessagesForSummary(startFloor, endFloor);
        if (!messages || messages.length === 0) {
            toastr.warning("选定的楼层范围内无有效对话或内容被规则排除。", "圣谕有误");
            return resolve(false);
        }

        const generateModalHtml = (msgList) => {
            const messageHtml = msgList.map(msg => `
                <details class="historiography-message-item" data-author-type="${msg.authorType}">
                    <summary>【第 ${msg.floor} 楼】 ${msg.author}</summary>
                    <div class="historiography-editor-container">
                        <textarea class="text_pole" data-floor="${msg.floor}">${msg.content}</textarea>
                    </div>
                </details>
            `).join('');

            return `
                <div id="historiography-preview-controls">
                    <label><input type="checkbox" id="hist-include-user" checked> ${context.name1 || '用户'}</label>
                    <label><input type="checkbox" id="hist-include-char" checked> ${context.name2 || '角色'}</label>
                </div>
                <div id="historiography-preview-container">${messageHtml}</div>
                <style>
                    #historiography-preview-controls { margin-bottom: 10px; display: flex; gap: 15px; }
                    #historiography-preview-container { height: 65vh; overflow-y: auto; border: 1px solid #444; padding: 5px; }
                    .historiography-message-item { margin-bottom: 5px; }
                    .historiography-message-item[hidden] { display: none; }
                    .historiography-message-item summary { cursor: pointer; padding: 5px; background-color: #333; }
                    .historiography-editor-container { padding: 10px; border: 1px solid #444; border-top: none; }
                    .historiography-editor-container textarea { height: 150px; resize: vertical; }
                </style>
            `;
        };

        const modalHtml = generateModalHtml(messages);

        showHtmlModal('原文预览与编辑', modalHtml, {
            okText: '确认原文并总结',
            cancelText: '取消',
            onOpen: (dialog) => {
                const userCheckbox = dialog.find('#hist-include-user');
                const charCheckbox = dialog.find('#hist-include-char');
                const container = dialog.find('#historiography-preview-container');

                const updateVisibility = () => {
                    const includeUser = userCheckbox.is(':checked');
                    const includeChar = charCheckbox.is(':checked');
                    container.find('.historiography-message-item').each(function() {
                        const item = $(this);
                        const authorType = item.data('author-type');
                        const shouldBeHidden = (authorType === 'user' && !includeUser) || (authorType === 'char' && !includeChar);
                        item.toggle(!shouldBeHidden);
                    });
                };

                userCheckbox.on('change', updateVisibility);
                charCheckbox.on('change', updateVisibility);
            },
            onOk: async (dialog) => {
                const includeUser = dialog.find('#hist-include-user').is(':checked');
                const includeChar = dialog.find('#hist-include-char').is(':checked');
                
                const textToSummarize = dialog.find('.historiography-message-item')
                    .filter(function() {
                        const authorType = $(this).data('author-type');
                        if (authorType === 'user' && !includeUser) return false;
                        if (authorType === 'char' && !includeChar) return false;
                        return true;
                    })
                    .find('textarea')
                    .map(function() {
                        const floor = $(this).data('floor');
                        const author = $(this).closest('.historiography-message-item').find('summary').text().replace(`【第 ${floor} 楼】 `, '');
                        return `【第 ${floor} 楼】 ${author}: ${$(this).val()}`;
                    }).get().join('\n');

                if (!textToSummarize.trim()) {
                    toastr.error("请至少选择一条消息进行总结！", "圣谕有误");
                    return;
                }
                
                const dialogElement = dialog[0];
                if (dialogElement && typeof dialogElement.close === 'function') {
                    dialogElement.close();
                }
                dialog.remove();
                
                const summary = await getSummary(textToSummarize, toastTitle);
                if (summary) {
                    showSummaryModal(summary, {
                        onConfirm: async (finalSummary) => {
                            const success = await writeSummary(finalSummary, startFloor, endFloor, toastTitle);
                            resolve(success);
                        },
                        onRegenerate: async (summaryDialog) => {
                            summaryDialog.find('textarea').prop('disabled', true).val('正在重新生成，请稍候...');
                            const newSummary = await getSummary(textToSummarize, toastTitle);
                            if (newSummary) {
                                summaryDialog.find('textarea').prop('disabled', false).val(newSummary);
                            } else {
                                summaryDialog.find('textarea').prop('disabled', false).val(summary);
                                toastr.error("重新生成失败，已恢复原始内容。", "模型召唤失败");
                            }
                        },
                        onCancel: () => {
                            toastr.info("本批次总结已取消。", "操作已取消");
                            resolve(false);
                        },
                    });
                } else {
                    resolve(false);
                }
            },
            onCancel: () => {
                toastr.info("操作已取消。", toastTitle);
                resolve(false);
            }
        });
    });
}

function getRawMessagesForSummary(startFloor, endFloor) {
    const context = getContext();
    const chat = context.chat;
    const settings = extension_settings[extensionName];

    const historySlice = chat.slice(startFloor - 1, endFloor);
    if (historySlice.length === 0) return null;

    const userName = context.name1 || '用户';
    const characterName = context.name2 || '角色';
    
    const useTagExtraction = settings.historiographyTagExtractionEnabled ?? false;
    const tagsToExtract = useTagExtraction ? (settings.historiographyTags || '').split(',').map(t => t.trim()).filter(Boolean) : [];
    const exclusionRules = settings.historiographyExclusionRules || [];

    const messages = historySlice.map((msg, index) => {
        let content = msg.mes;

        if (useTagExtraction && tagsToExtract.length > 0) {
            const blocks = extractBlocksByTags(content, tagsToExtract);
            if (blocks.length > 0) {
                content = blocks.join('\n\n');
            }
        }

        content = applyExclusionRules(content, exclusionRules);
        
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

async function getSummary(formattedHistory, toastTitle) {
    toastr.info(`正在为您熔铸对话历史...`, toastTitle);
    const settings = extension_settings[extensionName];
    const presetPrompts = await getPresetPrompts('small_summary');
    
    // 获取混合排序
    let mixedOrder;
    try {
        const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
        if (savedOrder) {
            mixedOrder = JSON.parse(savedOrder);
        }
    } catch (e) {
        console.error("[大史官] 加载混合顺序失败:", e);
    }
    const order = getMixedOrder('small_summary') || [];

    const messages = [
        { role: 'system', content: generateRandomSeed() }
    ];
    
    // 根据混合排序添加提示词
    let promptCounter = 0; // 用于跟踪已处理的提示词数量
    
    for (const item of order) {
        if (item.type === 'prompt') {
            // 处理普通提示词 - getPresetPrompts已经按照mixedOrder排序，直接按顺序使用
            if (presetPrompts && presetPrompts[promptCounter]) {
                messages.push(presetPrompts[promptCounter]);
                promptCounter++; // 递增计数器
            }
        } else if (item.type === 'conditional') {
            // 处理条件块
            switch (item.id) {
                case 'jailbreakPrompt':
                    if (settings.historiographySmallJailbreakPrompt) {
                        messages.push({ role: "system", content: settings.historiographySmallJailbreakPrompt });
                    }
                    break;
                case 'summaryPrompt':
                    if (settings.historiographySmallSummaryPrompt) {
                        messages.push({ role: "system", content: settings.historiographySmallSummaryPrompt });
                    }
                    break;
                case 'coreContent':
                    messages.push({ role: 'user', content: `请严格根据以下"对话记录"中的内容进行总结，不要添加任何额外信息。\n\n<对话记录>\n${formattedHistory}\n</对话记录>` });
                    break;
            }
        }
    }

    const summary = settings.ngmsEnabled ? await callNgmsAI(messages) : await callAI(messages);
    console.log('[大史官-微言录] AI回复的全部内容:', summary);
    return summary;
}

async function writeSummary(summary, startFloor, endFloor, toastTitle) {
    const settings = extension_settings[extensionName];
    const context = getContext();
    const shouldWriteToLorebook = settings.historiographyWriteToLorebook ?? true;
    const shouldIngestToRag = settings.historiographyIngestToRag ?? false;

    if (!shouldWriteToLorebook && !shouldIngestToRag) {
        toastr.warning("“写入史册”和“存入翰林院”均未启用，总结任务已完成但未保存。", toastTitle);
        return true;
    }

    if (shouldIngestToRag) {
        try {
            let targetLorebookName;
            switch (settings.lorebookTarget) {
                case "character_main":
                    targetLorebookName = characters[context.characterId]?.data?.extensions?.world;
                    if (!targetLorebookName) throw new Error("当前角色未绑定主世界书，无法为翰林院确定目标。");
                    break;
                case "dedicated":
                    const chatIdentifier = await getChatIdentifier();
                    targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
                    break;
                default: throw new Error("未知的史册写入指令，无法为翰林院确定目标。");
            }

            toastr.info('正在将此份“微言录”送往翰林院...', '翰林院');
            const metadata = {
                bookName: targetLorebookName,
                entryName: `微言录总结: ${startFloor}-${endFloor}楼`
            };
            const result = await ingestTextToHanlinyuan(summary, 'lorebook', metadata);
            if (result.success) toastr.success(`翰林院已成功接收记忆碎片！`, '翰林院');
            else throw new Error(result.error);
        } catch (ragError) {
            console.error('[翰林院] 向量化处理失败:', ragError);
            toastr.error(`送往翰林院的文书处理失败: ${ragError.message}`, '翰林院');
        }
    }

    if (shouldWriteToLorebook) {
        try {
            let targetLorebookName;
            switch (settings.lorebookTarget) {
                case "character_main":
                    targetLorebookName = characters[context.characterId]?.data?.extensions?.world;
                    if (!targetLorebookName) throw new Error("当前角色未绑定主世界书。");
                    break;
                case "dedicated":
                    const chatIdentifier = await getChatIdentifier();
                    targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
                    break;
                default: throw new Error("未知的史册写入指令。");
            }

            const contentUpdateCallback = (oldContent) => {
                const newSeal = `\n\n本条勿动【前${endFloor}楼总结已完成】否则后续总结无法进行。`;
                const newChapter = `\n\n---\n\n【${startFloor}楼至${endFloor}楼详细总结记录】\n${summary}`;
                if (oldContent) {
                    const contentWithoutSeal = oldContent.replace(PROGRESS_SEAL_REGEX, "").trim();
                    return contentWithoutSeal + newChapter + newSeal;
                } else {
                    const firstChapter = `以下是依照顺序已发生剧情` + newChapter;
                    return firstChapter + newSeal;
                }
            };

            console.log('[大史官-调试] 读取到的原始设置:', {
                loreActivationMode: settings.loreActivationMode,
                loreInsertionPosition: settings.loreInsertionPosition,
                loreDepth: settings.loreDepth,
                loreKeywords: settings.loreKeywords
            });

            const optionsForNewEntry = {
                keys: (settings.loreKeywords.split(",").map(k => k.trim()).filter(Boolean)),
                isConstant: settings.loreActivationMode !== 'keyed', 
                insertion_position: settings.loreInsertionPosition,
                depth: settings.loreDepth,
            };

            console.log('[大史官-调试] 构建并传递的选项:', optionsForNewEntry);

            const success = await compatibleWriteToLorebook(
                targetLorebookName,
                RUNNING_LOG_COMMENT,
                contentUpdateCallback,
                optionsForNewEntry
            );

            if (success) {
                toastr.success(`编年史已成功更新！`, `${toastTitle} - 国史馆`);
                return true;
            } else {
                // 错误已在 compatibleWriteToLorebook 内部处理和记录
                return false;
            }

        } catch (error) {
            console.error(`[大史官] ${toastTitle}写入国史馆失败:`, error);
            toastr.error(`写入国史馆时发生错误: ${error.message}`, "国史馆");
            return false;
        }
    }
    return true;
}

const CHAPTER_SEAL_REGEX = /【前(\d+)楼篇章编撰已完成】/;

export async function executeRefinement(worldbook, loreKey) {
    toastr.info(`遵旨！正在为您重铸《${worldbook}》中的【微言录合集】...`, "宏史卷重铸");

    try {
        const bookData = await loadWorldInfo(worldbook);
        const entry = bookData?.entries[loreKey];
        if (!entry) {
            toastr.error("找不到指定的史册条目，重铸任务中止。", "圣谕有误");
            return;
        }

        const originalContent = entry.content;
        const settings = extension_settings[extensionName];

        const progressSealMatch = originalContent.match(PROGRESS_SEAL_REGEX);
        if (!progressSealMatch) {
            toastr.error("史册缺少【流水金印】，无法执行重铸。", "结构异常");
            return;
        }
        const progressSeal = progressSealMatch[0];
        const totalFloors = parseInt(progressSealMatch[1], 10);

        const chapterSealMatch = originalContent.match(CHAPTER_SEAL_REGEX);
        let lockedContent = "";
        let contentToRefine = "";
        let oldChapterFloor = 0;

        if (chapterSealMatch) {
            const chapterSealText = chapterSealMatch[0];
            oldChapterFloor = parseInt(chapterSealMatch[1], 10);
            const contentParts = originalContent.split(chapterSealText);
            lockedContent = contentParts[0].trim();
            contentToRefine = contentParts[1].replace(PROGRESS_SEAL_REGEX, '').trim();
        } else {
            contentToRefine = originalContent.replace(PROGRESS_SEAL_REGEX, '').trim();
        }

        if (!contentToRefine.trim()) {
            toastr.warning("史册条目中没有新的内容可供重铸。", "国库无新事");
            return;
        }

        const presetPrompts = await getPresetPrompts('large_summary');

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[大史官] 加载混合顺序失败:", e);
        }
        const order = getMixedOrder('large_summary') || [];

        
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
                    case 'jailbreakPrompt':
                        if (settings.historiographyLargeJailbreakPrompt) {
                            messages.push({ role: "system", content: settings.historiographyLargeJailbreakPrompt });
                        }
                        break;
                    case 'summaryPrompt':
                        if (settings.historiographyLargeRefinePrompt) {
                            messages.push({ role: "system", content: settings.historiographyLargeRefinePrompt });
                        }
                        break;
                    case 'coreContent':
                        messages.push({ role: "user", content: `请将以下多个零散的"详细总结记录"提炼并融合成一段连贯的章节历史。原文如下：\n\n${contentToRefine}` });
                        break;
                }
            }
        }

        const getRefinedContent = async () => {
            toastr.info("正在召唤模型进行内容精炼...", "宏史卷重铸");
            return settings.ngmsEnabled ? await callNgmsAI(messages) : await callAI(messages);
        };

        const initialRefinedContent = await getRefinedContent();
        if (!initialRefinedContent) {
            toastr.error("模型未能返回有效的精炼内容。", "宏史卷重铸失败");
            return;
        }

        const processLoop = async (currentRefinedContent) => {
            showSummaryModal(currentRefinedContent, {
                onConfirm: async (editedText) => {
                    let finalContent;
                    const newChapterSeal = `\n\n【前${totalFloors}楼篇章编撰已完成】`;

                    const shouldVectorize = document.getElementById('amily2_vectorize_summary_content')?.checked ?? false;

                    if (shouldVectorize && chapterSealMatch) {
                        try {
                            toastr.info(`正在将前 ${oldChapterFloor} 楼的“宏史卷”内容送往翰林院...`, '翰林院');
                            
                            const metadata = {
                                bookName: worldbook,
                                entryName: `宏史卷总结: 1-${oldChapterFloor}楼`
                            };
                            const ingestResult = await ingestTextToHanlinyuan(lockedContent, 'lorebook', metadata);
                            if (!ingestResult.success) {
                                throw new Error(ingestResult.error || "未知错误");
                            }
                            toastr.success(`翰林院已成功接收旧“宏史卷”记忆！新增 ${ingestResult.count} 条。`, '翰林院');

                            const replacementText = `AI你好，以上内容为rag向量化后注入的相关剧情，以下内容是已发生的剧情回顾。\n\n（前${oldChapterFloor}楼聊天记录总结已由翰林院向量化注入。）\n\n【以下内容为${oldChapterFloor}楼以后的总结内容】`;
                            
                            finalContent = `${replacementText}\n\n---\n\n${editedText}${newChapterSeal}\n\n${progressSeal}`;

                        } catch (error) {
                            console.error('[大史官-宏史卷向量化] 失败:', error);
                            toastr.error(`宏史卷向量化失败: ${error.message}，将执行标准保存。`, '翰林院');
                            const divider = `\n\n===【截止至第${oldChapterFloor}楼的宏史卷】===\n\n`;
                            finalContent = `${lockedContent}${divider}${editedText}${newChapterSeal}\n\n${progressSeal}`;
                        }
                    } else {
                        if (chapterSealMatch) {
                            const divider = `\n\n===【截止至第${oldChapterFloor}楼的宏史卷】===\n\n`;
                            finalContent = `${lockedContent}${divider}${editedText}${newChapterSeal}\n\n${progressSeal}`;
                        } else {
                            const header = `以下内容是【1楼-${totalFloors}楼】已发生的剧情回顾。\n\n---\n\n`;
                            finalContent = `${header}${editedText}${newChapterSeal}\n\n${progressSeal}`;
                        }
                    }

                    entry.content = finalContent;
                    await saveWorldInfo(worldbook, bookData, true);
                    toastr.success(`史册已成功重铸，并保存于《${worldbook}》！`, "宏史卷重铸完毕");
                },
                onRegenerate: async (dialog) => {
                    dialog.find('textarea').prop('disabled', true).val('正在重新生成，请稍候...');
                    const newContent = await getRefinedContent();
                    if (newContent) {
                        dialog.find('textarea').prop('disabled', false).val(newContent);
                    } else {
                        dialog.find('textarea').prop('disabled', false).val(currentRefinedContent);
                        toastr.error("重新生成失败，已恢复原始内容。", "模型召唤失败");
                    }
                },
                onCancel: () => {
                    toastr.info("宏史卷重铸操作已取消。", "操作已取消");
                },
            });
        };

        await processLoop(initialRefinedContent);

    } catch (error) {
        console.error("[大史官] 重铸任务失败:", error);
        toastr.error(`重铸史册时发生严重错误: ${error.message}`, "国史馆");
    }
}

export async function executeExpedition() {
    if (isExpeditionRunning) {
        toastr.info("远征军已在途中，无需重复下令。", "圣谕悉知");
        return;
    }

    isExpeditionRunning = true;
    manualStopRequested = false;
    document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: true } }));

    try {
        const settings = extension_settings[extensionName];
        const context = getContext();

        let targetLorebookName = null;
        switch (settings.lorebookTarget) {
            case "character_main":
                targetLorebookName = characters[context.characterId]?.data?.extensions?.world;
                if (!targetLorebookName) {
                    toastr.error("当前角色未绑定主世界书，远征军无法开拔！", "圣谕不明");
                    isExpeditionRunning = false;
                    document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: false, manualStop: false } }));
                    return;
                }
                break;
            case "dedicated":
                const chatIdentifier = await getChatIdentifier();
                targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
                break;
            default:
                toastr.error("未知的史册写入目标，远征军无法开拔！", "圣谕不明");
                isExpeditionRunning = false;
                document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: false, manualStop: false } }));
                return;
        }

        const summarizedCount = await readGoldenLedgerProgress(targetLorebookName);
        const retentionCount = settings.historiographyRetentionCount ?? 5;
        const totalHistory = context.chat.length;
        const summarizableLength = totalHistory - retentionCount;
        const remainingHistory = summarizableLength - summarizedCount;

        if (remainingHistory <= 0) {
            toastr.info("国史已是最新，远征军无需出动。", "凯旋");
            isExpeditionRunning = false;
            document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: false, manualStop: false } }));
            return;
        }

        const batchSize = settings.historiographySmallTriggerThreshold;
        const totalBatches = Math.ceil(remainingHistory / batchSize);
        toastr.info(`远征军已开拔！目标：${remainingHistory} 层历史，分 ${totalBatches} 批次征服！`, "远征开始");
        let currentProgress = summarizedCount;

        for (let i = 0; i < totalBatches; i++) {
            if (manualStopRequested) {
                toastr.warning("远征已遵从您的敕令暂停！随时可以【继续远征】。", "鸣金收兵");
                break;
            }

            const startFloor = currentProgress + 1;
            const endFloor = Math.min(currentProgress + batchSize, summarizableLength);
            const toastTitle = `远征战役 (${i + 1}/${totalBatches})`;

            const delay = 2000;
            if (i > 0) {
                toastr.info(`第 ${i + 1} 批次战役准备中... (${delay / 1000}秒后接敌)`, toastTitle);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            if (manualStopRequested) {
                toastr.warning("远征已在准备阶段遵令暂停！", "鸣金收兵");
                break;
            }

            const success = await executeManualSummary(startFloor, endFloor, false);
            if (success) {
                currentProgress = endFloor;
            } else {
                toastr.warning(`远征因第 ${i + 1} 批次任务失败而中止。`, "远征中止");
                manualStopRequested = true;
                break;
            }
        }

        if(!manualStopRequested) {
             toastr.success("凯旋！远征大捷！所有未载之史均已化为帝国永恒的记忆！", "远征完毕");
        }

    } catch (error) {
        console.error("[大史官-远征失败]", error);
        toastr.error("远征途中遭遇重大挫折，任务中止！您可以随时【继续远征】。", "远征失败");
    } finally {
        isExpeditionRunning = false;
        document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: false, manualStop: manualStopRequested } }));
    }
}

export function stopExpedition() {
    if (isExpeditionRunning) {
        manualStopRequested = true;
        toastr.info("停战敕令已下达！远征军将在完成当前批次的任务后休整。", "圣谕传达");
    } else {
        toastr.warning("远征军已在营中，无需下达停战敕令。", "圣谕悉知");
    }
}

export async function executeCompilation(worldbook, loreKeys) {
    if (!Array.isArray(loreKeys) || loreKeys.length === 0) {
        toastr.warning("未选择任何条目进行编纂。", "圣谕不明");
        return { success: false, error: "No lore keys provided." };
    }

    toastr.info(`遵旨！开始对《${worldbook}》中的 ${loreKeys.length} 个条目进行批量编纂...`, "翰林院入库");
    let totalSuccessCount = 0;
    let totalVectorCount = 0;
    let errors = [];

    try {
        const bookData = await loadWorldInfo(worldbook);
        if (!bookData || !bookData.entries) {
            throw new Error(`无法加载书库《${worldbook}》的数据。`);
        }

        for (const loreKey of loreKeys) {
            const entry = bookData.entries[loreKey];
            if (!entry) {
                errors.push(`条目【${loreKey}】未找到。`);
                continue;
            }

            const contentToIngest = entry.content;
            if (!contentToIngest.trim()) {
                errors.push(`条目【${entry.comment || loreKey}】内容为空。`);
                continue;
            }

            const metadata = {
                bookName: worldbook,
                entryName: entry.comment || loreKey
            };

            try {
                const ingestResult = await ingestTextToHanlinyuan(contentToIngest, 'lorebook', metadata);
                if (ingestResult.success) {
                    totalSuccessCount++;
                    totalVectorCount += ingestResult.count;
                } else {
                    errors.push(`条目【${entry.comment || loreKey}】处理失败: ${ingestResult.error}`);
                }
            } catch (ingestError) {
                errors.push(`条目【${entry.comment || loreKey}】处理时发生严重错误: ${ingestError.message}`);
            }
        }

        let finalMessage = `批量编纂完成！\n成功处理 ${totalSuccessCount} / ${loreKeys.length} 个条目，共新增 ${totalVectorCount} 条忆识。`;
        if (errors.length > 0) {
            finalMessage += `\n\n发生以下错误:\n- ${errors.join('\n- ')}`;
            toastr.warning("批量编纂期间发生部分错误，详情请查看控制台。", "翰林院");
            console.warn("[翰林院] 批量编纂错误详情:", errors);
        } else {
            toastr.success(`批量编纂大功告成！新增 ${totalVectorCount} 条忆识。`, '翰林院');
        }

        return { 
            success: errors.length === 0, 
            content: finalMessage,
            totalSuccess: totalSuccessCount,
            totalVectors: totalVectorCount,
            errors: errors
        };

    } catch (error) {
        console.error("[翰林院] 批量条目入库失败:", error);
        toastr.error(`批量入库失败: ${error.message}`, "翰林院");
        return { success: false, error: error.message };
    }
}
