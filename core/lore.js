import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, eventSource, event_types } from "/script.js";
import { loadWorldInfo, createNewWorldInfo, createWorldInfoEntry, saveWorldInfo, world_names, updateWorldInfoList } from "/scripts/world-info.js";
import { compatibleWriteToLorebook, safeLorebooks, safeCharLorebooks, safeLorebookEntries } from "./tavernhelper-compatibility.js";
import { extensionName } from "../utils/settings.js";


document.addEventListener('amily-lorebook-created', (event) => {
    if (event.detail && event.detail.bookName) {
        console.log(`[Amily2-国史馆] 监听到史书《${event.detail.bookName}》变更，即刻通报工部刷新宫殿。`);
        refreshWorldbookListOnly(event.detail.bookName);
    }
});


export const LOREBOOK_PREFIX = "Amily2档案-";
export const DEDICATED_LOREBOOK_NAME = "Amily2号-国史馆";
export const INTRODUCTORY_TEXT =
  "【Amily2号自动档案】\n此卷宗由Amily2号优化助手自动生成并维护，记录核心事件脉络。\n---\n";

export async function getChatIdentifier() {
  let attempts = 0;
  const maxAttempts = 50;
  const interval = 100;

  while (attempts < maxAttempts) {
    try {
      const context = getContext();
      if (context && context.characterId) {
        const character = characters[context.characterId];
        if (character && character.avatar) {
          return `char-${character.avatar.replace(/\.(png|webp|jpg|jpeg|gif)$/, "")}`;
        }
        return `char-${context.characterId}`;
      }
      if (context && context.chat_filename) {
        const fileName = context.chat_filename.split(/[\\/]/).pop();
        return fileName.replace(/\.jsonl?$/, "");
      }
    } catch (error) {
      console.warn(
        `[Amily2-户籍管理处] 等待上下文时发生轻微错误 (尝试次数 ${attempts + 1}):`,
        error.message,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    attempts++;
  }

  console.error("[Amily2-国史馆] 户籍管理处在长时间等待后，仍无法确定户籍。");
  toastr.warning(
    "Amily2号无法确定当前聊天身份，世界书功能将受影响。",
    "上下文错误",
  );
  return "unknown_chat_timeout";
}

export async function findLatestSummaryLore(lorebookName, chatIdentifier) {
  try {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
      return null;
    }
    const entriesArray = Object.values(bookData.entries);
    const uniqueLoreName = `${LOREBOOK_PREFIX}${chatIdentifier}`;
    return (
      entriesArray.find(
        (entry) => entry.comment === uniqueLoreName && !entry.disable,
      ) || null
    );
  } catch (error) {
    console.error(
      `[Amily2-国史馆] 钦差大臣在 '${lorebookName}' 检索时发生错误:`,
      error,
    );
    return null;
  }
}

export async function getCombinedWorldbookContent(lorebookName) {
  if (!lorebookName) return "";
  try {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
      return "";
    }
    const activeContents = Object.values(bookData.entries)
      .filter((entry) => !entry.disable)
      .map((entry) => `[条目: ${entry.comment || "无标题"}]\n${entry.content}`);
    return activeContents.join("\n\n---\n\n");
  } catch (error) {
    console.error(
      `[Amily2-国史馆] 钦差大臣在整合 '${lorebookName}' 时发生错误:`,
      error,
    );
    toastr.error(`读取世界书 '${lorebookName}' 失败!`, "档案整合错误");
    return "";
  }
}

export async function refreshWorldbookListOnly(newBookName = null) {
    console.log("[Amily2号-工部-v2.0] 执行SillyTavern核心UI刷新...");
    try {
        await updateWorldInfoList();
        console.log("[Amily2号-工部] SillyTavern核心刷新函数 (updateWorldInfoList) 调用成功。");
    } catch (error) {
        console.error("[Amily2号-工部] 调用核心刷新函数时出错:", error);
        toastr.error("Amily2号调用核心UI刷新函数时失败。", "核心刷新失败");
    }
}

export async function writeSummaryToLorebook(pendingData) {
    if (!pendingData || !pendingData.summary || !pendingData.sourceAiMessageTimestamp || !pendingData.settings) {
        console.warn("[Amily助手-国史馆] 接到一份残缺的待办文书，写入任务已中止。", pendingData);
        return;
    }

    const context = getContext();
    const chat = context.chat;
    let isSourceMessageValid = false;
    let sourceMessageCandidate = null;
    // 寻找最新的 AI 消息以进行时间戳验证
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) {
            sourceMessageCandidate = chat[i];
            break;
        }
    }

    if (sourceMessageCandidate && sourceMessageCandidate.send_date === pendingData.sourceAiMessageTimestamp) {
        isSourceMessageValid = true;
    }

    if (!isSourceMessageValid) {
        console.log("[Amily助手-逆时寻踪] 裁决: 源消息已被修改或删除，遵旨废黜过时总结。");
        return;
    }

    const { summary: summaryToCommit, settings } = pendingData;

    console.groupCollapsed(`[Amily助手-存档任务] ${new Date().toLocaleTimeString()}`);
    console.time("总结写入总耗时");

    try {
        const chatIdentifier = await getChatIdentifier();
        const character = characters[context.characterId];
        let targetLorebookName = null;

        switch (settings.target) {
            case "character_main":
                targetLorebookName = character?.data?.extensions?.world;
                if (!targetLorebookName) {
                    toastr.warning("角色未绑定主世界书，总结写入任务已中止。", "Amily助手");
                    console.groupEnd();
                    return;
                }
                break;
            case "dedicated":
                targetLorebookName = `${DEDICATED_LOREBOOK_NAME}-${chatIdentifier}`;
                break;
            default:
                toastr.error(`收到未知的写入指令: "${settings.target}"`, "Amily助手");
                console.groupEnd();
                return;
        }

        const uniqueLoreName = `${LOREBOOK_PREFIX}${chatIdentifier}`;

        // 定义内容更新的回调函数
        const contentUpdateCallback = (existingContent) => {
            if (existingContent) {
                // 如果条目已存在，追加内容
                const cleanedContent = existingContent.replace(INTRODUCTORY_TEXT, "").trim();
                const lines = cleanedContent ? cleanedContent.split("\n") : [];
                const nextNumber = lines.length + 1;
                return `${existingContent}\n${nextNumber}. ${summaryToCommit}`;
            } else {
                // 如果条目不存在，创建新内容
                return `${INTRODUCTORY_TEXT}1. ${summaryToCommit}`;
            }
        };

        // 定义写入选项
        const options = {
            keys: settings.keywords.split(',').map(k => k.trim()).filter(Boolean),
            isConstant: settings.activationMode === 'always',
            insertion_position: settings.insertionPosition,
            depth: settings.depth,
        };

        // 使用统一的兼容性写入函数
        const success = await compatibleWriteToLorebook(targetLorebookName, uniqueLoreName, contentUpdateCallback, options);

        if (success) {
            toastr.success(`总结已成功写入《${targetLorebookName}》！`, "Amily助手");
        } else {
            toastr.error(`总结写入《${targetLorebookName}》时失败。`, "Amily助手");
        }

    } catch (error) {
        console.error("[Amily助手-写入失败] 写入流程发生意外错误:", error);
        toastr.error("后台写入总结时发生错误。", "Amily助手");
    } finally {
        console.timeEnd("总结写入总耗时");
        console.groupEnd();
    }
}

export async function getOptimizationWorldbookContent() {
    const settings = extension_settings[extensionName];
    if (!settings || !settings.modal_wbEnabled) {
        return '';
    }

    try {
        let bookNames = [];
        if (settings.modal_wbSource === 'manual') {
            bookNames = settings.modal_amily2_wb_selected_worldbooks || [];
        } else { // 'character' source
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        }

        if (bookNames.length === 0) {
            console.log('[Amily2-正文优化] No world books selected or linked for optimization.');
            return '';
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await safeLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        const selectedEntriesConfig = settings.modal_amily2_wb_selected_entries || {};

        const userEnabledEntries = allEntries.filter(entry => {
            // Entry must be enabled in the lorebook itself
            if (!entry.enabled) return false;
            
            // Check against our UI selection
            const bookConfig = selectedEntriesConfig[entry.bookName];
            return bookConfig ? bookConfig.includes(String(entry.uid)) : false;
        });

        if (userEnabledEntries.length === 0) {
            console.log('[Amily2-正文优化] No entries are selected for optimization in the chosen world books.');
            return '';
        }

        const finalContent = userEnabledEntries.map(entry => entry.content).filter(Boolean);
        const combinedContent = finalContent.join('\n\n---\n\n');
        
        console.log(`[Amily2-正文优化] Loaded ${userEnabledEntries.length} world book entries, total length: ${combinedContent.length}`);
        return combinedContent;

    } catch (error) {
        console.error(`[Amily2-正文优化] Processing world book content failed:`, error);
        return '';
    }
}


export async function getPlotOptimizedWorldbookContent(context, apiSettings) {
    const panel = $('#amily2_plot_optimization_panel');
    let liveSettings = {};

    // Check if the panel exists and its dynamic content (the entry list) has been populated.
    // This helps prevent a race condition where we read from an empty, partially-rendered panel.
    const isPanelReady = panel.length > 0 && panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').length > 0;

    if (isPanelReady) {
        // Panel is ready, so we can trust the live values from the UI.
        liveSettings.worldbookEnabled = panel.find('#amily2_opt_worldbook_enabled').is(':checked');
        liveSettings.worldbookSource = panel.find('input[name="amily2_opt_worldbook_source"]:checked').val() || 'character';
        
        liveSettings.selectedWorldbooks = [];
        if (liveSettings.worldbookSource === 'manual') {
            panel.find('#amily2_opt_worldbook_checkbox_list input[type="checkbox"]:not(.amily2_opt_wb_auto_check):checked').each(function() {
                liveSettings.selectedWorldbooks.push($(this).val());
            });
        }

        liveSettings.autoSelectWorldbooks = [];
        panel.find('#amily2_opt_worldbook_checkbox_list input.amily2_opt_wb_auto_check:checked').each(function() {
            liveSettings.autoSelectWorldbooks.push($(this).data('book'));
        });

        liveSettings.worldbookCharLimit = parseInt(panel.find('#amily2_opt_worldbook_char_limit').val(), 10) || 60000;

        let enabledEntries = {};
        panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]:checked').each(function() {
            const bookName = $(this).data('book');
            const uid = parseInt($(this).data('uid'));
            if (!enabledEntries[bookName]) {
                enabledEntries[bookName] = [];
            }
            enabledEntries[bookName].push(uid);
        });
        liveSettings.enabledWorldbookEntries = enabledEntries;
    } else {
        // Panel is not ready or doesn't exist. Fall back to the saved settings from the extension.
        // This uses the correct, prefixed keys.
        if (panel.length > 0) {
            console.warn('[剧情优化大师] 检测到UI面板但内容未完全加载，回退到使用已保存的设置。');
        } else {
            console.warn('[剧情优化大师] 未找到设置面板，世界书功能将使用已保存的设置。');
        }
        
        liveSettings = {
            worldbookEnabled: apiSettings.plotOpt_worldbook_enabled,
            worldbookSource: apiSettings.plotOpt_worldbook_source || 'character', // Default to 'character'
            selectedWorldbooks: apiSettings.plotOpt_worldbook_selected_worldbooks,
            autoSelectWorldbooks: apiSettings.plotOpt_autoSelectWorldbooks || [],
            worldbookCharLimit: apiSettings.plotOpt_worldbook_char_limit,
            enabledWorldbookEntries: apiSettings.plotOpt_worldbook_selected_entries,
        };
    }

    if (!liveSettings.worldbookEnabled) {
        return '';
    }

    if (!context) {
        console.warn('[剧情优化大师] context 未提供，无法获取世界书内容。');
        return '';
    }

    try {
        let bookNames = [];
        
        if (liveSettings.worldbookSource === 'manual') {
            bookNames = liveSettings.selectedWorldbooks;
            if (bookNames.length === 0) return '';
        } else {
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            if (bookNames.length === 0) return '';
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await safeLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        if (allEntries.length === 0) return '';
        
        const enabledEntriesMap = liveSettings.enabledWorldbookEntries || {};
        const autoSelectedBooks = liveSettings.autoSelectWorldbooks || [];

        const userEnabledEntries = allEntries.filter(entry => {
            if (!entry.enabled) return false;

            // 检查是否在UI中被勾选（或被自动全选）
            const isAuto = autoSelectedBooks.includes(entry.bookName);
            const bookConfig = enabledEntriesMap[entry.bookName];
            const isChecked = isAuto || (bookConfig ? (bookConfig.includes(entry.uid) || bookConfig.includes(String(entry.uid))) : false);

            if (isChecked) {
                // 勾选状态下必读 (强制设为 Constant)
                entry.constant = true;
            }
            // 不勾选则依靠蓝绿灯 (保持原样，不返回 false)
            
            return true;
        });

        if (userEnabledEntries.length === 0) return '';
        
        const chatHistory = context.chat.map(message => message.mes).join('\n').toLowerCase();
        const getEntryKeywords = (entry) => [...new Set([...(entry.key || []), ...(entry.keys || [])])].map(k => k.toLowerCase());

        const blueLightEntries = userEnabledEntries.filter(entry => entry.constant);
        let pendingGreenLights = userEnabledEntries.filter(entry => !entry.constant);
        
        const triggeredEntries = new Set([...blueLightEntries]);

        while (true) {
            let hasChangedInThisPass = false;
            
            const recursionSourceContent = Array.from(triggeredEntries)
                .filter(e => !e.prevent_recursion)
                .map(e => e.content)
                .join('\n')
                .toLowerCase();
            const fullSearchText = `${chatHistory}\n${recursionSourceContent}`;

            const nextPendingGreenLights = [];
            
            for (const entry of pendingGreenLights) {
                const keywords = getEntryKeywords(entry);
                let isTriggered = keywords.length > 0 && keywords.some(keyword => 
                    entry.exclude_recursion ? chatHistory.includes(keyword) : fullSearchText.includes(keyword)
                );

                if (isTriggered) {
                    triggeredEntries.add(entry);
                    hasChangedInThisPass = true;
                } else {
                    nextPendingGreenLights.push(entry);
                }
            }
            
            if (!hasChangedInThisPass) break;
            
            pendingGreenLights = nextPendingGreenLights;
        }

        const finalContent = Array.from(triggeredEntries).map(entry => {
            const keys = [...new Set([...(entry.key || []), ...(entry.keys || [])])].filter(Boolean).join('、');
            const displayName = entry.comment || `Entry ${entry.uid}`;
            return `【世界书条目：${displayName}。绿灯触发关键词：${keys}】\n内容：${entry.content}`;
        }).filter(Boolean);
        if (finalContent.length === 0) return '';

        const combinedContent = finalContent.join('\n\n---\n\n');
        
        const limit = liveSettings.worldbookCharLimit;
        if (combinedContent.length > limit) {
            console.log(`[剧情优化大师] 世界书内容 (${combinedContent.length} chars) 超出限制 (${limit} chars)，将被截断。`);
            return combinedContent.substring(0, limit);
        }

        return combinedContent;

    } catch (error) {
        console.error(`[剧情优化大师] 处理世界书逻辑时出错:`, error);
        return '';
    }
}


export async function manageLorebookEntriesForChat() {
    try {
        const chatIdentifier = await getChatIdentifier();
        if (!chatIdentifier || chatIdentifier.startsWith("unknown_chat")) {
            console.error(`[Amily2-国史馆] 无法获取有效的聊天标识符，中止条目状态管理。`);
            return;
        }

        const context = getContext();
        if (!context || !context.characterId) {
            console.log("[Amily2-国史馆] 未选择任何角色，跳过世界书管理。");
            return;
        }

        const charLorebooks = await safeCharLorebooks({ type: 'all' });
        const bookNames = [];
        if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
        if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);

        const dedicatedBookName = `${DEDICATED_LOREBOOK_NAME}-${chatIdentifier}`;
        if (!bookNames.includes(dedicatedBookName)) {
            bookNames.push(dedicatedBookName);
        }

        for (const bookName of bookNames) {
            if (!world_names.includes(bookName)) continue; 

            const entries = await safeLorebookEntries(bookName);
            const entriesToUpdate = [];

            for (const entry of entries) {
                if (entry.comment && entry.comment.startsWith(LOREBOOK_PREFIX)) {
                    const isForCurrentChat = entry.comment.includes(chatIdentifier);
                    if (isForCurrentChat && entry.disable) {
                        entriesToUpdate.push({ uid: entry.uid, enabled: true });
                    } else if (!isForCurrentChat && !entry.disable) {
                        entriesToUpdate.push({ uid: entry.uid, enabled: false });
                    }
                }
            }

            if (entriesToUpdate.length > 0) {
                const success = await safeUpdateLorebookEntries(bookName, entriesToUpdate);
                if (success) {
                    console.log(`[Amily2-国史馆] 已为《${bookName}》更新了 ${entriesToUpdate.length} 个条目的状态以匹配当前聊天: ${chatIdentifier}`);
                }
            }
        }

    } catch (error) {
        console.error("[Amily2-国史馆] 管理世界书条目状态时发生错误:", error);
    }
}
