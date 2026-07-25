'use strict';

function hasContextValue(value) {
    return value !== undefined && value !== null && value !== '';
}

/**
 * 判断 SillyTavern 是否已经进入一个真实聊天上下文。
 *
 * 欢迎页可能也带有占位消息，因此不能用 `context.chat.length` 判断；
 * 只有角色、群组或稳定聊天标识存在时才视为已进入聊天。
 */
export function isActiveChatContext(context) {
    if (!context || typeof context !== 'object') return false;

    return [
        context.characterId,
        context.groupId,
        context.chatId,
        context.chat_filename,
        context.chatFile,
    ].some(hasContextValue);
}

/** 群聊没有单一角色 ID，缺失角色 ID 不应被报告为异常。 */
export function shouldReportMissingCharacterId(context) {
    return isActiveChatContext(context) && !hasContextValue(context?.groupId);
}

