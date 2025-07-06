

import { getContext, extension_settings } from "/scripts/extensions.js";
import { characters, saveChatConditional, reloadCurrentChat } from "/script.js";
import { extensionName } from "../utils/settings.js";
import { checkAndFixWithAPI } from "./api.js";
import { writeSummaryToLorebook, getChatIdentifier } from "./lore.js";


const pendingWriteData = {
  summary: null,
  targetLorebook: null,
  chatIdentifier: null,
  sourceAiMessageTimestamp: null, 
};

export async function onMessageReceived(data) {
  const context = getContext();
  if ((data && data.is_user) || context.isWaitingForUserInput) {
    return;
  }

  const settings = extension_settings[extensionName];
  const chat = context.chat;
  if (!chat || chat.length === 0) return;

  const latestMessage = chat[chat.length - 1];

  if (latestMessage.is_user || !settings.enabled) {
    return;
  }

  if (pendingWriteData.summary) {
    await writeSummaryToLorebook(pendingWriteData);
  }
  if (!settings.optimizationEnabled && !settings.summarizationEnabled) {
    console.log("[Amily2号] 优化与总结功能均未启用，任务中止。");
    return;
  }
  if (!settings.apiUrl) return;

  const contextCount = settings.contextMessages || 2;
  const startIndex = Math.max(0, chat.length - 1 - contextCount);
  const previousMessages = chat.slice(startIndex, chat.length - 1);
  const result = await checkAndFixWithAPI(latestMessage, previousMessages);

  if (result) {
    if (
      result.optimizedContent &&
      result.optimizedContent !== latestMessage.mes &&
      settings.optimizationEnabled
    ) {
      latestMessage.mes = result.optimizedContent;
      await saveChatConditional();
      if (settings.optimizationMode === "refresh") {
        await reloadCurrentChat();
      }
    }

    if (result.summary && settings.summarizationEnabled) {

      pendingWriteData.summary = result.summary;
      pendingWriteData.sourceAiMessageTimestamp = latestMessage.send_date;
      pendingWriteData.targetLorebook = settings.lorebookTarget;
      pendingWriteData.chatIdentifier = await getChatIdentifier();

      if (settings.showOptimizationToast) {
        let targetName = "独立中央档案";
        if (settings.lorebookTarget === "character_main") {
          const character = characters[context.characterId];
          targetName = character?.data?.extensions?.world || "未绑定的主世界书";
        }
        toastr.info(
          `已优化并将总结：“${result.summary}” 写入 “${targetName}”`,
          "Amily2号",
          { timeOut: 7000 },
        );
      }
    }
  }
}


export function onChatChanged() {
  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) {
    pendingWriteData.summary = null;
    return;
  }
  const latestMessage = chat[chat.length - 1];
  if (latestMessage.is_user && pendingWriteData.summary) {
    console.log(
      "[Amily2号-遗忘哨兵] 检测到AI回复被操作，已清除待写入的过时总结。",
    );
    pendingWriteData.summary = null;
  }
}
