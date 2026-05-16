/**
 * @file ITablePersistence 实现 —— 表格状态的持久化层。
 *
 * 替代 manager.js 中：
 *   - saveStateToMessage(state, targetMessage)  → 写入指定消息的 extra
 *   - 16 处复制样板（getContext + saveStateToMessage + saveChat / saveChatDebounced）
 *     被合并为 commitToLastMessage / commitToLastMessageAsync 两个函数
 *
 * 不读取 store；调用方显式传入要持久化的 state。这样：
 *   - 测试容易（不依赖全局单例）
 *   - 万一未来需要在事务边界提交"快照"而非当前 state，接口已就位
 *
 * @typedef {import('../dto/Table.js').TableState} TableState
 */

import { saveChat } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { saveChatDebounced } from '../../../utils/utils.js';
import { log } from '../logger.js';

/**
 * message.extra 中存储表格状态的 key。
 * 此值不能轻易改 —— 所有历史聊天的存档都用这个 key。
 */
export const TABLE_DATA_KEY = 'amily2_tables_data';

/**
 * 把状态深拷贝写入指定消息的 metadata。
 * 不主动调用 saveChat —— 写盘时机由调用方决定。
 *
 * @param {TableState | null} stateToSave
 * @param {Object} targetMessage
 * @returns {boolean} 是否写入成功
 */
export function saveStateToMessage(stateToSave, targetMessage) {
    if (!stateToSave || !targetMessage) {
        log('缺少状态或目标消息，无法保存。', 'error');
        return false;
    }

    if (!targetMessage.extra) {
        targetMessage.extra = {};
    }

    targetMessage.extra[TABLE_DATA_KEY] = JSON.parse(JSON.stringify(stateToSave));
    log(`表格状态已准备写入消息 [${targetMessage.mes.substring(0, 20)}...]`, 'info');
    return true;
}

/**
 * 把 state 提交到 chat 最新一条消息并立即 saveChat。
 *
 * 该函数封装了 manager.js 中复制了 16 次的样板：
 *   const context = getContext();
 *   if (context.chat && context.chat.length > 0) {
 *       const lastMessage = context.chat[context.chat.length - 1];
 *       if (saveStateToMessage(state, lastMessage)) {
 *           saveChat();
 *           return;
 *       }
 *   }
 *   saveChatDebounced();
 *
 * @param {TableState | null} state
 * @returns {boolean} true = 走 last-message commit 路径；false = 降级到 debounced
 */
export function commitToLastMessage(state) {
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(state, lastMessage)) {
            saveChat();
            return true;
        }
    }
    saveChatDebounced();
    return false;
}

/**
 * commitToLastMessage 的 async 变体。
 * deleteRow / restoreRow / rollbackState 等需要等 saveChat 完成后才做后续渲染的场景使用。
 *
 * @param {TableState | null} state
 * @returns {Promise<boolean>}
 */
export async function commitToLastMessageAsync(state) {
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(state, lastMessage)) {
            await saveChat();
            return true;
        }
    }
    await saveChatDebounced();
    return false;
}
