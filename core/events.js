import { getContext, extension_settings } from "/scripts/extensions.js";
import { characters, saveChatConditional, reloadCurrentChat } from "/script.js";
import { extensionName } from "../utils/settings.js";
import { checkAndFixWithAPI } from "./api.js";
import { writeSummaryToLorebook, getChatIdentifier } from "./lore.js";
import { executeAutoHide } from './autoHideManager.js';

const pendingWriteData = {
  summary: null,
  targetLorebook: null, // (此条目很快将被新设定取代，但为兼容性暂时保留)
  settings: null,         // 【新增栏位】用以存放完整的史册律法。
  chatIdentifier: null,
  sourceAiMessageTimestamp: null,
};

export async function onMessageReceived(data) {
    const context = getContext();
    if ((data && data.is_user) || context.isWaitingForUserInput) { return; }

    const settings = extension_settings[extensionName];
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const latestMessage = chat[chat.length - 1];
    if (latestMessage.is_user) { return; }

    await executeAutoHide();

    if (pendingWriteData.summary && pendingWriteData.settings) {
        await writeSummaryToLorebook(pendingWriteData);
        pendingWriteData.summary = null;
        pendingWriteData.settings = null;
    }

    if (!settings.enabled || (!settings.optimizationEnabled && !settings.summarizationEnabled) || !settings.apiUrl) {
        return;
    }

    if (chat.length < 2 || !chat[chat.length - 2].is_user) {
        console.log("[Amily2号] 检测到消息并非AI对用户的直接回复，已跳过优化总结。");
        return;
    }

    const contextCount = settings.contextMessages || 2;
    const startIndex = Math.max(0, chat.length - 1 - contextCount);
    const previousMessages = chat.slice(startIndex, chat.length - 1);
    const result = await checkAndFixWithAPI(latestMessage, previousMessages);

    if (result) {
        if (result.optimizedContent && result.optimizedContent !== latestMessage.mes && settings.optimizationEnabled) {
            latestMessage.mes = result.optimizedContent;
            await saveChatConditional();
            if (settings.optimizationMode === 'refresh') {
                await reloadCurrentChat();
            }
        }


        if (result.summary && result.loreSettings && settings.summarizationEnabled) {
            pendingWriteData.summary = result.summary;
            pendingWriteData.settings = result.loreSettings; 
            pendingWriteData.sourceAiMessageTimestamp = latestMessage.send_date;
            pendingWriteData.chatIdentifier = await getChatIdentifier();

            if (settings.showOptimizationToast) {
                let targetName = `独立中央档案(${result.loreSettings.target})`;
                if (result.loreSettings.target === "character_main") {
                    const character = characters[context.characterId];
                    targetName = character?.data?.extensions?.world || "未绑定的主世界书";
                }
                toastr.info(`已优化并将总结：“${result.summary}” 备妥，待写入 “${targetName}”`, "Amily2号", { timeOut: 7000 });
            }
        }
        // ====================================================================
    }
}
export function onChatChanged() {
  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) {
    pendingWriteData.summary = null;
    pendingWriteData.settings = null;
    return;
  }
  const latestMessage = chat[chat.length - 1];
  if (latestMessage.is_user && pendingWriteData.summary) {
    console.log(
      "[Amily2号-遗忘哨兵] 裁决：检测到AI回复已被陛下操作，遵旨废黜过时总结。",
    );
    pendingWriteData.summary = null;
    pendingWriteData.settings = null;
  }
}
