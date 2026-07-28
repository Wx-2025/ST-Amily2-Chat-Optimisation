import { getContext, extension_settings } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { extractBlocksByTags, applyExclusionRules } from './utils/rag-tag-extractor.js';
import {
  world_names,
  loadWorldInfo,
  createNewWorldInfo,
  createWorldInfoEntry,
} from "/scripts/world-info.js";
import {
  saveBook as loreSaveBook,
  saveBookStrictUnlocked,
  mutateBookStrict,
  withLoreLock,
} from "./lore-service.js";
import { extensionName } from "../utils/settings.js";
import {
  getChatIdentifier,
  refreshWorldbookListOnly,
} from "./lore.js";
import { ingestTextToHanlinyuan } from "./rag-processor.js";
import { showSummaryModal, showHtmlModal } from "../ui/page-window.js";
import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { generateRandomSeed } from "./api.js";
import { callNgmsAI } from "./api/Ngms_api.js";
import { executeAutoHide } from "./autoHideManager.js";
import { resolveHistoriographyRuleConfig } from "../utils/config/RuleProfileManager.js";
import {
  PROGRESS_SEAL_REGEX,
  appendMicroSummaryBlock,
  buildRollingRefinementInput,
  containsReservedLedgerStructure,
  estimateHistoriographyMessagesTokens,
  estimateHistoriographyTokens,
  normalizeRefinementLimits,
  parseLedgerForRefinement,
  rollingLedgerFitsBudget,
} from "./historiography-ledger.js";

let reloadEditor = () => {
    console.warn("[大史官] reloadEditor 函数不可用，可能是旧版本。已使用空函数代替。");
};
(async () => {
    try {
        const { reloadEditor: importedReloadEditor } = await import("/scripts/world-info.js");
        if (importedReloadEditor) {
            reloadEditor = importedReloadEditor;
            console.log("[大史官] 已成功动态导入 reloadEditor。");
        }
    } catch (error) {
        console.warn("[大史官] 动态导入 reloadEditor 失败，将使用空函数。错误信息：", error.message);
    }
})();

let isExpeditionRunning = false; 
let manualStopRequested = false; 

// 渐进记忆远带（真压缩·产物编排）需要定位金账条目，故导出
export const RUNNING_LOG_COMMENT = "【敕史局】对话流水总帐";

export async function readGoldenLedgerProgress(targetLorebookName) {
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

const refinementReminderKeys = new Set();
const vectorizedRollingContentFingerprints = new Set();

async function runHistoriographyPostCommitEffect(label, effect) {
  try {
    await effect();
  } catch (error) {
    // The ledger is already durable. A UI/cache-adjacent effect must never
    // turn that commit into a reported failure that the user could retry.
    console.warn(`[大史官] 史册已提交，但后续动作“${label}”失败:`, error);
  }
}

async function fingerprintText(text) {
  const value = String(text ?? "");
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof TextEncoder === "function") {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `sha256:${Array.from(new Uint8Array(digest), byte =>
      byte.toString(16).padStart(2, "0")).join("")}`;
  }
  // Non-cryptographic fallback is only an idempotency hint for old hosts.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function getActiveLedgerRefinementStatus() {
  const targetLorebookName = await getTargetLorebookName();
  if (!targetLorebookName) {
    return {
      available: false,
      targetLorebookName: null,
      loreKey: null,
      parsed: null,
    };
  }

  const bookData = await loadWorldInfo(targetLorebookName);
  const loreKey = Object.keys(bookData?.entries || {}).find(
    key =>
      bookData.entries[key].comment === RUNNING_LOG_COMMENT
      && !bookData.entries[key].disable,
  );
  if (!loreKey) {
    return {
      available: false,
      targetLorebookName,
      loreKey: null,
      parsed: null,
    };
  }

  const entry = bookData.entries[loreKey];
  return {
    available: true,
    targetLorebookName,
    loreKey,
    parsed: parseLedgerForRefinement(entry.content),
  };
}

async function maybeNotifyRefinementThreshold() {
  try {
    const settings = extension_settings[extensionName] || {};
    const limits = normalizeRefinementLimits(settings);
    const status = await getActiveLedgerRefinementStatus();
    const pendingBlocks = status.parsed?.pendingBlockCount || 0;
    if (!status.available || pendingBlocks < limits.reminderBlocks) return;

    const reminderBand = Math.floor(pendingBlocks / limits.reminderBlocks);
    const reminderKey =
      `${status.targetLorebookName}:${status.loreKey}:`
      + `${status.parsed?.compiledFloor || 0}:${reminderBand}`;
    if (refinementReminderKeys.has(reminderKey)) return;
    refinementReminderKeys.add(reminderKey);

    toastr.warning(
      `当前活动史册已有 ${pendingBlocks} 个尚未合并的微言录块。`
      + `建议打开“总结模块 → 大总结（合并精炼）”，点击“合并当前活动史册”。`
      + `这里只提醒，不会在后台自动调用模型。`,
      "宏史卷待重铸",
      { timeOut: 10000 },
    );
  } catch (error) {
    console.warn("[大史官] 检查宏史卷重铸阈值失败，已跳过提醒:", error);
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

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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
                        summaryDialog.find('textarea').prop('disabled', false).val(newSummary || summary);
                        summaryDialog[0].showModal(); // 重新显示弹窗
                        if (!newSummary) {
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
                    <summary>【第 ${msg.floor} 楼】 ${escapeHtml(msg.author)}</summary>
                    <div class="historiography-editor-container">
                        <textarea class="text_pole" data-floor="${msg.floor}">${escapeHtml(msg.content)}</textarea>
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
                            summaryDialog.find('textarea').prop('disabled', false).val(newSummary || summary);
                            summaryDialog[0].showModal(); // 重新显示弹窗
                            if (!newSummary) {
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
    
    const historiographyRuleConfig = resolveHistoriographyRuleConfig(settings);
    const useTagExtraction = historiographyRuleConfig.tagExtractionEnabled ?? false;
    const tagsToExtract = useTagExtraction ? (historiographyRuleConfig.tags || '').split(',').map(t => t.trim()).filter(Boolean) : [];
    const exclusionRules = historiographyRuleConfig.exclusionRules || [];
    const excludeUserMessages = historiographyRuleConfig.excludeUserMessages ?? false;

    const messages = historySlice.map((msg, index) => {
        if (excludeUserMessages && msg.is_user) return null;

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

async function getSummary(formattedHistory, toastTitle, retryCount = 0) {
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

    // 历史总结统一走 NGMS slot；ngms 未配置时 callNgmsAI 自带模块名错误提示。
    // 旧 ngmsEnabled 三元式 fallback 到 main 的设计已在主 API 移除后失效。
    const summary = await callNgmsAI(messages);
    console.log('[大史官-微言录] AI回复的全部内容:', summary);
    
    if (!summary || !summary.trim()) {
        const maxRetries = settings.historiographyMaxRetries ?? 2;
        if (retryCount < maxRetries) {
            console.warn(`[大史官-微言录] AI返回空内容，正在进行第 ${retryCount + 1}/${maxRetries} 次重试...`);
            toastr.warning(`AI返回空内容，正在进行第 ${retryCount + 1}/${maxRetries} 次重试...`, toastTitle);
            await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒后重试
            return await getSummary(formattedHistory, toastTitle, retryCount + 1);
        } else {
            console.error(`[大史官-微言录] 达到最大重试次数 (${maxRetries})，总结失败。`);
            toastr.error(`达到最大重试次数 (${maxRetries})，总结失败。`, toastTitle);
            return null;
        }
    }
    
    return summary;
}

async function writeSummary(summary, startFloor, endFloor, toastTitle) {
    const settings = extension_settings[extensionName];
    const context = getContext();
    const shouldWriteToLorebook = settings.historiographyWriteToLorebook ?? true;
    const shouldIngestToRag = settings.historiographyIngestToRag ?? false;
    const refinementLimits = normalizeRefinementLimits(settings);
    if (!shouldWriteToLorebook && !shouldIngestToRag) {
        toastr.warning("“写入史册”和“存入翰林院”均未启用，总结任务已完成但未保存。", toastTitle);
        return true;
    }

    let targetLorebookName;
    try {
        switch (settings.lorebookTarget) {
            case "character_main":
                targetLorebookName =
                    characters[context.characterId]?.data?.extensions?.world;
                if (!targetLorebookName) {
                    throw new Error("当前角色未绑定主世界书。");
                }
                break;
            case "dedicated": {
                const chatIdentifier = await getChatIdentifier();
                targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
                break;
            }
            default:
                throw new Error("未知的史册写入指令。");
        }
    } catch (error) {
        toastr.error(`无法确定史册目标：${error.message}`, "国史馆");
        return false;
    }

    const ingestMicroSummary = async () => {
        try {
            toastr.info('正在将此份“微言录”送往翰林院...', '翰林院');
            const metadata = {
                bookName: targetLorebookName,
                entryName: `微言录总结: ${startFloor}-${endFloor}楼`
            };
            const result = await ingestTextToHanlinyuan(summary, 'lorebook', metadata);
            if (!result.success) throw new Error(result.error);
            toastr.success(`翰林院已成功接收记忆碎片！`, '翰林院');
            return true;
        } catch (ragError) {
            console.error('[翰林院] 向量化处理失败:', ragError);
            toastr.error(`送往翰林院的文书处理失败: ${ragError.message}`, '翰林院');
            return false;
        }
    };

    if (shouldWriteToLorebook) {
        const firstLedgerAppend = appendMicroSummaryBlock(
            "",
            summary,
            startFloor,
            endFloor,
            refinementLimits.inputMaxTokens,
        );
        if (!firstLedgerAppend.fits) {
            toastr.error(
                `单批微言录写入后约 ${firstLedgerAppend.estimatedTokens} Token，已经超过活动史册硬上限 `
                + `${firstLedgerAppend.maxTokens}。本批次未写入史册，进度未前移；`
                + `请缩小每次总结层数或提高上限。`,
                "微言录过长",
                { timeOut: 12000 },
            );
            return false;
        }
        try {
            let ledgerBudgetExceeded = null;

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

            const targetWasListed = world_names.includes(targetLorebookName);
            const persistence = await mutateBookStrict(
                targetLorebookName,
                (candidateBookData) => {
                    if (!candidateBookData.entries
                        || typeof candidateBookData.entries !== "object"
                        || Array.isArray(candidateBookData.entries)) {
                        throw new Error("目标世界书缺少有效的 entries 结构");
                    }

                    const existingEntry = Object.values(
                        candidateBookData.entries,
                    ).find(entry =>
                        entry?.comment === RUNNING_LOG_COMMENT
                        && !entry.disable);
                    const oldContent = existingEntry?.content || "";
                    const appendResult = appendMicroSummaryBlock(
                        oldContent,
                        summary,
                        startFloor,
                        endFloor,
                        refinementLimits.inputMaxTokens,
                    );
                    if (!appendResult.fits) {
                        // Cancel before persistence. Because candidateBookData
                        // is a clone, neither the host cache nor its progress
                        // seal has been modified.
                        ledgerBudgetExceeded = {
                            estimatedTokens: appendResult.estimatedTokens,
                            maxTokens: appendResult.maxTokens,
                        };
                        return { changed: false, reason: "ledger-budget" };
                    }

                    let targetEntry = existingEntry;
                    if (!targetEntry) {
                        targetEntry = createWorldInfoEntry(
                            targetLorebookName,
                            candidateBookData,
                        );
                        if (!targetEntry) {
                            throw new Error("无法创建活动史册条目");
                        }
                        const positionMap = {
                            before_char: 0,
                            after_char: 1,
                            before_an: 2,
                            after_an: 3,
                            at_depth: 4,
                        };
                        Object.assign(targetEntry, {
                            comment: RUNNING_LOG_COMMENT,
                            key: optionsForNewEntry.keys,
                            constant: optionsForNewEntry.isConstant,
                            position:
                                positionMap[
                                    optionsForNewEntry.insertion_position
                                ] ?? 4,
                            depth:
                                Number.parseInt(
                                    optionsForNewEntry.depth,
                                    10,
                                ) || 998,
                            disable: false,
                        });
                    }
                    targetEntry.content = appendResult.content;
                    return {
                        changed: true,
                        // Some SillyTavern versions answer a read for a
                        // missing book with { entries: {} }; world_names is
                        // the reliable signal for the post-commit list refresh.
                        createdBook: !targetWasListed,
                    };
                },
            );

            if (ledgerBudgetExceeded) {
                toastr.error(
                    `追加后活动史册约 ${ledgerBudgetExceeded.estimatedTokens} Token，`
                    + `将超过硬上限 ${ledgerBudgetExceeded.maxTokens}，因此本批次尚未写入、总结进度也没有前移。`
                    + `请先在“大总结”中合并当前活动史册，再继续补全；原聊天与原史册均保持不变。`,
                    "活动史册已达上限",
                    { timeOut: 14000 },
                );
                return false;
            }

            if (persistence.committed) {
                // UI/list refreshes are deliberately post-commit. A rejected
                // HTTP response must leave both host cache and visible
                // progress on the previous authoritative revision.
                if (persistence.mutation?.createdBook) {
                    await runHistoriographyPostCommitEffect(
                        "刷新世界书列表",
                        () => refreshWorldbookListOnly(targetLorebookName),
                    );
                }
                await runHistoriographyPostCommitEffect(
                    "刷新世界书编辑器",
                    () => reloadEditor(targetLorebookName),
                );
                await runHistoriographyPostCommitEffect(
                    "发布世界书更新通知",
                    () => document.dispatchEvent(new CustomEvent(
                        'amily-lorebook-created',
                        { detail: { bookName: targetLorebookName } },
                    )),
                );
                await runHistoriographyPostCommitEffect(
                    "显示写入成功提示",
                    () => toastr.success(
                        `编年史已成功更新！`,
                        `${toastTitle} - 国史馆`,
                    ),
                );
                await runHistoriographyPostCommitEffect(
                    "自动隐藏已总结消息",
                    () => executeAutoHide(),
                );
                await runHistoriographyPostCommitEffect(
                    "检查宏史卷合并提醒",
                    () => maybeNotifyRefinementThreshold(),
                );
                // When both destinations are enabled, the durable ledger is
                // authoritative. Only ingest after it has accepted the block,
                // so an over-budget retry cannot duplicate vector fragments.
                if (shouldIngestToRag) {
                    await ingestMicroSummary();
                }
                return true;
            } else {
                console.warn("[大史官] 严格史册写入未产生持久化提交。");
                return false;
            }

        } catch (error) {
            console.error(`[大史官] ${toastTitle}写入国史馆失败:`, error);
            toastr.error(`写入国史馆时发生错误: ${error.message}`, "国史馆");
            return false;
        }
    }
    // RAG-only mode has no ledger capacity/persistence dependency.
    return shouldIngestToRag ? ingestMicroSummary() : true;
}

export async function executeRefinement(worldbook, loreKey, options = {}) {
    toastr.info(`遵旨！正在为您重铸《${worldbook}》中的【微言录合集】...`, "宏史卷重铸");

    try {
        const bookData = await loadWorldInfo(worldbook);
        const entry = bookData?.entries[loreKey];
        if (!entry) {
            toastr.error("找不到指定的史册条目，重铸任务中止。", "圣谕有误");
            return;
        }

        const originalContent = String(entry.content || '');
        const originalEntrySnapshot = Object.freeze({
            loreKey: String(loreKey),
            key: JSON.stringify(entry.key ?? []),
            uid: String(entry.uid ?? loreKey),
            comment: String(entry.comment ?? ''),
            disable: Boolean(entry.disable),
            content: originalContent,
        });
        const settings = extension_settings[extensionName];
        const limits = normalizeRefinementLimits(settings);
        const parsedLedger = parseLedgerForRefinement(originalContent);
        if (parsedLedger.reason === 'legacy-vector-placeholder') {
            toastr.error(
                "该史册仍使用“旧宏史卷已由翰林院向量化注入”的占位格式，"
                + "当前条目并不包含早期剧情正文。请先从禁用的旧宏史卷正本恢复，"
                + "或从翰林院导出并恢复早期正文；在正文恢复前不会生成虚假的 1-N 楼滚动宏史卷。",
                "需要先恢复早期正文",
                { timeOut: 16000 },
            );
            return;
        }
        if (!parsedLedger.valid) {
            toastr.error("史册缺少【流水金印】，无法执行重铸。", "结构异常");
            return;
        }
        if (!parsedLedger.pendingMicroContent.trim()
            || parsedLedger.pendingBlockCount <= 0) {
            toastr.warning("史册条目中没有新的内容可供重铸。", "国库无新事");
            return;
        }

        const presetPrompts = await getPresetPrompts('large_summary');

        const order = getMixedOrder('large_summary') || [];
        const requestSeed = generateRandomSeed();

        const buildRefinementMessages = (
            refinementInput,
            selectedBlockCount,
        ) => {
            const selectedEndFloor =
                parsedLedger.pendingBlocks[selectedBlockCount - 1]?.endFloor
                || parsedLedger.compiledFloor
                || 0;
            const messages = [{ role: 'system', content: requestSeed }];
            let promptCounter = 0;
            let coreContentInserted = false;

            for (const item of order) {
                if (item.type === 'prompt') {
                    if (presetPrompts && presetPrompts[promptCounter]) {
                        messages.push(presetPrompts[promptCounter]);
                        promptCounter++;
                    }
                    continue;
                }
                if (item.type !== 'conditional') continue;
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
                        if (!coreContentInserted) {
                            messages.push({
                                role: "user",
                                content:
                                    `<核心处理内容>\n\n${refinementInput}\n\n</核心处理内容>`,
                            });
                            coreContentInserted = true;
                        }
                        break;
                }
            }

            // Imported/legacy prompt orders may omit coreContent or contain it
            // repeatedly. The evidence is mandatory and appears exactly once.
            if (!coreContentInserted) {
                messages.push({
                    role: "user",
                    content:
                        `<核心处理内容>\n\n${refinementInput}\n\n</核心处理内容>`,
                });
            }
            messages.push({
                role: "system",
                content:
                    `必须把“既有宏史卷”和本批“待合并微言录”合并成一份覆盖 1-${selectedEndFloor} 楼的滚动宏史卷。`
                    + `不得只总结新增部分，不得遗漏既有宏史卷中的关键事实。`
                    + `最终输出不得超过约 ${limits.activeMaxTokens} Token；`
                    + `仅输出可直接写入宏史卷的正文，不得输出流水金印、篇章封印或微言录标题。`,
            });
            return messages;
        };

        const buildCandidate = selectedBlockCount => {
            const refinementInput = buildRollingRefinementInput(
                parsedLedger,
                selectedBlockCount,
            );
            const messages = buildRefinementMessages(
                refinementInput,
                selectedBlockCount,
            );
            return {
                selectedBlockCount,
                refinementInput,
                messages,
                estimatedTokens:
                    estimateHistoriographyMessagesTokens(messages),
            };
        };

        const fixedCandidate = buildCandidate(0);
        if (fixedCandidate.estimatedTokens > limits.inputMaxTokens) {
            toastr.error(
                `既有宏史卷与完整固定提示约 ${fixedCandidate.estimatedTokens} Token，`
                + `已经超过输入上限 ${limits.inputMaxTokens}。本次没有调用模型；`
                + `请先手动缩短宏史卷或提高输入上限。`,
                "宏史卷固定输入超限",
                { timeOut: 14000 },
            );
            return;
        }

        // Input size grows monotonically with each oldest pending block, so a
        // binary search selects the largest safe prefix without ever skipping
        // older evidence.
        let low = 1;
        let high = parsedLedger.pendingBlockCount;
        let selectedCandidate = null;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = buildCandidate(middle);
            if (candidate.estimatedTokens <= limits.inputMaxTokens) {
                selectedCandidate = candidate;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (!selectedCandidate) {
            const oneBlockCandidate = buildCandidate(1);
            toastr.error(
                `完整固定提示、既有宏史卷与最旧一块微言录约 `
                + `${oneBlockCandidate.estimatedTokens} Token，超过输入上限 `
                + `${limits.inputMaxTokens}。本次没有调用模型；请提高输入上限或手动缩短既有宏史卷。`,
                "单块仍无法安全重铸",
                { timeOut: 14000 },
            );
            return;
        }

        const selectedBlockCount = selectedCandidate.selectedBlockCount;
        const remainingBlockCount =
            parsedLedger.pendingBlockCount - selectedBlockCount;
        const messages = selectedCandidate.messages;
        if (remainingBlockCount > 0) {
            toastr.info(
                `本轮将在输入上限内合并最旧的 ${selectedBlockCount} 块；`
                + `其余 ${remainingBlockCount} 块会原样保留。完成后可由您手动继续下一轮。`,
                "分段重铸",
                { timeOut: 10000 },
            );
        }

        const getRefinedContent = async (retryCount = 0) => {
            toastr.info("正在召唤模型进行内容精炼...", "宏史卷重铸");
            // 历史总结统一走 NGMS slot；ngms 未配置时 callNgmsAI 自带错误提示。
            const content = await callNgmsAI(messages, {
                maxTokens: limits.activeMaxTokens,
            });
            
            if (!content || !content.trim()) {
                const maxRetries = settings.historiographyMaxRetries ?? 2;
                if (retryCount < maxRetries) {
                    console.warn(`[大史官-宏史卷重铸] AI返回空内容，正在进行第 ${retryCount + 1}/${maxRetries} 次重试...`);
                    toastr.warning(`AI返回空内容，正在进行第 ${retryCount + 1}/${maxRetries} 次重试...`, "宏史卷重铸");
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return await getRefinedContent(retryCount + 1);
                } else {
                    console.error(`[大史官-宏史卷重铸] 达到最大重试次数 (${maxRetries})，重铸失败。`);
                    toastr.error(`达到最大重试次数 (${maxRetries})，重铸失败。`, "宏史卷重铸失败");
                    return null;
                }
            }
            return content;
        };

        const initialRefinedContent = await getRefinedContent();
        if (!initialRefinedContent) {
            return; // 错误提示已在 getRefinedContent 中处理
        }

        const processLoop = async (currentRefinedContent) => {
            showSummaryModal(currentRefinedContent, {
                onConfirm: async (editedText) => {
                    if (containsReservedLedgerStructure(editedText)) {
                        toastr.error(
                            "输出中包含史册保留结构标记（流水金印、篇章封印或微言录标题）。"
                            + "为避免破坏后续解析，本次没有写入；请在重新打开的预览中删除这些标记。",
                            "宏史卷结构冲突",
                            { timeOut: 12000 },
                        );
                        setTimeout(() => processLoop(editedText), 0);
                        return;
                    }
                    const budgetResult = rollingLedgerFitsBudget(
                        editedText,
                        parsedLedger,
                        limits.activeMaxTokens,
                        selectedBlockCount,
                    );
                    if (!budgetResult.fits) {
                        toastr.error(
                            `当前滚动宏史卷约 ${budgetResult.estimatedTokens} Token，`
                            + `超过宏史卷上限 ${budgetResult.maxTokens}。`
                            + `为避免不可控上下文膨胀，本次没有写入；请在重新打开的预览中继续缩减。`,
                            "宏史卷仍过长",
                            { timeOut: 12000 },
                        );
                        // showSummaryModal closes the current dialog after
                        // onConfirm returns. Reopen on the next task so two
                        // modal dialogs never contend for the top layer.
                        setTimeout(() => processLoop(editedText), 0);
                        return;
                    }

                    const finalContent = budgetResult.content;
                    if (!finalContent) {
                        toastr.error("无法构建滚动宏史卷，原始史册保持不变。", "重铸失败");
                        return;
                    }

                    try {
                        await withLoreLock(
                            `rollingRefinement(${worldbook}:${loreKey})`,
                            async () => {
                                if (options.requireCurrentTarget) {
                                    const currentTarget =
                                        await getTargetLorebookName();
                                    if (currentTarget !== worldbook) {
                                        const staleError = new Error(
                                            "当前聊天的目标世界书已经变化",
                                        );
                                        staleError.code =
                                            "HISTORIOGRAPHY_STALE_LEDGER";
                                        throw staleError;
                                    }
                                }
                                // The user may leave the preview open while
                                // another summary is appended. Re-read under
                                // the same write lock used for the final save,
                                // otherwise another queued writer could slip
                                // between the comparison and replacement.
                                const latestBookData = await loadWorldInfo(worldbook);
                                const latestEntry = latestBookData?.entries?.[loreKey];
                                const latestActiveLoreKey = Object.keys(
                                    latestBookData?.entries || {},
                                ).find(key =>
                                    latestBookData.entries[key].comment
                                        === RUNNING_LOG_COMMENT
                                    && !latestBookData.entries[key].disable);
                                if (!latestEntry
                                    || String(loreKey)
                                        !== originalEntrySnapshot.loreKey
                                    || (options.requireCurrentTarget
                                        && String(latestActiveLoreKey ?? '')
                                            !== originalEntrySnapshot.loreKey)
                                    || JSON.stringify(latestEntry.key ?? [])
                                        !== originalEntrySnapshot.key
                                    || String(latestEntry.uid ?? loreKey)
                                        !== originalEntrySnapshot.uid
                                    || String(latestEntry.comment ?? '')
                                        !== originalEntrySnapshot.comment
                                    || Boolean(latestEntry.disable)
                                        !== originalEntrySnapshot.disable
                                    || String(latestEntry.content || '')
                                        !== originalEntrySnapshot.content) {
                                    const staleError = new Error(
                                        "预览期间活动史册已发生变化",
                                    );
                                    staleError.code = "HISTORIOGRAPHY_STALE_LEDGER";
                                    throw staleError;
                                }

                                const candidateBookData =
                                    structuredClone(latestBookData);
                                const candidateEntry =
                                    candidateBookData?.entries?.[loreKey];
                                if (!candidateEntry) {
                                    throw new Error("无法建立独立的史册候选草稿");
                                }
                                // Fail closed: the byte-for-byte source ledger
                                // and the rolling replacement are persisted in
                                // one book save.
                                const archiveEntry =
                                    createWorldInfoEntry(
                                        worldbook,
                                        candidateBookData,
                                    );
                                if (!archiveEntry) {
                                    throw new Error("无法创建重铸前正本存档条目");
                                }
                                const oldFloorLabel = parsedLedger.compiledFloor > 0
                                    ? `原宏史卷至${parsedLedger.compiledFloor}楼`
                                    : "首次重铸";
                                const archiveTimestamp = new Date()
                                    .toISOString()
                                    .replace(/[:.]/g, "-")
                                    .slice(0, 19);
                                archiveEntry.comment =
                                    `${RUNNING_LOG_COMMENT}_归档_${archiveTimestamp}_重铸前正本_`
                                    + `1-${parsedLedger.totalFloors}楼（${oldFloorLabel}）`;
                                archiveEntry.content = originalContent;
                                archiveEntry.disable = true;
                                archiveEntry.constant = false;
                                archiveEntry.key = [];

                                candidateEntry.content = finalContent;
                                await saveBookStrictUnlocked(
                                    worldbook,
                                    candidateBookData,
                                );
                            },
                        );
                        reloadEditor(worldbook);
                        toastr.success(
                            `史册已重铸为一份滚动宏史卷；重铸前完整正本已禁用归档于《${worldbook}》。`
                            + (remainingBlockCount > 0
                                ? ` 尚余 ${remainingBlockCount} 块微言录，请按需手动继续合并。`
                                : " 本轮已合并全部待处理微言录。"),
                            "宏史卷重铸完毕",
                            { timeOut: 10000 },
                        );

                        const shouldVectorize =
                            document.getElementById('amily2_vectorize_summary_content')?.checked
                            ?? false;
                        if (shouldVectorize && parsedLedger.existingRollingContent) {
                            try {
                                const fingerprint = await fingerprintText(
                                    parsedLedger.existingRollingContent,
                                );
                                if (vectorizedRollingContentFingerprints.has(
                                    fingerprint,
                                )) {
                                    toastr.info(
                                        "同一旧宏史卷本次会话已向量化，已跳过重复入库。",
                                        "翰林院",
                                    );
                                    return;
                                }
                                toastr.info(
                                    `正在将前 ${parsedLedger.compiledFloor} 楼的旧宏史卷副本送往翰林院...`,
                                    "翰林院",
                                );
                                const ingestResult = await ingestTextToHanlinyuan(
                                    parsedLedger.existingRollingContent,
                                    "lorebook",
                                    {
                                        bookName: worldbook,
                                        entryName:
                                            `宏史卷总结: 1-${parsedLedger.compiledFloor}楼 [${fingerprint}]`,
                                    },
                                );
                                if (!ingestResult.success || !(ingestResult.count > 0)) {
                                    throw new Error(
                                        ingestResult.error
                                        || `向量化未产生条目（count=${ingestResult.count ?? 0}）`,
                                    );
                                }
                                vectorizedRollingContentFingerprints.add(
                                    fingerprint,
                                );
                                toastr.success(
                                    `旧宏史卷副本已进入翰林院，共 ${ingestResult.count} 条。`,
                                    "翰林院",
                                );
                            } catch (error) {
                                // Active rolling summary and disabled source
                                // archive are already durable. Vector storage
                                // is optional cache, so failure never rolls
                                // back or deletes either source.
                                console.error("[大史官-宏史卷向量化] 失败:", error);
                                toastr.warning(
                                    `滚动宏史卷已安全保存，但可选向量化失败：${error.message}`,
                                    "翰林院",
                                    { timeOut: 10000 },
                                );
                            }
                        }
                    } catch (error) {
                        if (error?.code === "HISTORIOGRAPHY_STALE_LEDGER") {
                            toastr.warning(
                                "预览期间活动史册已发生变化，本次旧结果已安全丢弃。请重新开始合并。",
                                "史册已更新",
                                { timeOut: 10000 },
                            );
                            return;
                        }
                        console.error("[大史官-宏史卷存档] 写入失败:", error);
                        toastr.error(
                            `无法同时保存滚动宏史卷与重铸前正本：${error.message}。原活动史册保持不变。`,
                            "宏史卷保存失败",
                            { timeOut: 12000 },
                        );
                    }
                },
                onRegenerate: async (dialog) => {
                    dialog.find('textarea').prop('disabled', true).val('正在重新生成，请稍候...');
                    const newContent = await getRefinedContent();
                    dialog.find('textarea').prop('disabled', false).val(newContent || currentRefinedContent);
                    dialog[0].showModal(); // 重新显示弹窗
                    if (!newContent) {
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

export async function executeActiveLedgerRefinement() {
    try {
        const status = await getActiveLedgerRefinementStatus();
        if (!status.available || !status.targetLorebookName || !status.loreKey) {
            toastr.warning(
                "当前聊天没有可重铸的活动【对话流水总帐】。",
                "宏史卷重铸",
            );
            return false;
        }
        if (status.parsed?.reason === 'legacy-vector-placeholder') {
            toastr.error(
                "该活动史册仍使用“旧宏史卷已由翰林院向量化注入”的占位格式，"
                + "条目内没有可供重铸的早期剧情正文。请先恢复旧宏史卷正文再重铸。",
                "需要先恢复早期正文",
                { timeOut: 16000 },
            );
            return false;
        }
        if (!status.parsed?.valid) {
            toastr.error("活动史册缺少流水金印，无法安全重铸。", "结构异常");
            return false;
        }
        if (!status.parsed.pendingMicroContent.trim()) {
            toastr.info("活动史册没有新的微言录块需要合并。", "宏史卷重铸");
            return false;
        }
        await executeRefinement(
            status.targetLorebookName,
            status.loreKey,
            { requireCurrentTarget: true },
        );
        return true;
    } catch (error) {
        console.error("[大史官] 无法打开当前活动史册重铸:", error);
        toastr.error(`无法读取当前活动史册：${error.message}`, "宏史卷重铸");
        return false;
    }
}

export async function executeExpedition() {
    if (isExpeditionRunning) {
        toastr.info("补全总结正在进行中，请稍候。", "总结");
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
                    toastr.error("当前角色未绑定主世界书，无法写入总结。", "总结");
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
                toastr.error("写入目标无效，请检查世界书设置。", "总结");
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
            toastr.info("没有需要补全的历史，已经是最新。", "总结");
            isExpeditionRunning = false;
            document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: false, manualStop: false } }));
            return;
        }

        const batchSize = settings.historiographySmallTriggerThreshold;
        const totalBatches = Math.ceil(remainingHistory / batchSize);
        toastr.info(`开始补全：还有 ${remainingHistory} 层，分 ${totalBatches} 批处理。`, "开始总结");
        let currentProgress = summarizedCount;

        for (let i = 0; i < totalBatches; i++) {
            if (manualStopRequested) {
                toastr.warning("已暂停。点「继续补全」可接着做。", "总结");
                break;
            }

            const startFloor = currentProgress + 1;
            const endFloor = Math.min(currentProgress + batchSize, summarizableLength);
            const toastTitle = `补全进度 (${i + 1}/${totalBatches})`;

            const delay = 2000;
            if (i > 0) {
                toastr.info(`准备第 ${i + 1} 批…（${delay / 1000} 秒后开始）`, toastTitle);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            if (manualStopRequested) {
                toastr.warning("已在准备阶段暂停。", "总结");
                break;
            }

            const success = await executeManualSummary(startFloor, endFloor, false);
            if (success) {
                currentProgress = endFloor;
            } else {
                toastr.warning(`第 ${i + 1} 批失败，补全已中止。`, "总结");
                manualStopRequested = true;
                break;
            }
        }

        if(!manualStopRequested) {
             toastr.success("补全完成，未总结的历史已全部处理。", "开始总结");
        }

    } catch (error) {
        console.error("[大史官-补全失败]", error);
        toastr.error("补全过程出错已中止，可点「继续补全」重试。", "总结");
    } finally {
        isExpeditionRunning = false;
        document.dispatchEvent(new CustomEvent('amily2-expedition-state-change', { detail: { isRunning: false, manualStop: manualStopRequested } }));
    }
}

export function stopExpedition() {
    if (isExpeditionRunning) {
        manualStopRequested = true;
        toastr.info("已请求停止，当前这一批结束后会停下。", "总结");
    } else {
        toastr.warning("当前没有正在进行的补全。", "总结");
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

// ========== 史册归档与回溯系统 ==========

// 渐进记忆远带复用同一套金账定位（settings.lorebookTarget 语义唯一信源），故导出
export async function getTargetLorebookName() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    let targetLorebookName = null;
    switch (settings.lorebookTarget) {
        case "character_main":
            targetLorebookName = characters[context.characterId]?.data?.extensions?.world;
            break;
        case "dedicated":
            const chatIdentifier = await getChatIdentifier();
            targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
            break;
    }
    return targetLorebookName;
}

export async function archiveCurrentLedger() {
    try {
        const targetLorebookName = await getTargetLorebookName();
        if (!targetLorebookName) {
            toastr.error("无法确定目标世界书，归档失败。", "圣谕不明");
            return false;
        }

        const bookData = await loadWorldInfo(targetLorebookName);
        if (!bookData || !bookData.entries) {
            toastr.error(`无法读取世界书《${targetLorebookName}》。`, "国史馆");
            return false;
        }

        const ledgerEntryKey = Object.keys(bookData.entries).find(
            (key) => bookData.entries[key].comment === RUNNING_LOG_COMMENT && !bookData.entries[key].disable
        );

        if (!ledgerEntryKey) {
            toastr.info("当前没有活跃的【对话流水总帐】，无需归档。", "国史馆");
            return false;
        }

        const entry = bookData.entries[ledgerEntryKey];
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const newComment = `${RUNNING_LOG_COMMENT}_归档_${timestamp}`;

        entry.comment = newComment;
        entry.disable = true;

        await loreSaveBook(targetLorebookName, bookData);
        reloadEditor(targetLorebookName);
        toastr.success(`已将当前流水总帐归档为：\n${newComment}`, "归档成功");
        return true;

    } catch (error) {
        console.error("[大史官] 归档失败:", error);
        toastr.error(`归档失败: ${error.message}`, "国史馆");
        return false;
    }
}

export async function getArchivedLedgers() {
    try {
        const targetLorebookName = await getTargetLorebookName();
        if (!targetLorebookName) return [];

        const bookData = await loadWorldInfo(targetLorebookName);
        if (!bookData || !bookData.entries) return [];

        const archivedLedgers = Object.entries(bookData.entries)
            .filter(([, entry]) => entry.comment && entry.comment.startsWith(`${RUNNING_LOG_COMMENT}_归档_`))
            .map(([key, entry]) => ({
                key: key,
                comment: entry.comment
            }))
            .sort((a, b) => b.comment.localeCompare(a.comment)); // 按时间倒序排列

        return archivedLedgers;

    } catch (error) {
        console.error("[大史官] 获取归档列表失败:", error);
        return [];
    }
}

export async function restoreArchivedLedger(targetLoreKey) {
    try {
        const targetLorebookName = await getTargetLorebookName();
        if (!targetLorebookName) {
            toastr.error("无法确定目标世界书，回溯失败。", "圣谕不明");
            return false;
        }

        const bookData = await loadWorldInfo(targetLorebookName);
        if (!bookData || !bookData.entries) {
            toastr.error(`无法读取世界书《${targetLorebookName}》。`, "国史馆");
            return false;
        }

        const targetEntry = bookData.entries[targetLoreKey];
        if (!targetEntry) {
            toastr.error("找不到指定的归档史册。", "圣谕有误");
            return false;
        }

        const currentActiveKey = Object.keys(bookData.entries).find(
            (key) => bookData.entries[key].comment === RUNNING_LOG_COMMENT && !bookData.entries[key].disable
        );

        if (currentActiveKey) {
            if (currentActiveKey !== targetLoreKey) {
                const activeEntry = bookData.entries[currentActiveKey];
                const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                activeEntry.comment = `${RUNNING_LOG_COMMENT}_归档_${timestamp}`;
                activeEntry.disable = true;
                toastr.info(`已自动归档原有的活跃史册为: ${activeEntry.comment}`, "自动归档");
            }
        }
        targetEntry.comment = RUNNING_LOG_COMMENT;
        targetEntry.disable = false;

        await loreSaveBook(targetLorebookName, bookData);
        reloadEditor(targetLorebookName);
        toastr.success("史册回溯成功！时光已倒流，旧史重现。", "回溯成功");
        return true;

    } catch (error) {
        console.error("[大史官] 回溯失败:", error);
        toastr.error(`回溯失败: ${error.message}`, "国史馆");
        return false;
    }
}
