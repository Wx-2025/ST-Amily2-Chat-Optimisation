import { getContext } from "/scripts/extensions.js";
import { characters, eventSource, event_types } from "/script.js";
import { loadWorldInfo, createNewWorldInfo, createWorldInfoEntry, saveWorldInfo, world_names } from "/scripts/world-info.js";


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

async function refreshWorldbookListOnly(newBookName = null) {
  console.log("[Amily2号-工部-v1.3] 执行“圣谕广播”式UI更新...");
  try {
    if (newBookName) {
      if (Array.isArray(world_names) && !world_names.includes(newBookName)) {
        world_names.push(newBookName);
        world_names.sort();
        console.log(`[Amily2号-工部] 已将《${newBookName}》注入前端数据模型。`);
      } else {
         console.log(`[Amily2号-工部] 《${newBookName}》已存在于数据模型中，跳过注入。`);
      }
    }

    if (
      eventSource &&
      typeof eventSource.emit === "function" &&
      event_types.CHARACTER_PAGE_LOADED
    ) {
      console.log(`[Amily2号-工部] 正在广播事件: ${event_types.CHARACTER_PAGE_LOADED}`);
      eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
      console.log("[Amily2号-工部] “character_page_loaded”事件已广播，UI应已响应刷新。");
    } else {
      console.error("[Amily2号] 致命错误: eventSource 或 event_types.CHARACTER_PAGE_LOADED 未找到。无法广播刷新事件。");
      toastr.error("Amily2号无法触发UI刷新。", "核心事件系统缺失");
    }
  } catch (error) {
    console.error("[Amily2号-工部] “圣谕广播”式刷新失败:", error);
  }
}

export async function writeSummaryToLorebook(pendingData) {
    if (!pendingData || !pendingData.summary || !pendingData.sourceAiMessageTimestamp || !pendingData.settings) {
        console.warn("[Amily2-国史馆] 接到一份残缺的待办文书，写入任务已中止。", pendingData);
        return;
    }

    const context = getContext();
    const chat = context.chat;
    let isSourceMessageValid = false;
    let sourceMessageCandidate = null;
    for (let i = chat.length - 2; i >= 0; i--) {
        if (!chat[i].is_user) { sourceMessageCandidate = chat[i]; break; }
    }
    if (sourceMessageCandidate && sourceMessageCandidate.send_date === pendingData.sourceAiMessageTimestamp) {
        isSourceMessageValid = true;
    }
    if (!isSourceMessageValid) {
        console.log("[Amily2号-逆时寻踪] 裁决: 源消息已被修改或删除，遵旨废黜过时总结。");
        return;
    }

    const { summary: summaryToCommit, settings } = pendingData;

    console.groupCollapsed(`[Amily2号-存档任务-v21.0 最终圣旨版] ${new Date().toLocaleTimeString()}`);
    console.time("总结写入总耗时");

    try {
        const chatIdentifier = await getChatIdentifier();
        const character = characters[context.characterId];
        let targetLorebookName = null;
        let isNewBook = false;
        switch (settings.target) {
            case "character_main":
                targetLorebookName = character?.data?.extensions?.world;
                if (!targetLorebookName) {
                    toastr.warning("角色未绑定主世界书，总结写入任务已中止。", "Amily2号");
                    console.groupEnd();
                    return;
                }
                break;
            case "dedicated":
                targetLorebookName = `${DEDICATED_LOREBOOK_NAME}-${chatIdentifier}`;
                break;
            default:
                toastr.error(`收到未知的写入指令: "${settings.target}"`, "Amily2号");
                console.groupEnd();
                return;
        }

        if (!world_names.includes(targetLorebookName)) {
            await createNewWorldInfo(targetLorebookName);
            isNewBook = true;
        }

        const uniqueLoreName = `${LOREBOOK_PREFIX}${chatIdentifier}`;
        const bookData = await loadWorldInfo(targetLorebookName);
        if (!bookData) {
            toastr.error(`无法加载世界书《${targetLorebookName}》`, "Amily2号");
            console.groupEnd();
            return;
        }

        const existingEntry = Object.values(bookData.entries).find(e => e.comment === uniqueLoreName && !e.disable);

        if (existingEntry) {
            const existingContent = existingEntry.content.replace(INTRODUCTORY_TEXT, "").trim();
            const lines = existingContent ? existingContent.split("\n") : [];
            const nextNumber = lines.length + 1;
            existingEntry.content += `\n${nextNumber}. ${summaryToCommit}`;
        } else {

            const positionMap = {
                'before_char': 0, 'after_char': 1, 'before_an': 2,
                'after_an': 3, 'at_depth': 4
            };

            const finalKeywords = settings.keywords.split(',').map(k => k.trim()).filter(Boolean);
            const isConstant = settings.activationMode === 'always';
            const newEntry = createWorldInfoEntry(targetLorebookName, bookData);
            Object.assign(newEntry, {
                comment: uniqueLoreName,
                content: `${INTRODUCTORY_TEXT}1. ${summaryToCommit}`,
                key: finalKeywords,
                constant: isConstant,
                position: positionMap[settings.insertionPosition] ?? 4,
                depth: settings.depth,
                disable: false,
            });
        }


        await saveWorldInfo(targetLorebookName, bookData, true);
        console.log(`[史官司] 总结已遵旨写入《${targetLorebookName}》文件。`);

        if (isNewBook) {
            await refreshWorldbookListOnly(targetLorebookName);
            toastr.success(`已创建并写入新档案《${targetLorebookName}》！`, "Amily2号");
        }
    } catch (error) {
        console.error("[Amily2号-写入失败] 写入流程发生意外错误:", error);
        toastr.error("后台写入总结时发生错误。", "Amily2号");
    } finally {
        console.timeEnd("总结写入总耗时");
        console.groupEnd();
    }
}
