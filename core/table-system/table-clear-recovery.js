import { TABLE_FILL_REVIEW_INBOX_KEY } from './fill-review-inbox.js';
import {
    TABLE_FILL_GROUP_PROGRESS_KEY,
    TABLE_FILL_PROGRESS_KEYS,
} from './infra/fill-progress.js';
import { TABLE_SNAPSHOT_PROVENANCE_KEY } from './infra/snapshot-provenance.js';
import { TABLE_STATE_BACKUP_HISTORY_KEY } from './compat/tdb/table-state-backups.js';
import { deepClone, normalizeTableDatabaseState, TABLE_STATE_METADATA_KEY } from './infra/database-state.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { sha256TextHex } from '../utils/sha256.js';

export const TABLE_CLEAR_RECOVERY_KEY = 'amily2_table_clear_recovery_v1';
export const TABLE_CLEAR_RECOVERY_FORMAT = 'amily2.table-clear-recovery';
export const TABLE_CLEAR_RECOVERY_VERSION = 1;

// Resolve live bindings at call time: metadata persistence also imports this service.
function recoverableMetadataKeys() {
    return [TABLE_FILL_REVIEW_INBOX_KEY, TABLE_STATE_BACKUP_HISTORY_KEY];
}

function hasOwn(value, key) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function sameValue(left, right) {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function recoveryError(code, message) {
    const error = new Error(message);
    error.code = `TABLE_CLEAR_${code}`;
    return error;
}

function messageKeys(tableDataKey) {
    return Object.freeze([
        tableDataKey,
        TABLE_SNAPSHOT_PROVENANCE_KEY,
        ...TABLE_FILL_PROGRESS_KEYS,
        TABLE_FILL_GROUP_PROGRESS_KEY,
    ]);
}

function captureKeySet(carrier, keys) {
    const captured = {};
    for (const key of keys) {
        if (hasOwn(carrier, key)) captured[key] = deepClone(carrier[key]);
    }
    return captured;
}

function keySetMatches(carrier, keys, expected) {
    for (const key of keys) {
        const expectedPresent = hasOwn(expected, key);
        if (hasOwn(carrier, key) !== expectedPresent) return false;
        if (expectedPresent && !sameValue(carrier[key], expected[key])) return false;
    }
    return true;
}

function restoreKeySet(carrier, keys, captured) {
    for (const key of keys) {
        if (hasOwn(captured, key)) carrier[key] = deepClone(captured[key]);
        else delete carrier[key];
    }
}

function pruneEmptyExtra(message, extraExisted) {
    if (!extraExisted && message?.extra && Object.keys(message.extra).length === 0) {
        delete message.extra;
    }
}

function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function captureChatOwner(context) {
    if (context?.groupId !== undefined && context.groupId !== null && context.groupId !== '') {
        return { type: 'group', id: String(context.groupId) };
    }
    const avatar = context?.characters?.[context.characterId]?.avatar;
    return avatar ? { type: 'character', id: String(avatar) } : null;
}

function recoveryBelongsToChat(recovery, context) {
    return (!hasOwn(recovery, 'chatId') || recovery.chatId === captureChatScope(context).chatId)
        && (!hasOwn(recovery, 'chatOwner') || sameValue(recovery.chatOwner, captureChatOwner(context)));
}

function emptyTableRows(tables) {
    return deepClone(tables).map(table => ({ ...table, rows: [], rowStatuses: [], rowMeta: [] }));
}

function captureMessageIdentity(message) {
    return captureKeySet(message, ['mes', 'is_user', 'name', 'send_date', 'swipe_id', 'swipes']);
}

async function fingerprintMessageIdentities(identities) {
    return {
        algorithm: 'sha256',
        messageCount: identities.length,
        hash: await sha256TextHex(JSON.stringify(identities)),
    };
}

function captureCarriers(chat, keys) {
    const carriers = [];
    chat.forEach((message, index) => {
        carriers.push({ index, owner: message, extra: captureKeySet(message?.extra, keys) });
        message?.swipe_info?.forEach((swipe, swipeIndex) => {
            if (isRecord(swipe)) {
                carriers.push({ index, swipeIndex, owner: swipe, extra: captureKeySet(swipe.extra, keys) });
            }
        });
    });
    return carriers;
}

function carrierOwner(chat, entry) {
    return hasOwn(entry, 'swipeIndex')
        ? chat[entry.index]?.swipe_info?.[entry.swipeIndex]
        : chat[entry.index];
}

// Roll back only values owned by this transaction; a failed save must not
// erase a newer host/plugin write. The recovery package retains conflicts.
function rollbackKeys(carrier, keys, staged, previous) {
    let complete = true;
    const snapshotKeys = keys.includes(TABLE_SNAPSHOT_PROVENANCE_KEY)
        ? [keys[0], TABLE_SNAPSHOT_PROVENANCE_KEY] : [];
    const snapshotConflict = snapshotKeys.some(key => !keySetMatches(carrier, [key], staged));
    for (const key of keys) {
        if ((snapshotConflict && snapshotKeys.includes(key)) || !keySetMatches(carrier, [key], staged)) {
            complete = false;
            continue;
        }
        restoreKeySet(carrier, [key], previous);
    }
    return complete;
}

function assertRecovery(value) {
    if (!value
        || typeof value !== 'object'
        || Array.isArray(value)
        || value.format !== TABLE_CLEAR_RECOVERY_FORMAT
        || value.version !== TABLE_CLEAR_RECOVERY_VERSION
        || value.status !== 'PENDING_DELETE'
        || !Array.isArray(value.tables)
        || !Array.isArray(value.messages)
        || !value.metadata
        || typeof value.metadata !== 'object'
        || Array.isArray(value.metadata)) {
        throw recoveryError('RECOVERY_INVALID', '待删除表格恢复包已损坏，不能继续操作。');
    }
    const seen = new Set();
    for (const entry of value.messages) {
        const id = `${entry?.index}:${entry?.swipeIndex ?? 'message'}`;
        if (!isRecord(entry) || !Number.isSafeInteger(entry.index) || entry.index < 0
            || !isRecord(entry.extra)
            || (hasOwn(entry, 'swipeIndex')
                && (!Number.isSafeInteger(entry.swipeIndex) || entry.swipeIndex < 0))
            || seen.has(id)) {
            throw recoveryError('RECOVERY_INVALID', '待删除表格恢复包的消息记录已损坏。');
        }
        seen.add(id);
    }
    if (value.tables.some(table => !isRecord(table)
        || !Array.isArray(table.headers) || !Array.isArray(table.rows))
        || (hasOwn(value, 'messageIdentities') && !Array.isArray(value.messageIdentities))) {
        throw recoveryError('RECOVERY_INVALID', '待删除表格恢复包的表格或消息身份已损坏。');
    }
    if (hasOwn(value, 'messageIdentity')) {
        const identity = value.messageIdentity;
        if (!isRecord(identity) || identity.algorithm !== 'sha256'
            || typeof identity.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.hash)
            || !Number.isSafeInteger(identity.messageCount) || identity.messageCount < 0
            || value.messages.some(entry => entry.index >= identity.messageCount)) {
            throw recoveryError('RECOVERY_INVALID', '待删除表格恢复包的消息指纹已损坏。');
        }
    }
    return value;
}

export function readPendingTableClearRecovery(context) {
    const raw = context?.chatMetadata?.[TABLE_CLEAR_RECOVERY_KEY];
    if (!raw) return null;
    try {
        // Pre-fingerprint development packages may contain prose. Never
        // include that obsolete identity evidence in a public table export.
        const { messageIdentities, ...recovery } = assertRecovery(raw);
        return deepClone(recovery);
    } catch (error) {
        console.error('[TableClearRecovery] Ignored an invalid recovery package.', error);
        return null;
    }
}

export function summarizePendingTableClearRecovery(context) {
    const recovery = readPendingTableClearRecovery(context);
    if (!recovery) return null;
    return Object.freeze({
        createdAt: recovery.createdAt,
        tableCount: recovery.tables.length,
        rowCount: recovery.tables.reduce((count, table) => count + table.rows.length, 0),
        messageSnapshotCount: recovery.messages.length,
    });
}

export async function createTableClearRecoveryPlan(context, tables, { tableDataKey } = {}) {
    if (!context || !Array.isArray(context.chat) || !context.chatMetadata) {
        throw recoveryError('NO_CHAT', '当前聊天尚未准备好，不能清空表格。');
    }
    if (!tableDataKey) throw recoveryError('NO_TABLE_KEY', '缺少表格快照键。');
    if (hasOwn(context.chatMetadata, TABLE_CLEAR_RECOVERY_KEY)) {
        throw recoveryError('ALREADY_PENDING', '上一次清空仍可恢复，请先恢复、导出或确认永久删除。');
    }

    const keys = messageKeys(tableDataKey);
    const scope = captureChatScope(context);
    const chatOwner = captureChatOwner(context);
    const messageRefs = context.chat.slice();
    const messageIdentities = messageRefs.map(captureMessageIdentity);
    const carriers = captureCarriers(context.chat, keys);
    const recoverableCarriers = carriers.filter(entry => Object.keys(entry.extra).length > 0);
    const messages = recoverableCarriers.map(({ owner, ...entry }) => entry);
    const metadata = captureKeySet(context.chatMetadata, recoverableMetadataKeys());
    const stateBefore = captureKeySet(context.chatMetadata, [TABLE_STATE_METADATA_KEY]);
    const recovery = Object.freeze({
        format: TABLE_CLEAR_RECOVERY_FORMAT,
        version: TABLE_CLEAR_RECOVERY_VERSION,
        status: 'PENDING_DELETE',
        createdAt: new Date().toISOString(),
        tableCount: tables.length,
        rowCount: tables.reduce((count, table) => count + (table?.rows?.length || 0), 0),
        tables: deepClone(tables),
        chatId: scope.chatId,
        chatOwner,
        profile: deepClone(context.chatMetadata[TABLE_STATE_METADATA_KEY]?.profile ?? null),
        tableGroups: deepClone(context.chatMetadata[TABLE_STATE_METADATA_KEY]?.tableGroups ?? null),
        messageIdentity: await fingerprintMessageIdentities(messageIdentities),
        messages,
        metadata,
    });
    const emptyTables = emptyTableRows(recovery.tables);
    let staged = false;

    return Object.freeze({
        emptyTables,
        recovery: deepClone(recovery),
        beforeSave({ context: liveContext }) {
            if (!chatScopesMatch(scope, captureChatScope(liveContext))
                || !sameValue(chatOwner, captureChatOwner(liveContext))
                || liveContext.chat.length !== messageRefs.length
                || liveContext.chat.some((message, index) => message !== messageRefs[index]
                    || !sameValue(captureMessageIdentity(message), messageIdentities[index]))) {
                throw recoveryError('CHAT_CHANGED', '清空期间聊天已变化，本次操作已取消。');
            }
            if (hasOwn(liveContext.chatMetadata, TABLE_CLEAR_RECOVERY_KEY)) {
                throw recoveryError('ALREADY_PENDING', '当前聊天已经存在待恢复的清空记录。');
            }
            const liveCarriers = captureCarriers(liveContext.chat, keys);
            if (liveCarriers.length !== carriers.length) {
                throw recoveryError('SNAPSHOT_CHANGED', '清空期间历史分支发生变化。');
            }
            for (const [index, entry] of carriers.entries()) {
                if (liveCarriers[index].owner !== entry.owner
                    || !keySetMatches(entry.owner?.extra, keys, entry.extra)) {
                    throw recoveryError('SNAPSHOT_CHANGED', '清空期间历史快照或填表游标发生变化。');
                }
            }
            if (!keySetMatches(liveContext.chatMetadata, recoverableMetadataKeys(), metadata)
                || !keySetMatches(liveContext.chatMetadata, [TABLE_STATE_METADATA_KEY], stateBefore)) {
                throw recoveryError('METADATA_CHANGED', '清空期间表格备份或待审记录发生变化。');
            }

            staged = true;
            liveContext.chatMetadata[TABLE_CLEAR_RECOVERY_KEY] = deepClone(recovery);
            for (const entry of messages) {
                const message = carrierOwner(messageRefs, entry);
                const extraExisted = Boolean(message.extra);
                for (const key of keys) delete message.extra[key];
                pruneEmptyExtra(message, extraExisted);
            }
            for (const key of recoverableMetadataKeys()) delete liveContext.chatMetadata[key];
        },
        rollback({ context: liveContext }) {
            if (!staged || !chatScopesMatch(scope, captureChatScope(liveContext))
                || !sameValue(chatOwner, captureChatOwner(liveContext))) return;
            let complete = true;
            for (const [index, entry] of messages.entries()) {
                const message = carrierOwner(liveContext.chat, entry);
                const captured = recoverableCarriers[index];
                if (!message || message !== captured.owner
                    || liveContext.chat[entry.index] !== messageRefs[entry.index]
                    || !sameValue(captureMessageIdentity(liveContext.chat[entry.index]), messageIdentities[entry.index])) {
                    complete = false;
                    continue;
                }
                if (!message.extra || typeof message.extra !== 'object') message.extra = {};
                complete = rollbackKeys(message.extra, keys, {}, entry.extra) && complete;
            }
            complete = rollbackKeys(liveContext.chatMetadata, recoverableMetadataKeys(), {}, metadata) && complete;
            if (complete && sameValue(liveContext.chatMetadata[TABLE_CLEAR_RECOVERY_KEY], recovery)) {
                delete liveContext.chatMetadata[TABLE_CLEAR_RECOVERY_KEY];
            }
            staged = false;
        },
    });
}

export async function createTableClearRestorePlan(context, { tableDataKey, currentTables } = {}) {
    if (!context || !Array.isArray(context.chat) || !context.chatMetadata) {
        throw recoveryError('NO_CHAT', '当前聊天尚未准备好，不能恢复表格。');
    }
    if (!tableDataKey) throw recoveryError('NO_TABLE_KEY', '缺少表格快照键。');
    const capturedRecovery = assertRecovery(deepClone(context.chatMetadata[TABLE_CLEAR_RECOVERY_KEY]));
    const { messageIdentities: legacyIdentities, ...recovery } = capturedRecovery;
    const keys = messageKeys(tableDataKey);
    const scope = captureChatScope(context);
    const chatOwner = captureChatOwner(context);
    const emptyTables = normalizeTableDatabaseState(emptyTableRows(recovery.tables));
    if (currentTables !== undefined && !sameValue(currentTables, emptyTables)) {
        throw recoveryError('RESTORE_CONFLICT', '当前表格已变化，不能覆盖恢复。');
    }
    const messageRefs = context.chat.slice();
    const owners = recovery.messages.map(entry => carrierOwner(messageRefs, entry));
    const extraExistence = new Map();
    if (!recovery.messageIdentity && !legacyIdentities) {
        throw recoveryError('RESTORE_CONFLICT', '旧恢复包缺少消息身份校验，请先导出备份，不能自动覆盖恢复。');
    }
    const prefixLength = recovery.messageIdentity?.messageCount ?? legacyIdentities.length;
    if (messageRefs.length < prefixLength) {
        throw recoveryError('RESTORE_CONFLICT', '清空前的聊天消息已被删除，不能覆盖恢复。');
    }
    // Raw identity fields stay in this short-lived plan only. They allow a
    // synchronous beforeSave recheck after the asynchronous SHA-256 digest.
    const prefixIdentities = messageRefs.slice(0, prefixLength).map(captureMessageIdentity);
    const fingerprint = await fingerprintMessageIdentities(prefixIdentities);
    const expectedFingerprint = recovery.messageIdentity
        ?? await fingerprintMessageIdentities(legacyIdentities);
    if (fingerprint.hash !== expectedFingerprint.hash
        || fingerprint.messageCount !== expectedFingerprint.messageCount) {
        throw recoveryError('RESTORE_CONFLICT', '清空前的聊天消息已变化，不能覆盖恢复。');
    }
    recovery.messageIdentity = expectedFingerprint;
    let staged = false;

    return Object.freeze({
        tables: deepClone(recovery.tables),
        beforeSave({ context: liveContext }) {
            if (!chatScopesMatch(scope, captureChatScope(liveContext))
                || liveContext.chat.length < messageRefs.length
                || messageRefs.some((message, index) => liveContext.chat[index] !== message)
                || !sameValue(liveContext.chatMetadata[TABLE_CLEAR_RECOVERY_KEY], capturedRecovery)) {
                throw recoveryError('CHAT_CHANGED', '恢复期间聊天或待删除记录已经变化。');
            }
            if (!recoveryBelongsToChat(recovery, liveContext)
                || !sameValue(chatOwner, captureChatOwner(liveContext))
                || (hasOwn(recovery, 'profile') && !sameValue(recovery.profile,
                    liveContext.chatMetadata[TABLE_STATE_METADATA_KEY]?.profile ?? null))
                || (hasOwn(recovery, 'tableGroups') && !sameValue(recovery.tableGroups,
                    liveContext.chatMetadata[TABLE_STATE_METADATA_KEY]?.tableGroups ?? null))
                || (hasOwn(liveContext.chatMetadata[TABLE_STATE_METADATA_KEY], 'tables')
                    && !sameValue(liveContext.chatMetadata[TABLE_STATE_METADATA_KEY].tables, emptyTables))
                || prefixIdentities.some((identity, index) => !sameValue(identity,
                    captureMessageIdentity(liveContext.chat[index])))) {
                throw recoveryError('RESTORE_CONFLICT', '聊天身份、消息、表结构或当前 Profile 已变化，不能覆盖恢复。');
            }
            if (captureCarriers(liveContext.chat, keys).some(entry => Object.keys(entry.extra).length > 0)) {
                throw recoveryError('RESTORE_CONFLICT', '当前聊天已产生新的快照或填表游标。');
            }
            for (const [index, entry] of recovery.messages.entries()) {
                const message = carrierOwner(messageRefs, entry);
                if (!message || message !== owners[index] || !keySetMatches(message.extra, keys, {})) {
                    throw recoveryError('RESTORE_CONFLICT', '历史消息已产生新的表格状态，不能覆盖恢复。');
                }
            }
            if (!keySetMatches(liveContext.chatMetadata, recoverableMetadataKeys(), {})) {
                throw recoveryError('RESTORE_CONFLICT', '当前聊天已产生新的表格备份或待审记录。');
            }

            staged = true;
            for (const entry of recovery.messages) {
                const message = carrierOwner(messageRefs, entry);
                extraExistence.set(message, Boolean(message.extra));
                if (!message.extra || typeof message.extra !== 'object') message.extra = {};
                restoreKeySet(message.extra, keys, entry.extra);
            }
            restoreKeySet(liveContext.chatMetadata, recoverableMetadataKeys(), recovery.metadata);
            delete liveContext.chatMetadata[TABLE_CLEAR_RECOVERY_KEY];
        },
        rollback({ context: liveContext }) {
            if (!staged || !chatScopesMatch(scope, captureChatScope(liveContext))
                || !sameValue(chatOwner, captureChatOwner(liveContext))) return;
            for (const [index, entry] of recovery.messages.entries()) {
                const message = carrierOwner(liveContext.chat, entry);
                if (!message?.extra || message !== owners[index]
                    || liveContext.chat[entry.index] !== messageRefs[entry.index]) continue;
                rollbackKeys(message.extra, keys, entry.extra, {});
                pruneEmptyExtra(message, extraExistence.get(message));
            }
            rollbackKeys(liveContext.chatMetadata, recoverableMetadataKeys(), recovery.metadata, {});
            if (!hasOwn(liveContext.chatMetadata, TABLE_CLEAR_RECOVERY_KEY)) {
                liveContext.chatMetadata[TABLE_CLEAR_RECOVERY_KEY] = deepClone(recovery);
            }
            staged = false;
        },
    });
}

function captureTableMutationValue(context) {
    return JSON.stringify({
        metadata: captureKeySet(context.chatMetadata, [TABLE_STATE_METADATA_KEY, ...recoverableMetadataKeys()]),
        messages: captureCarriers(context.chat || [], messageKeys('amily2_tables_data'))
            .filter(entry => Object.keys(entry.extra).length > 0)
            .map(({ owner, ...entry }) => entry),
    });
}

export function capturePendingTableClearMutation(context, transaction = {}) {
    if (transaction.preservePendingTableClearRecovery === true
        || !hasOwn(context?.chatMetadata, TABLE_CLEAR_RECOVERY_KEY)) return null;
    const value = deepClone(assertRecovery(context.chatMetadata[TABLE_CLEAR_RECOVERY_KEY]));
    if (!recoveryBelongsToChat(value, context)) {
        throw recoveryError('CHAT_CHANGED', '待删除恢复记录不属于当前聊天，不能移除。');
    }
    return {
        value,
        mutation: captureTableMutationValue(context),
    };
}

export function stagePendingTableClearFinalization(context, transaction = {}, before = undefined) {
    if (transaction.preservePendingTableClearRecovery === true) return null;
    if (before === null) return null;
    const metadata = context?.chatMetadata;
    if (!hasOwn(metadata, TABLE_CLEAR_RECOVERY_KEY)) return null;
    if (before) {
        if (!sameValue(metadata[TABLE_CLEAR_RECOVERY_KEY], before.value)) {
            throw recoveryError('CHAT_CHANGED', '待删除恢复记录已经变化，本次提交已取消。');
        }
        if (transaction.finalizePendingTableClearRecovery !== true
            && before.mutation === captureTableMutationValue(context)) return null;
    }
    const value = deepClone(assertRecovery(metadata[TABLE_CLEAR_RECOVERY_KEY]));
    if (!recoveryBelongsToChat(value, context)) {
        throw recoveryError('CHAT_CHANGED', '待删除恢复记录不属于当前聊天，不能移除。');
    }
    delete metadata[TABLE_CLEAR_RECOVERY_KEY];
    return Object.freeze({ value, scope: captureChatScope(context), chatOwner: captureChatOwner(context) });
}

export function rollbackPendingTableClearFinalization(context, backup) {
    if (!backup || !chatScopesMatch(backup.scope, captureChatScope(context))
        || !sameValue(backup.chatOwner, captureChatOwner(context))) return;
    if (!hasOwn(context.chatMetadata, TABLE_CLEAR_RECOVERY_KEY)) {
        context.chatMetadata[TABLE_CLEAR_RECOVERY_KEY] = deepClone(backup.value);
    }
}

export function notifyTableClearRecoveryChanged(detail = {}) {
    try {
        if (typeof document !== 'undefined'
            && typeof document.dispatchEvent === 'function'
            && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('amily2:tableClearRecoveryChanged', { detail }));
            if (detail.action === 'created' || detail.action === 'restored') {
                document.dispatchEvent(new CustomEvent('amily2:secondaryFillProgressChanged', {
                    detail: { reason: `table-clear-${detail.action}` },
                }));
            }
        }
    } catch (error) {
        console.error('[TableClearRecovery] Failed to publish recovery state.', error);
    }
}
