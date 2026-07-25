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
import {
    deepClone,
    persistChatTableState,
    persistChatTableStateAsync,
    TABLE_STATE_METADATA_KEY,
} from './database-state.js';
import { validateTableState } from '../module-tables.js';

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

    const normalizedState = prepareStateForCommit(stateToSave);
    if (!normalizedState) return false;

    if (!targetMessage.extra) {
        targetMessage.extra = {};
    }

    const hadPreviousSnapshot = Object.prototype.hasOwnProperty.call(targetMessage.extra, TABLE_DATA_KEY);
    const previousSnapshot = targetMessage.extra[TABLE_DATA_KEY];
    targetMessage.extra[TABLE_DATA_KEY] = JSON.parse(JSON.stringify(normalizedState));
    if (!persistChatTableState(getContext(), normalizedState)) {
        if (hadPreviousSnapshot) targetMessage.extra[TABLE_DATA_KEY] = previousSnapshot;
        else delete targetMessage.extra[TABLE_DATA_KEY];
        log('无法同步聊天 metadata，消息快照写入已回退。', 'error');
        return false;
    }
    log(`表格状态已准备写入消息 [${String(targetMessage.mes ?? '').substring(0, 20)}...]`, 'info');
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
    const normalizedState = prepareStateForCommit(state);
    if (!normalizedState) return false;
    const metadataPersisted = persistChatTableState(context, normalizedState);
    saveChatDebounced();
    if (metadataPersisted) {
        log('当前聊天尚无消息，表格状态已保存到聊天 metadata。', 'info');
    }
    return metadataPersisted;
}

/**
 * commitToLastMessage 的 async 变体。
 * deleteRow / restoreRow / rollbackState 等需要等 saveChat 完成后才做后续渲染的场景使用。
 *
 * @param {TableState | null} state
 * @param {Object | null | undefined} [profile] optional profile replacement
 * @returns {Promise<boolean>}
 */
export async function commitToLastMessageAsync(state, profile = undefined) {
    const context = getContext();
    if (!context) {
        log('缺少聊天上下文，无法提交表格状态。', 'error');
        return false;
    }
    if (context.chat && context.chat.length > 0) {
        return commitToMessageAsync(state, context.chat[context.chat.length - 1], profile);
    }

    const normalizedState = prepareStateForCommit(state);
    if (!normalizedState) return false;
    const metadataBackup = captureMetadataState(context);
    try {
        const metadataPersisted = await persistChatTableStateAsync(context, normalizedState, profile);
        if (!metadataPersisted) throw new Error('Chat metadata rejected the table state.');
        await saveChatDebounced();
        log('当前聊天尚无消息，表格状态已保存到聊天 metadata。', 'info');
        return true;
    } catch (error) {
        restoreMetadataState(context, metadataBackup);
        await compensatePersistenceRollback(context, false);
        log(`无消息聊天的表格提交失败，已恢复提交前状态: ${error.message}`, 'error');
        return false;
    }
}

/**
 * Persist to a specific history message and v2 metadata as one compensated transaction.
 * Optional chat mutations are staged immediately before the durable writes and
 * rolled back before compensation, so process markers can share this boundary.
 */
export async function commitToMessageAsync(state, targetMessage, profile = undefined, transaction = {}) {
    const context = getContext();
    if (!context || !targetMessage) {
        log('缺少聊天上下文或目标消息，无法提交表格状态。', 'error');
        return false;
    }
    const normalizedState = prepareStateForCommit(state);
    if (!normalizedState) return false;

    const metadataBackup = captureMetadataState(context);
    const snapshotBackup = captureMessageSnapshot(targetMessage);
    try {
        if (typeof transaction.beforeSave === 'function') transaction.beforeSave();
        if (!targetMessage.extra) targetMessage.extra = {};
        targetMessage.extra[TABLE_DATA_KEY] = deepClone(normalizedState);
        if (!await persistChatTableStateAsync(context, normalizedState, profile)) {
            throw new Error('Chat metadata rejected the table state.');
        }
        await saveChat();
        log(`表格状态已写入消息 [${String(targetMessage.mes ?? '').substring(0, 20)}...]`, 'info');
        return true;
    } catch (error) {
        try {
            if (typeof transaction.rollback === 'function') transaction.rollback();
        } catch (rollbackError) {
            log(`附加聊天变更回退失败: ${rollbackError.message}`, 'error');
        }
        restoreMessageSnapshot(targetMessage, snapshotBackup);
        restoreMetadataState(context, metadataBackup);
        await compensatePersistenceRollback(context, true);
        log(`表格异步提交失败，已恢复提交前状态: ${error.message}`, 'error');
        return false;
    }
}

function captureMetadataState(context) {
    const metadata = context?.chatMetadata;
    const existed = Boolean(metadata && Object.prototype.hasOwnProperty.call(metadata, TABLE_STATE_METADATA_KEY));
    return {
        existed,
        value: existed ? deepClone(metadata[TABLE_STATE_METADATA_KEY]) : undefined,
    };
}

function restoreMetadataState(context, backup) {
    if (!context) return;
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') context.chatMetadata = {};
    if (backup.existed) context.chatMetadata[TABLE_STATE_METADATA_KEY] = backup.value;
    else delete context.chatMetadata[TABLE_STATE_METADATA_KEY];
}

function captureMessageSnapshot(message) {
    const existed = Boolean(message?.extra
        && Object.prototype.hasOwnProperty.call(message.extra, TABLE_DATA_KEY));
    return {
        existed,
        value: existed ? deepClone(message.extra[TABLE_DATA_KEY]) : undefined,
    };
}

function restoreMessageSnapshot(message, backup) {
    if (!message) return;
    if (!message.extra) message.extra = {};
    if (backup.existed) message.extra[TABLE_DATA_KEY] = backup.value;
    else delete message.extra[TABLE_DATA_KEY];
}

async function compensatePersistenceRollback(context, includeChat) {
    const tasks = [];
    if (typeof context?.saveMetadata === 'function') tasks.push(Promise.resolve().then(() => context.saveMetadata()));
    if (includeChat) tasks.push(Promise.resolve().then(() => saveChat()));
    if (tasks.length > 0) await Promise.allSettled(tasks);
}

function prepareStateForCommit(state) {
    try {
        const normalizedState = validateTableState(state);
        // Preserve the legacy contract: callers holding the store array see the
        // generated stable IDs and normalized parallel metadata immediately.
        if (Array.isArray(state)) {
            state.splice(0, state.length, ...JSON.parse(JSON.stringify(normalizedState)));
        }
        return normalizedState;
    } catch (error) {
        log(`表格状态未通过数据库约束校验，已拒绝保存: ${error.code || 'TABLE_VALIDATION_FAILED'} ${error.message}`, 'error');
        if (typeof toastr !== 'undefined') {
            toastr.error(`表格状态校验失败：${error.message}`, '保存已取消');
        }
        return null;
    }
}
