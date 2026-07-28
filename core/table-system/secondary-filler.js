import { getContext, extension_settings } from "/scripts/extensions.js";
import { loadWorldInfo } from "/scripts/world-info.js";
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { extensionName } from "../../utils/settings.js";
import { updateTableFromText, updateTableFromOps, updateTableFromOperationBatches, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate, convertAiFillableTablesToCsvString, getMemoryState, clearHighlights } from './manager.js';
import { commitToMessageAsync } from './infra/persistence.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';
import { extractBlocksByTags, applyExclusionRules } from '../utils/rag-tag-extractor.js';
import { resolveTableRuleConfig } from '../../utils/config/RuleProfileManager.js';
import { safeLorebookEntries } from '../tavernhelper-compatibility.js';
import { log } from './logger.js';
import { showTableFillReviewModal } from '../../ui/page-window.js';
import {
    SECONDARY_REQUIRED_FILLER_BLOCKS,
    buildFillerFlowPrompt,
    completeFillerPromptOrder,
} from './filler-prompt-order.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { TABLE_FILL_SAFETY_POLICY } from './settings.js';
import {
    requestTableFillOperationsV2,
    TABLE_FILL_TOOL_RESULT,
} from './tool-call-filler.js';
import {
    assertTableFillRequestEvidence,
    assertTableFillRequestLease,
    captureTableFillRequestLease,
    isTablePersistenceScopeReady,
    isTableFillRequestLeaseError,
} from './infra/persistence-scope.js';
import {
    canAutomaticallyRetryTableFill,
    createDeterministicTableFillError,
    createTableFillRunControl,
    isTableFillBudgetError,
    normalizeTableFillInferenceError,
    resolveTableFillRunControl,
    runTableFillPostCommitEffects,
} from './fill-run-control.js';
import {
    buildCacheStableFlowPrompt,
    createTableFillRandomSeedMessages,
    planTableFillBatches,
} from './table-fill-batching.js';
import { collectTableFillOperationBatches } from './table-fill-batch-runner.js';
import {
    TABLE_FILL_PROCESS_HASH_KEY,
    SECONDARY_FAILURE_LATCH_KEY,
    SECONDARY_RETRY_COUNT_KEY,
    SECONDARY_RETRY_TARGET_KEY,
    getTableFillContentHash,
} from './infra/fill-progress.js';

const CONTINUE_PROMPT_SECONDARY = '上一条回复不完整或缺少 <Amily2Edit> 指令块。请直接从中断处继续生成剩余内容，不要重复已输出的文本，也不要添加任何解释或寒暄，确保最终输出中包含完整的 <Amily2Edit>...</Amily2Edit> 指令块。';

let secondaryFillerDebounceTimer = null;
let secondaryFillerRetryTimer = null;
let secondaryFillerManualRetryTimer = null;
let secondaryFillerRetryGeneration = 0;
let secondaryFillerRunning = false;
let currentAbortController = null;
let secondaryFillerPendingCatchUp = null;
let secondaryFillerCatchUpTimer = null;
let secondaryFillerPendingForceRuns = [];
let secondaryFillerActiveForceRun = null;

const SECONDARY_SCAN_HARD_LIMIT = 200;
const SECONDARY_FORCE_QUEUE_LIMIT = 8;

function assertSecondaryFillContinue(signal) {
    if (!signal?.aborted) return;
    const error = new Error('分步填表已被用户中断。');
    error.name = 'AbortError';
    throw error;
}

function describeSecondaryBatchBudget(error) {
    const snapshot = error?.tableFillBatchBudgetSnapshot || error?.snapshot;
    if (!snapshot) return '';
    return `${snapshot.used ?? '?'} / ${snapshot.limit ?? '?'}`;
}

function getSecondaryFailureLatch(message) {
    const latch = message?.extra?.[SECONDARY_FAILURE_LATCH_KEY];
    if (!latch || typeof latch !== 'object' || Array.isArray(latch)) return null;
    if (!Number.isSafeInteger(latch.contentHash)) return null;
    if (!Number.isSafeInteger(latch.contentLength) || latch.contentLength < 0) return null;
    return latch;
}

function isSecondaryFailureLatched(message, contentHash, forceRun) {
    if (forceRun) return false;
    const latch = getSecondaryFailureLatch(message);
    return latch?.contentHash === contentHash
        && latch.contentLength === String(message?.mes ?? '').length;
}

function createSecondaryFailureLatch(
    contentHash,
    contentLength,
    attempts,
    failedAt = Date.now(),
) {
    return {
        version: 1,
        contentHash,
        contentLength,
        attempts: Math.max(1, Number.parseInt(attempts, 10) || 1),
        failedAt,
    };
}

function getSecondaryRetryTargetKey(targetMessages) {
    return targetMessages
        .map(target => `${target.index}:${String(target.msg?.mes ?? '').length}:${target.hash}`)
        .join('|');
}

function clearSecondaryRetryState(message) {
    if (!message?.extra) return;
    delete message.extra[SECONDARY_RETRY_COUNT_KEY];
    delete message.extra[SECONDARY_RETRY_TARGET_KEY];
}

function captureSecondaryRetryState(message) {
    if (!message) return null;
    return {
        message,
        hadExtra: Boolean(message.extra),
        hadRetryCount: Boolean(message.extra
            && Object.prototype.hasOwnProperty.call(message.extra, SECONDARY_RETRY_COUNT_KEY)),
        retryCount: message.extra?.[SECONDARY_RETRY_COUNT_KEY],
        hadTargetKey: Boolean(message.extra
            && Object.prototype.hasOwnProperty.call(message.extra, SECONDARY_RETRY_TARGET_KEY)),
        targetKey: message.extra?.[SECONDARY_RETRY_TARGET_KEY],
    };
}

function restoreSecondaryRetryState(backup) {
    if (!backup) return;
    const { message } = backup;
    if (backup.hadRetryCount || backup.hadTargetKey) {
        if (!message.extra) message.extra = {};
        if (backup.hadRetryCount) message.extra[SECONDARY_RETRY_COUNT_KEY] = backup.retryCount;
        else delete message.extra[SECONDARY_RETRY_COUNT_KEY];
        if (backup.hadTargetKey) message.extra[SECONDARY_RETRY_TARGET_KEY] = backup.targetKey;
        else delete message.extra[SECONDARY_RETRY_TARGET_KEY];
    } else if (message.extra) {
        clearSecondaryRetryState(message);
        if (!backup.hadExtra && Object.keys(message.extra).length === 0) {
            delete message.extra;
        }
    }
}

function applySecondaryFailureLatch(
    targetMessages,
    attempts,
    retryMessage = null,
    failedAt = Date.now(),
) {
    for (const target of targetMessages) {
        if (!target.msg.extra) target.msg.extra = {};
        target.msg.extra[SECONDARY_FAILURE_LATCH_KEY] = createSecondaryFailureLatch(
            target.hash,
            String(target.msg?.mes ?? '').length,
            attempts,
            failedAt,
        );
    }
    clearSecondaryRetryState(retryMessage);
}

function createSecondaryFillerError(code, message) {
    const error = new Error(message);
    error.code = `SECONDARY_FILLER_${code}`;
    return error;
}

function createRetryableResponseError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.category = 'response';
    error.retryable = true;
    error.deterministic = false;
    return error;
}

function cancelScheduledRetry() {
    if (secondaryFillerRetryTimer) {
        clearTimeout(secondaryFillerRetryTimer);
        secondaryFillerRetryTimer = null;
    }
    secondaryFillerRetryGeneration += 1;
}

function cancelManualRetry() {
    if (secondaryFillerManualRetryTimer) {
        clearTimeout(secondaryFillerManualRetryTimer);
        secondaryFillerManualRetryTimer = null;
    }
}

function clearCatchUpTimer() {
    if (!secondaryFillerCatchUpTimer) return;
    clearTimeout(secondaryFillerCatchUpTimer);
    secondaryFillerCatchUpTimer = null;
}

function clearPendingSecondaryCatchUp() {
    clearCatchUpTimer();
    secondaryFillerPendingCatchUp = null;
}

function clearPendingSecondaryCatchUpForScope(scope) {
    if (!secondaryFillerPendingCatchUp
        || !chatScopesMatch(secondaryFillerPendingCatchUp.scope, scope)) {
        return false;
    }
    clearPendingSecondaryCatchUp();
    return true;
}

function clearPendingSecondaryForceRuns() {
    const pending = secondaryFillerPendingForceRuns;
    secondaryFillerPendingForceRuns = [];
    if (secondaryFillerActiveForceRun) {
        secondaryFillerActiveForceRun.cancelled = true;
    }
    for (const entry of pending) {
        for (const waiter of entry.waiters) {
            try { waiter.resolve(false); } catch {}
        }
    }
}

function queueSecondaryForceRun(latestMessage, opts = {}) {
    const context = getContext();
    const scope = captureChatScope(context);
    if (!scope?.chatId) return Promise.resolve(false);

    return new Promise((resolve, reject) => {
        const targetMessage = opts.targetMessage || null;
        const duplicate = secondaryFillerPendingForceRuns.find(entry => (
            chatScopesMatch(entry.scope, scope)
            && entry.latestMessage === latestMessage
            && entry.targetMessage === targetMessage
        ));
        if (duplicate) {
            duplicate.waiters.push({ resolve, reject });
            return;
        }
        if (secondaryFillerPendingForceRuns.length >= SECONDARY_FORCE_QUEUE_LIMIT) {
            log(
                `分步填表强制请求等待队列已达到 ${SECONDARY_FORCE_QUEUE_LIMIT} 条上限，本次请求未排入队列。`,
                'error',
            );
            resolve(false);
            return;
        }
        secondaryFillerPendingForceRuns.push({
            scope,
            latestMessage,
            targetMessage,
            opts: { ...opts },
            waiters: [{ resolve, reject }],
        });
    });
}

function drainPendingSecondaryForceRuns() {
    if (secondaryFillerRunning
        || secondaryFillerDebounceTimer
        || secondaryFillerRetryTimer
        || secondaryFillerManualRetryTimer) {
        return false;
    }

    while (secondaryFillerPendingForceRuns.length > 0) {
        const entry = secondaryFillerPendingForceRuns.shift();
        const context = getContext();
        const scopeCurrent = chatScopesMatch(entry.scope, captureChatScope(context));
        const latestCurrent = !entry.latestMessage || context.chat?.includes(entry.latestMessage);
        const targetCurrent = !entry.targetMessage || context.chat?.includes(entry.targetMessage);
        if (!scopeCurrent || !latestCurrent || !targetCurrent) {
            for (const waiter of entry.waiters) waiter.resolve(false);
            continue;
        }

        entry.cancelled = false;
        secondaryFillerActiveForceRun = entry;
        void fillWithSecondaryApi(entry.latestMessage, true, {
            ...entry.opts,
            __secondaryExpectedScope: entry.scope,
        }).then(
            result => {
                for (const waiter of entry.waiters) {
                    waiter.resolve(entry.cancelled ? false : (result ?? true));
                }
            },
            error => {
                for (const waiter of entry.waiters) {
                    if (entry.cancelled) waiter.resolve(false);
                    else waiter.reject(error);
                }
            },
        ).finally(() => {
            if (secondaryFillerActiveForceRun === entry) {
                secondaryFillerActiveForceRun = null;
            }
            drainPendingSecondaryForceRuns();
            schedulePendingSecondaryCatchUp();
        });
        return true;
    }
    return false;
}

function queueSecondaryCatchUpForScope(scope, reason = 'automatic-trigger') {
    if (!scope?.chatId) return false;
    const liveContext = getContext();
    if (!chatScopesMatch(scope, captureChatScope(liveContext))) return false;

    if (secondaryFillerPendingCatchUp
        && !chatScopesMatch(secondaryFillerPendingCatchUp.scope, scope)) {
        // A pending task must never cross chats. A CHAT_CHANGED caller normally
        // clears it synchronously; this replacement is a second fail-closed
        // guard for hosts that deliver events in a different listener order.
        clearPendingSecondaryCatchUp();
    }
    secondaryFillerPendingCatchUp = Object.freeze({
        scope,
        reason,
        queuedAt: Date.now(),
    });
    return true;
}

function queueCurrentSecondaryCatchUp(reason = 'automatic-trigger') {
    let context = null;
    try {
        context = getContext();
    } catch {
        return false;
    }
    return queueSecondaryCatchUpForScope(captureChatScope(context), reason);
}

function latestAssistantMessage(context) {
    const chat = context?.chat;
    if (!Array.isArray(chat)) return null;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        if (!chat[index]?.is_user) return chat[index];
    }
    return null;
}

function schedulePendingSecondaryCatchUp() {
    if (!secondaryFillerPendingCatchUp
        || secondaryFillerCatchUpTimer
        || secondaryFillerDebounceTimer
        || secondaryFillerRetryTimer
        || secondaryFillerManualRetryTimer
        || secondaryFillerRunning) {
        return false;
    }

    let context = null;
    try {
        context = getContext();
    } catch {
        return false;
    }
    const pending = secondaryFillerPendingCatchUp;
    if (!chatScopesMatch(pending.scope, captureChatScope(context))) {
        clearPendingSecondaryCatchUp();
        return false;
    }
    // CHAT_CHANGED closes this gate until the exact new chat/store snapshot is
    // published. Keep the pending wake-up intact; lifecycle-ready will call
    // resumeSecondaryFillerCatchUp() and resume it without an unsafe lease.
    if (!isTablePersistenceScopeReady(context)) return false;

    secondaryFillerCatchUpTimer = setTimeout(() => {
        secondaryFillerCatchUpTimer = null;
        const queued = secondaryFillerPendingCatchUp;
        const liveContext = getContext();
        if (!queued
            || !chatScopesMatch(queued.scope, captureChatScope(liveContext))) {
            clearPendingSecondaryCatchUp();
            return;
        }
        if (!isTablePersistenceScopeReady(liveContext)
            || secondaryFillerDebounceTimer
            || secondaryFillerRetryTimer
            || secondaryFillerManualRetryTimer
            || secondaryFillerRunning) {
            return;
        }

        const latestMessage = latestAssistantMessage(liveContext);
        secondaryFillerPendingCatchUp = null;
        if (!latestMessage) return;
        invokeSecondaryFillAndResume(latestMessage, false, {
            __secondaryDebounced: true,
            __secondaryExpectedScope: queued.scope,
            __secondaryCatchUp: true,
        });
    }, 0);
    return true;
}

function invokeSecondaryFillAndResume(latestMessage, forceRun, opts) {
    void fillWithSecondaryApi(latestMessage, forceRun, opts)
        .catch(error => {
            console.error('[Amily2-副API] 延迟填表任务异常结束:', error);
        })
        .finally(() => {
            // fillWithSecondaryApi normally drains from its locked finally.
            // Delayed invocations can also return before acquiring that lock
            // (for example, when their exact retry message was deleted).
            drainPendingSecondaryForceRuns();
            schedulePendingSecondaryCatchUp();
        });
}

function scheduleManualSecondaryRetry(callback, delay = 300) {
    cancelManualRetry();
    const runWhenIdle = () => {
        if (secondaryFillerRunning || secondaryFillerRetryTimer) {
            // A review modal may remain open while a newer automatic fill is
            // running or waiting for its own retry. Keep the user's explicit
            // retry pending instead of cancelling the newer floor's retry.
            secondaryFillerManualRetryTimer = setTimeout(runWhenIdle, delay);
            return;
        }
        secondaryFillerManualRetryTimer = null;
        callback();
    };
    secondaryFillerManualRetryTimer = setTimeout(runWhenIdle, delay);
}

function snapshotSecondaryRetryTargets(targetMessages) {
    return Object.freeze(targetMessages.map(target => Object.freeze({
        index: target.index,
        msg: target.msg,
        hash: target.hash,
        contentLength: String(target.msg?.mes ?? '').length,
    })));
}

function resolveSecondaryRetryTargets(snapshot, chat) {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return null;
    const targets = [];
    for (const target of snapshot) {
        if (!Number.isSafeInteger(target?.index)
            || chat?.[target.index] !== target.msg
            || String(target.msg?.mes ?? '').length !== target.contentLength
            || getTableFillContentHash(target.msg?.mes) !== target.hash) {
            return null;
        }
        // A different fill path may durably complete only part of this failed
        // batch while its automatic retry sleeps. Never replay completed
        // floors, but retain the still-unprocessed members of the exact pinned
        // retry snapshot.
        if (target.msg?.extra?.[TABLE_FILL_PROCESS_HASH_KEY] === target.hash) {
            continue;
        }
        targets.push({
            index: target.index,
            msg: target.msg,
            hash: target.hash,
        });
    }
    return targets;
}

function nextSecondaryInvocationOptions(opts = {}, internal = {}) {
    const {
        __secondaryRetryGeneration,
        __secondaryDebounced,
        __secondaryExpectedScope,
        __secondaryCatchUp,
        __secondaryRetryTargets,
        ...publicOptions
    } = opts;
    return {
        ...publicOptions,
        ...internal,
    };
}

function assertSecondaryFillerScope(expectedScope, targetMessages = []) {
    const liveContext = getContext();
    if (
        !chatScopesMatch(expectedScope, captureChatScope(liveContext))
        || targetMessages.some(target => !liveContext.chat?.includes(target.msg))
    ) {
        throw createSecondaryFillerError('STALE_CHAT_CONTEXT', '聊天已切换，本次分步填表结果已丢弃。');
    }
}

function refreshSecondaryUiAfterCommit() {
    try {
        renderTables();
    } catch (error) {
        console.error('[Amily2-副API] 表格已经保存，但表格界面刷新失败:', error);
    }
    try {
        updateOrInsertTableInChat();
    } catch (error) {
        console.error('[Amily2-副API] 表格已经保存，但消息内表格刷新失败:', error);
    }
}

async function callSecondaryModel(messages, signal, requestBudget) {
    const settings = extension_settings[extensionName] || {};
    if (settings.nccsEnabled) {
        requestBudget?.assertAvailable();
        requestBudget?.consume('text-fallback');
        return await callNccsAI(messages, {
            signal,
            throwOnError: true,
        });
    }
    return await callAI(messages, {
        slot: 'tableFilling',
        signal,
        requestBudget,
        requestKind: 'text-fallback',
        throwOnError: true,
    });
}
async function requestSecondaryContinuation(
    baseMessages,
    partialResponse,
    requestLease,
    signal,
    requestBudget,
) {
    assertTableFillRequestLease(requestLease, getContext());
    const continueMessages = [
        ...baseMessages,
        { role: 'assistant', content: partialResponse || '' },
        { role: 'user', content: CONTINUE_PROMPT_SECONDARY },
    ];
    const continued = await callSecondaryModel(continueMessages, signal, requestBudget);
    assertTableFillRequestLease(requestLease, getContext());
    if (typeof continued !== 'string' || !continued.trim()) return null;
    return `${partialResponse || ''}${continued}`;
}

async function markTargetsProcessed(
    targetMessages,
    {
        state = getMemoryState(),
        expectedScope = null,
        retryMessage = null,
        requestLease = null,
    } = {},
) {
    if (requestLease) {
        assertTableFillRequestEvidence(
            requestLease,
            getContext(),
            undefined,
            targetMessages,
        );
    }
    if (!targetMessages || targetMessages.length === 0) return false;
    const persistedState = state ?? getMemoryState();

    const lastProcessedMsg = targetMessages[targetMessages.length - 1].msg;
    const hashBackups = targetMessages.map(target => ({
        message: target.msg,
        hadExtra: Boolean(target.msg.extra),
        hadHash: Boolean(target.msg.extra
            && Object.prototype.hasOwnProperty.call(target.msg.extra, TABLE_FILL_PROCESS_HASH_KEY)),
        hash: target.msg.extra?.[TABLE_FILL_PROCESS_HASH_KEY],
        hadFailureLatch: Boolean(target.msg.extra
            && Object.prototype.hasOwnProperty.call(target.msg.extra, SECONDARY_FAILURE_LATCH_KEY)),
        failureLatch: target.msg.extra?.[SECONDARY_FAILURE_LATCH_KEY],
    }));
    const retryBackup = captureSecondaryRetryState(retryMessage);

    const restoreHashes = () => {
        hashBackups.forEach(backup => {
            if (!backup.message.extra) return;
            if (backup.hadHash) backup.message.extra[TABLE_FILL_PROCESS_HASH_KEY] = backup.hash;
            else delete backup.message.extra[TABLE_FILL_PROCESS_HASH_KEY];
            if (backup.hadFailureLatch) {
                backup.message.extra[SECONDARY_FAILURE_LATCH_KEY] = backup.failureLatch;
            } else {
                delete backup.message.extra[SECONDARY_FAILURE_LATCH_KEY];
            }
            if (!backup.hadExtra && Object.keys(backup.message.extra).length === 0) {
                delete backup.message.extra;
            }
        });
        restoreSecondaryRetryState(retryBackup);
    };

    const applyHashes = () => {
        for (const target of targetMessages) {
            if (!target.msg.extra) target.msg.extra = {};
            target.msg.extra[TABLE_FILL_PROCESS_HASH_KEY] = target.hash;
            delete target.msg.extra[SECONDARY_FAILURE_LATCH_KEY];
        }
        clearSecondaryRetryState(retryMessage);
    };

    const transaction = {
        beforeSave: applyHashes,
        rollback: restoreHashes,
    };
    if (expectedScope?.chatId) {
        transaction.expectedChatId = expectedScope.chatId;
        transaction.expectedChatScope = expectedScope;
    }

    const committed = await commitToMessageAsync(
        persistedState,
        lastProcessedMsg,
        undefined,
        transaction,
    );
    if (!committed) {
        throw new Error('无法原子保存分步填表状态与目标楼层标记。');
    }
    return true;
}

async function markTargetsFailed(
    targetMessages,
    {
        state = getMemoryState(),
        expectedScope = null,
        retryMessage = null,
        attempts = 1,
    } = {},
) {
    if (!targetMessages || targetMessages.length === 0) return false;

    // 失败锁会写到实际目标楼层，但表格快照应由最新消息承载，避免给旧失败楼层
    // 伪造一份“已经在该楼层完成填表”的历史快照。
    const persistenceMessage = retryMessage || targetMessages[targetMessages.length - 1].msg;
    const failedAt = Date.now();
    const latchBackups = targetMessages.map(target => ({
        message: target.msg,
        hadExtra: Boolean(target.msg.extra),
        hadLatch: Boolean(target.msg.extra
            && Object.prototype.hasOwnProperty.call(target.msg.extra, SECONDARY_FAILURE_LATCH_KEY)),
        latch: target.msg.extra?.[SECONDARY_FAILURE_LATCH_KEY],
    }));
    const retryBackup = captureSecondaryRetryState(retryMessage);

    const rollback = () => {
        for (const backup of latchBackups) {
            if (backup.hadLatch) {
                if (!backup.message.extra) backup.message.extra = {};
                backup.message.extra[SECONDARY_FAILURE_LATCH_KEY] = backup.latch;
            } else if (backup.message.extra) {
                delete backup.message.extra[SECONDARY_FAILURE_LATCH_KEY];
                if (!backup.hadExtra && Object.keys(backup.message.extra).length === 0) {
                    delete backup.message.extra;
                }
            }
        }
        restoreSecondaryRetryState(retryBackup);
    };

    const transaction = {
        beforeSave: () => applySecondaryFailureLatch(
            targetMessages,
            attempts,
            retryMessage,
            failedAt,
        ),
        rollback,
    };
    if (expectedScope?.chatId) {
        transaction.expectedChatId = expectedScope.chatId;
        transaction.expectedChatScope = expectedScope;
    }

    const committed = await commitToMessageAsync(state, persistenceMessage, undefined, transaction);
    if (!committed) {
        throw new Error('无法保存分步填表失败锁。');
    }
    return true;
}

async function pauseTargetsForManualReview(
    targetMessages,
    {
        expectedScope,
        retryMessage = null,
        attempts = 1,
    } = {},
) {
    try {
        assertSecondaryFillerScope(expectedScope, targetMessages);
        await markTargetsFailed(targetMessages, {
            expectedScope,
            retryMessage,
            attempts,
        });
        return true;
    } catch (latchError) {
        if (latchError?.code === 'SECONDARY_FILLER_STALE_CHAT_CONTEXT'
            || latchError?.code === 'TABLE_SYSTEM_STALE_CHAT_CONTEXT'
            || latchError?.code === 'TABLE_SYSTEM_NO_ACTIVE_CHAT') {
            throw latchError;
        }
        console.error(
            '[Amily2-副API] 人工检查楼层的暂停标记持久化失败，将保留本次会话内暂停标记:',
            latchError,
        );
        assertSecondaryFillerScope(expectedScope, targetMessages);
        applySecondaryFailureLatch(targetMessages, attempts, retryMessage);
        return false;
    }
}

async function commitSecondaryFillResult(
    rawContent,
    targetMessages,
    sourceMessages,
    requestLease,
    runControl,
    { expectedScope = null, retryMessage = null } = {},
) {
    // 候选状态与处理 hash 在同一补偿事务里存到 lastProcessedMsg(E)，成功后才发布 store。
    const applied = await updateTableFromText(rawContent, {
        strictTextResponse: true,
        persistCandidate: state => markTargetsProcessed(targetMessages, {
            state,
            expectedScope,
            retryMessage,
            requestLease,
        }),
        sourceMessages,
        targetMessages,
        requestLease,
        onCommitted: () => runControl.markCommitted(),
    });
    if (!applied) {
        throw createDeterministicTableFillError(
            'TABLE_FILL_WRITE_REJECTED',
            '分步填表结果未通过校验，未标记目标楼层为已处理。',
        );
    }
    runControl.markCommitted();
    runTableFillPostCommitEffects('secondary-filler', [
        { label: 'render-tables', run: () => renderTables() },
        { label: 'update-chat-table-view', run: () => updateOrInsertTableInChat() },
    ]);
}


async function getWorldBookContext() {
    const settings = extension_settings[extensionName] || {};

    if (!settings.table_worldbook_enabled) {
        return '';
    }

    const selectedEntriesByBook = settings.table_selected_entries || {};
    const booksToInclude = Object.keys(selectedEntriesByBook);
    const selectedEntryUids = new Set(Object.values(selectedEntriesByBook).flat());

    if (booksToInclude.length === 0 || selectedEntryUids.size === 0) {
        return '';
    }

    let allEntries = [];
    for (const bookName of booksToInclude) {
        try {
            const entries = await safeLorebookEntries(bookName);
            if (entries?.length) {
                entries.forEach(entry => allEntries.push({ ...entry, bookName }));
            }
        } catch (error) {
            console.error(`[Amily2-副API] Error loading entries for world book: ${bookName}`, error);
        }
    }

    const userEnabledEntries = allEntries.filter(entry => {
        return entry && selectedEntryUids.has(String(entry.uid));
    });

    if (userEnabledEntries.length === 0) {
        return '';
    }

    let content = userEnabledEntries.map(entry => 
        `[来源：世界书，条目名字：${entry.comment || '无标题条目'}]\n${entry.content}`
    ).join('\n\n');
    
    const maxChars = settings.table_worldbook_char_limit || 30000;
    if (content.length > maxChars) {
        content = content.substring(0, maxChars);
        const lastNewline = content.lastIndexOf('\n');
        if (lastNewline !== -1) {
            content = content.substring(0, lastNewline);
        }
        content += '\n[...内容已截断]';
    }

    return content.trim() ? `<世界书>\n${content.trim()}\n</世界书>` : '';
}

export async function fillWithSecondaryApi(latestMessage, forceRun = false, opts = {}) {
    const retryGeneration = opts.__secondaryRetryGeneration;
    const isScheduledRetry = Number.isSafeInteger(retryGeneration);
    const isDebouncedRun = opts.__secondaryDebounced === true;
    const isCatchUpRun = opts.__secondaryCatchUp === true;
    const expectedInvocationScope = opts.__secondaryExpectedScope;
    if (isScheduledRetry && retryGeneration !== secondaryFillerRetryGeneration) {
        log('忽略已失效的分步填表重试任务。', 'info');
        return;
    }
    if (expectedInvocationScope) {
        const liveContext = getContext();
        if (!chatScopesMatch(expectedInvocationScope, captureChatScope(liveContext))
            || (
                latestMessage
                && !opts.__secondaryRetryTargets
                && !liveContext.chat?.includes(latestMessage)
            )) {
            log('分步填表延迟任务所属聊天已经切换，已取消旧任务。', 'info');
            return;
        }
    }
    if (secondaryFillerManualRetryTimer && !isScheduledRetry) {
        if (forceRun) {
            cancelManualRetry();
        } else {
            queueCurrentSecondaryCatchUp('manual-retry-wait');
            log('分步填表正在等待用户请求的重新填表；新的自动触发已合并到待补扫任务。', 'info');
            return;
        }
    }
    if (secondaryFillerRetryTimer && !isScheduledRetry) {
        if (forceRun) {
            cancelScheduledRetry();
        } else {
            queueCurrentSecondaryCatchUp('automatic-retry-wait');
            log('分步填表正在等待同一任务重试；新的自动触发已合并到待补扫任务。', 'info');
            return;
        }
    }
    if (secondaryFillerRunning) {
        if (forceRun) {
            log('分步填表正在进行中，本次强制请求已排队等待当前任务释放。', 'warn');
            return await queueSecondaryForceRun(latestMessage, opts);
        }
        queueCurrentSecondaryCatchUp('running');
        log(
            '分步填表正在进行中；新的自动触发已合并到待补扫任务。',
            'warn',
        );
        return;
    }
    const settings = extension_settings[extensionName] || {};
    const runControl = resolveTableFillRunControl(opts.runControl, {
        scope: 'secondary-filler-target',
    });
    opts = { ...opts, runControl };

    // 【V2.1.1】分步填表触发延迟 / 防抖：自动触发时若配置了延迟，则延后执行，
    // 延迟期内再次到来的事件会重置计时器，避免消息连续到达时重复拉起填表。
    // 注意：防抖与早返路径都不持锁，避免 setTimeout 回调撞上自己的锁导致死锁。
    const delay = Math.max(0, parseInt(settings.secondary_filler_delay || 0, 10));
    if (!forceRun && !isScheduledRetry && !isDebouncedRun && delay > 0) {
        const debounceScope = captureChatScope(getContext());
        queueSecondaryCatchUpForScope(debounceScope, 'debounce');
        if (secondaryFillerDebounceTimer) {
            clearTimeout(secondaryFillerDebounceTimer);
        }
        secondaryFillerDebounceTimer = setTimeout(() => {
            secondaryFillerDebounceTimer = null;
            schedulePendingSecondaryCatchUp();
        }, delay);
        console.log(`[Amily2-副API] 分步填表已按防抖延迟 ${delay}ms 调度。`);
        return;
    }
    if (secondaryFillerDebounceTimer) {
        clearTimeout(secondaryFillerDebounceTimer);
        secondaryFillerDebounceTimer = null;
    }

    clearHighlights();

    // 总开关关闭时，分步填表同样禁用
    if (settings.table_system_enabled === false) {
        log('【分步填表】表格系统总开关已关闭，跳过。', 'info');
        return;
    }

    const context = getContext();
    if (context.chat.length <= 1) {
        console.log("[Amily2-副API] 聊天刚开始，跳过本次自动填表。");
        return;
    }

    const fillingMode = settings.filling_mode || 'main-api';
    if (fillingMode !== 'secondary-api' && !forceRun) {
        log('当前非分步填表模式，且未强制执行，跳过。', 'info');
        return;
    }

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }
    const requestScope = captureChatScope(context);
    if (!requestScope.chatId) {
        log('当前聊天缺少稳定标识，已取消分步填表以避免跨聊天写入。', 'error');
        return;
    }
    if (!isTablePersistenceScopeReady(context)) {
        if (!forceRun) {
            queueSecondaryCatchUpForScope(requestScope, 'table-lifecycle-not-ready');
            log('表格生命周期尚未就绪，本次自动填表已保留为待补扫任务。', 'info');
        } else {
            log('表格生命周期尚未就绪，本次强制填表未执行。', 'warn');
        }
        return;
    }
    // 所有早返检查通过后再获取锁，确保 finally 一定能解锁
    secondaryFillerRunning = true;
    const runAbortController = new AbortController();
    currentAbortController = runAbortController;
    const cancelRunScheduledRetry = () => {
        if (currentAbortController !== runAbortController) return false;
        cancelScheduledRetry();
        return true;
    };
    const signal = runAbortController.signal;
    let fillResolved = false;
    let targetMessages = [];
    try {
        assertSecondaryFillerScope(requestScope);
        // Bind the entire prompt (target message objects + table snapshot) to
        // one chat/store lease before any asynchronous prompt preparation.
        const fillLease = captureTableFillRequestLease(context);
        const tableBatches = planTableFillBatches(
            fillLease.state,
            settings.table_fill_tables_per_request,
        );
        const splitTablesAcrossRequests = tableBatches.length > 1;
        const bufferSize = parseInt(settings.secondary_filler_buffer || 0, 10);
        const batchSize = parseInt(settings.secondary_filler_batch || 0, 10);
        const contextLimit = parseInt(settings.secondary_filler_context || 2, 10);

        const chat = context.chat;
        const totalMessages = chat.length;

        // Automatic retries are bound to the exact original message objects,
        // indexes and content fingerprints. New messages that arrive during
        // the retry delay are handled by the pending catch-up scan afterwards.
        if (opts.__secondaryRetryTargets) {
            const fixedTargets = resolveSecondaryRetryTargets(
                opts.__secondaryRetryTargets,
                chat,
            );
            if (!fixedTargets || fixedTargets.length === 0) {
                clearSecondaryRetryState(latestMessage);
                queueSecondaryCatchUpForScope(requestScope, 'retry-target-changed');
                log('分步填表原重试目标已变化，已取消旧重试并保留一次当前聊天补扫。', 'warn');
                return;
            }
            targetMessages = fixedTargets;
            if (!chat.includes(latestMessage)) {
                // The retry metadata carrier is not part of the semantic
                // target set and may have been deleted independently. Keep the
                // still-valid pinned targets retryable, and persist any
                // bookkeeping on the last surviving target instead.
                latestMessage = fixedTargets[fixedTargets.length - 1].msg;
            }
        // 【SWIPED 旁路】swipe 后强制处理刚切出来的最新消息：
        // 跳过扫描 / bufferSize / batchSize 累积逻辑，直接锁定目标
        } else if (opts.targetMessage) {
            const targetIndex = chat.indexOf(opts.targetMessage);
            if (targetIndex < 0) {
                console.log("[Amily2-副API] 旁路目标消息不在聊天列表中，跳过。");
                return;
            }
            if (opts.targetMessage.is_user) {
                console.log("[Amily2-副API] 旁路目标是用户消息，跳过。");
                return;
            }
            const targetHash = getTableFillContentHash(opts.targetMessage.mes);
            if (isSecondaryFailureLatched(opts.targetMessage, targetHash, forceRun)) {
                log('目标楼层的内容未变化，且自动重试已达到上限；跳过本次自动触发。', 'info');
                return;
            }
            targetMessages.push({
                index: targetIndex,
                msg: opts.targetMessage,
                hash: targetHash,
            });
        } else {
            // 常规扫描路径
            const validEndIndex = totalMessages - 1 - bufferSize;

            if (validEndIndex < 0) {
                console.log(`[Amily2-副API] 消息数量不足以超出保留区(${bufferSize})，跳过。`);
                return;
            }

            // The old window was only context + batch + 10 raw chat messages.
            // With alternating user/assistant turns, context=2 + batch=20
            // could expose fewer than twenty AI candidates and starve forever.
            // Use a wider fixed recent-history window, but retain the previous
            // oldest-first behavior inside that safety boundary so a backlog
            // cannot be perpetually displaced by newly arriving messages.
            // Realtime single-floor triggers retain the historical behavior:
            // inspect the whole bounded window and fill the newest eligible
            // floor. Otherwise an old backlog would keep the default mode
            // permanently N turns behind. A coalesced catch-up run is the
            // explicit backlog-drain path, so it consumes one oldest eligible
            // floor per pass and requeues itself below.
            const requiredCandidateCount = batchSize > 0
                ? batchSize
                : ((isCatchUpRun || forceRun) ? 1 : null);
            const scanStartIndex = Math.max(
                0,
                validEndIndex - SECONDARY_SCAN_HARD_LIMIT + 1,
            );
            let skippedLatchedMessages = 0;
            for (let i = scanStartIndex; i <= validEndIndex; i += 1) {
                const msg = chat[i];

                if (msg.is_user) continue;

                const currentHash = getTableFillContentHash(msg.mes);
                const savedHash = msg.extra?.[TABLE_FILL_PROCESS_HASH_KEY];

                const hasSavedHash = Number.isSafeInteger(savedHash);
                const isUnprocessed = !hasSavedHash;
                const isChanged = hasSavedHash && savedHash !== currentHash;

                if (isUnprocessed || isChanged) {
                    if (isSecondaryFailureLatched(msg, currentHash, forceRun)) {
                        skippedLatchedMessages += 1;
                        continue;
                    }
                    targetMessages.push({ index: i, msg: msg, hash: currentHash });
                    if (requiredCandidateCount !== null
                        && targetMessages.length >= requiredCandidateCount) {
                        break;
                    }
                }
            }
            if (skippedLatchedMessages > 0) {
                console.log(
                    `[Amily2-副API] 已跳过 ${skippedLatchedMessages} 个内容未变化的失败锁楼层，`
                    + '继续扫描后续可处理楼层。',
                );
            }

            if (targetMessages.length === 0) {
                console.log("[Amily2-副API] 没有发现需要处理的消息。");
                return;
            }

            if (batchSize > 0) {
                if (targetMessages.length < batchSize) {
                    console.log(
                        `[Amily2-副API] 批量模式: 在最近 ${SECONDARY_SCAN_HARD_LIMIT} 条消息的硬上限内`
                        + `累积 ${targetMessages.length}/${batchSize} 条可处理 AI 消息，暂不触发。`,
                    );
                    return;
                }
            } else {
                targetMessages = [targetMessages[targetMessages.length - 1]];
            }
        }

        if (isCatchUpRun) {
            // A coalesced wake-up can represent several message events. Keep
            // one scope-bound continuation pending before consuming this
            // candidate/batch, so completion, retry or a persisted failure
            // latch will continue draining until no eligible work remains.
            queueSecondaryCatchUpForScope(requestScope, 'catch-up-drain');
        }

        console.log(`[Amily2-副API] 触发填表: 处理 ${targetMessages.length} 条消息。索引范围: ${targetMessages[0].index} - ${targetMessages[targetMessages.length-1].index}`);
        toastr.info(`分步填表正在执行，正在填写 ${targetMessages[0].index + 1} 楼至 ${targetMessages[targetMessages.length-1].index + 1} 楼的内容`, "Amily2-分步填表");

        let tagsToExtract = [];
        let exclusionRules = [];
        let excludeUserMessages = false;
        const tableRuleConfig = resolveTableRuleConfig(settings);
        if (
            (tableRuleConfig.tagExtractionEnabled && tableRuleConfig.tags)
            || (tableRuleConfig.exclusionRules && tableRuleConfig.exclusionRules.length)
            || tableRuleConfig.excludeUserMessages
        ) {
            tagsToExtract = tableRuleConfig.tagExtractionEnabled
                ? (tableRuleConfig.tags || '').split(',').map(t => t.trim()).filter(Boolean)
                : [];
            exclusionRules = tableRuleConfig.exclusionRules || [];
            excludeUserMessages = Boolean(tableRuleConfig.excludeUserMessages);
        }

        let coreContentText = "";
        const userName = context.name1 || '用户';
        const characterName = context.name2 || '角色';

        for (const target of targetMessages) {
            let textToProcess = String(target.msg.mes ?? '');
            
            if (tagsToExtract.length > 0) {
                const blocks = extractBlocksByTags(textToProcess, tagsToExtract);
                textToProcess = blocks.join('\n\n');
            }
            textToProcess = applyExclusionRules(textToProcess, exclusionRules);
            
            if (!textToProcess.trim()) continue;

            coreContentText += `\n【第 ${target.index + 1} 楼】${characterName}（AI）消息：\n${textToProcess}\n`;
        }

        if (!coreContentText.trim()) {
            console.log("[Amily2-副API] 目标内容处理后为空，记录为已处理并继续扫描后续楼层。");
            await markTargetsProcessed(targetMessages, {
                expectedScope: requestScope,
                retryMessage: latestMessage,
                requestLease: fillLease,
            });
            fillResolved = true;
            runControl.markCommitted();
            queueSecondaryCatchUpForScope(requestScope, 'filtered-empty-target');
            return;
        }

        const historyEndIndex = targetMessages[0].index - 1;
        
        let historyContextStr = "";
        if (contextLimit > 0 && historyEndIndex >= 0) {
            historyContextStr = await getHistoryContext(
                contextLimit,
                historyEndIndex,
                tagsToExtract,
                exclusionRules,
                excludeUserMessages,
            ) || "";
        }

        const currentInteractionContent = (historyContextStr ? `${historyContextStr}\n\n` : '') + 
                                          `<核心填表内容>\n${coreContentText}\n</核心填表内容>`;

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[副API填表] 加载混合顺序失败:", e);
        }

        const completedOrder = completeFillerPromptOrder(
            getMixedOrder('secondary_filler'),
            SECONDARY_REQUIRED_FILLER_BLOCKS,
        );
        const order = completedOrder.order;
        if (completedOrder.added.length > 0) {
            log(
                `分步填表提示链缺少必要块，已仅为本次请求补齐：${completedOrder.added.join(', ')}`,
                'warn',
            );
        }
        const presetPrompts = await getPresetPrompts('secondary_filler');
        
        const seedMessages = createTableFillRandomSeedMessages(
            settings,
            () => runControl.getOrCreateStableSeed(generateRandomSeed),
        );
        const messages = [...seedMessages];

        const worldBookContext = await getWorldBookContext();

        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        if (!ruleTemplate || !flowTemplate) {
            throw createSecondaryFillerError(
                'CONFIGURATION',
                '分步填表的规则提示词或流程提示词为空，请先恢复/配置填表模板。',
            );
        }
        const currentTableDataString = convertAiFillableTablesToCsvString();
        const finalFlowPrompt = splitTablesAcrossRequests
            ? buildCacheStableFlowPrompt(flowTemplate)
            : buildFillerFlowPrompt(flowTemplate, currentTableDataString);

        let promptCounter = 0; 
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++; 
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'worldbook':
                        if (worldBookContext) {
                            messages.push({ role: "system", content: worldBookContext });
                        }
                        break;
                    case 'contextHistory':
                        if (historyContextStr) {
                             messages.push({ role: "system", content: historyContextStr });
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"核心填表内容"进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<核心填表内容>\n${coreContentText}\n</核心填表内容>` });
                        break;
                }
            }
        }

        // 代码级安全边界必须独立于用户可编辑预设存在，并放在混合预设之后，
        // 防止旧预设中的“每轮必填/未知必补全”覆盖当前数据库事实边界。
        messages.push({ role: 'system', content: TABLE_FILL_SAFETY_POLICY });

        const tableBatchResult = splitTablesAcrossRequests
            ? await collectTableFillOperationBatches({
                tableState: fillLease.state,
                tableBatches,
                stableMessages: messages,
                settings,
                slot: 'tableFilling',
                signal,
                runControl,
                scope: 'secondary-filler',
                assertContinue: () => assertSecondaryFillContinue(signal),
                assertLease: () => {
                    assertSecondaryFillerScope(requestScope, targetMessages);
                    assertTableFillRequestLease(fillLease, getContext());
                },
                callText: async (batchMessages, requestBudget, batchMeta) => {
                    if (batchMeta.fallbackReason) {
                        log(
                            `表格子批 ${batchMeta.batchIndex + 1}/${batchMeta.batchCount} `
                            + `的 Tool Call V2 不可用（${batchMeta.fallbackReason}），改用严格文本指令。`,
                            'warn',
                        );
                    }
                    return await callSecondaryModel(
                        batchMessages,
                        batchMeta.signal,
                        requestBudget,
                    );
                },
            })
            : null;
        if (tableBatchResult) {
            assertSecondaryFillContinue(signal);
            assertSecondaryFillerScope(requestScope, targetMessages);
            assertTableFillRequestLease(fillLease, getContext());
            if (tableBatchResult.operationCount === 0) {
                await markTargetsProcessed(targetMessages, {
                    expectedScope: requestScope,
                    retryMessage: latestMessage,
                    requestLease: fillLease,
                });
                runControl.markCommitted();
            } else {
                const applied = await updateTableFromOperationBatches(
                    tableBatchResult.operationBatches,
                    {
                        persistCandidate: state => markTargetsProcessed(targetMessages, {
                            state,
                            expectedScope: requestScope,
                            retryMessage: latestMessage,
                            requestLease: fillLease,
                        }),
                        sourceMessages: context.chat,
                        targetMessages,
                        requestLease: fillLease,
                        onCommitted: () => runControl.markCommitted(),
                    },
                );
                if (!applied) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        '按表拆批结果未通过整轮校验，目标楼层未标记为已处理。',
                    );
                }
                runControl.markCommitted();
            }
            fillResolved = true;
            cancelRunScheduledRetry();
            runTableFillPostCommitEffects('secondary-filler-table-batches', [
                { label: 'render-tables', run: () => renderTables() },
                { label: 'update-chat-table-view', run: () => updateOrInsertTableInChat() },
                {
                    label: 'notify-complete',
                    run: () => toastr.success(
                        `分步填表已按 ${tableBatchResult.tableBatches.length} 个表格子批原子完成。`,
                        'Amily2-分步填表',
                    ),
                },
            ]);
            return;
        }

        console.groupCollapsed(`[Amily2 分步填表] 即将发送至 API 的内容`);
        console.log("发送给AI的提示词: ", JSON.stringify(messages, null, 2));
        console.dir(messages);
        console.groupEnd();

        assertSecondaryFillerScope(requestScope, targetMessages);
        assertTableFillRequestLease(fillLease, getContext());
        const toolLease = settings.tableFillFunctionCall ? fillLease : null;
        const toolResult = settings.tableFillFunctionCall
            ? await requestTableFillOperationsV2(messages, {
                tableState: toolLease.state,
                settings,
                slot: 'tableFilling',
                signal,
                requestBudget: runControl.requestBudget,
                assertLease: () => assertTableFillRequestLease(toolLease, getContext()),
            })
            : null;

        if (toolResult?.mode === TABLE_FILL_TOOL_RESULT.TOOL) {
            const ops = toolResult.operations;
            if (ops.length === 0) {
                assertSecondaryFillerScope(requestScope, targetMessages);
                assertTableFillRequestLease(toolLease, getContext());
                console.info('[Amily2-副API] Tool Call V2 判断本范围没有可靠的新事实。');
                await markTargetsProcessed(targetMessages, {
                    expectedScope: requestScope,
                    retryMessage: latestMessage,
                    requestLease: toolLease,
                });
                fillResolved = true;
                runControl.markCommitted();
                runTableFillPostCommitEffects('secondary-filler-noop', [
                    {
                        label: 'notify-noop',
                        run: () => toastr.info('AI 判断此范围无需修改。', 'Amily2-分步填表'),
                    },
                ]);
            } else {
                const applied = await updateTableFromOps(ops, {
                    persistCandidate: state => markTargetsProcessed(targetMessages, {
                        state,
                        expectedScope: requestScope,
                        retryMessage: latestMessage,
                        requestLease: toolLease,
                    }),
                    sourceMessages: context.chat,
                    targetMessages,
                    requestLease: toolLease,
                    onCommitted: () => runControl.markCommitted(),
                });
                if (!applied) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        'Tool Call V2 填表结果未通过校验，未标记目标楼层为已处理。',
                    );
                }
                runControl.markCommitted();
                runTableFillPostCommitEffects('secondary-filler-tool', [
                    { label: 'render-tables', run: () => renderTables() },
                    { label: 'update-chat-table-view', run: () => updateOrInsertTableInChat() },
                    {
                        label: 'notify-success',
                        run: () => toastr.success(
                            '分步填表（Tool Call V2）执行完毕。',
                            'Amily2-分步填表',
                        ),
                    },
                ]);
                fillResolved = true;
            }
        } else {
            // Tool 不可用时只在用户允许的情况下进入严格文本回退；
            // Tool 返回了畸形/歧义批次则会在上方直接抛错，不会二次猜测。
            if (toolResult?.reason && toolResult.reason !== 'tool-disabled') {
                log(`Tool Call V2 不可用（${toolResult.reason}），改用严格文本指令。`, 'warn');
                toastr.warning('Tool Call V2 当前不可用，已改用严格文本填表。', 'Amily2-分步填表');
            }
            const textLease = fillLease;
            assertTableFillRequestLease(textLease, getContext());
            console.log(settings.nccsEnabled
                ? '[Amily2-副API] 使用 Nccs API 进行分步填表...'
                : '[Amily2-副API] 使用 tableFilling slot 进行分步填表...');
            const rawContent = await callSecondaryModel(
                messages,
                signal,
                runControl.requestBudget,
            );
            assertTableFillRequestLease(textLease, getContext());

            assertSecondaryFillerScope(requestScope, targetMessages);
            if (typeof rawContent !== 'string' || !rawContent.trim()) {
                throw createRetryableResponseError(
                    'TABLE_FILL_EMPTY_RESPONSE',
                    '自动分步填表 API 返回内容为空。',
                );
            }

            console.log('[Amily2号-副API-原始回复]:', rawContent);

            if (!rawContent.includes('<Amily2Edit>')) {
                const rangeLabel = `${targetMessages[0].index + 1} - ${targetMessages[targetMessages.length - 1].index + 1}`;
                console.warn(`[Amily2-副API] 响应未包含 <Amily2Edit> 指令块（楼层 ${rangeLabel}），弹出检查窗口等待用户处理。`);
                toastr.warning(`分步填表（楼层 ${rangeLabel}）的响应缺少 <Amily2Edit> 指令块，请在弹窗中处理。`, 'Amily2-分步填表');
                const reviewRetryTargetKey = getSecondaryRetryTargetKey(targetMessages);
                const savedReviewRetryTargetKey = latestMessage?.extra?.[SECONDARY_RETRY_TARGET_KEY];
                const reviewRetryCount = savedReviewRetryTargetKey === reviewRetryTargetKey
                    ? Math.max(
                        0,
                        parseInt(
                            latestMessage?.extra?.[SECONDARY_RETRY_COUNT_KEY] || 0,
                            10,
                        ) || 0,
                    )
                    : 0;
                const reviewLatchPersisted = await pauseTargetsForManualReview(
                    targetMessages,
                    {
                        expectedScope: requestScope,
                        retryMessage: latestMessage,
                        attempts: reviewRetryCount + 1,
                    },
                );
                if (!reviewLatchPersisted) {
                    toastr.warning(
                        '人工检查楼层已在本次会话中暂停，但暂停标记暂未写入聊天存档；重新载入后可能再次触发。',
                        'Amily2-分步填表',
                    );
                }
                queueSecondaryCatchUpForScope(requestScope, 'manual-review-latch');
                showTableFillReviewModal(rawContent, {
                    title: `分步填表响应检查 - 楼层 ${rangeLabel}`,
                    subtitle: `分步填表（楼层 ${rangeLabel}）的 AI 响应未包含有效的 <Amily2Edit> 指令块。请检查原始响应并选择处理方式。`,
                    onContinue: async (currentText) => {
                        try {
                            assertSecondaryFillerScope(requestScope, targetMessages);
                        } catch {
                            toastr.warning('聊天已经切换，旧响应不能继续补全。', '已取消操作');
                            return null;
                        }
                        const merged = await requestSecondaryContinuation(
                            messages,
                            currentText,
                            textLease,
                            signal,
                            runControl.requestBudget,
                        );
                        if (!merged) { toastr.error('补全请求失败或返回为空。', '继续补全'); return null; }
                        try {
                            assertSecondaryFillerScope(requestScope, targetMessages);
                        } catch {
                            toastr.warning('补全期间聊天已切换，返回内容已丢弃。', '已取消操作');
                            return null;
                        }
                        if (!merged.includes('<Amily2Edit>')) {
                            toastr.warning('补全后仍未包含 <Amily2Edit> 指令块，可继续补全、手动应用或重新填表。', '继续补全');
                        } else {
                            toastr.success('已获得包含指令块的补全内容，可点击”手动应用”写入。', '继续补全');
                        }
                        return merged;
                    },
                    onApply: async (editedText) => {
                        if (!editedText || !editedText.includes('<Amily2Edit>')) {
                            toastr.warning('应用的文本中未检测到 <Amily2Edit> 指令块，已按原文尝试写入。', '手动应用');
                        }
                        try {
                            assertSecondaryFillerScope(requestScope, targetMessages);
                            await commitSecondaryFillResult(
                                editedText,
                                targetMessages,
                                context.chat,
                                textLease,
                                runControl,
                                {
                                    expectedScope: requestScope,
                                    retryMessage: latestMessage,
                                },
                            );
                            runTableFillPostCommitEffects('secondary-filler-manual', [{
                                label: 'notify-success',
                                run: () => toastr.success(
                                    '分步填表已由用户手动处理完成。',
                                    'Amily2-分步填表',
                                ),
                            }]);
                        } catch (err) {
                            console.error('[Amily2-副API] 手动应用失败:', err);
                            toastr.error(`手动应用失败: ${err.message}`, '写入异常');
                        }
                    },
                    onRetry: () => {
                        try {
                            assertSecondaryFillerScope(requestScope, targetMessages);
                        } catch (error) {
                            toastr.warning(error.message, '分步填表');
                            return;
                        }
                        clearSecondaryRetryState(latestMessage);
                        cancelRunScheduledRetry();
                        toastr.info('将重新执行分步填表...', 'Amily2-分步填表');
                        scheduleManualSecondaryRetry(() => {
                            invokeSecondaryFillAndResume(
                                latestMessage,
                                true,
                                nextSecondaryInvocationOptions(opts, {
                                    __secondaryExpectedScope: requestScope,
                                    __secondaryRetryTargets: snapshotSecondaryRetryTargets(targetMessages),
                                    runControl: createTableFillRunControl({
                                        scope: 'secondary-filler-manual-retry',
                                    }),
                                }),
                            );
                        });
                    },
                    onCancel: () => {
                        toastr.info('已取消本次分步填表。', 'Amily2-分步填表');
                    },
                });
                return;
            }

            await commitSecondaryFillResult(
                rawContent,
                targetMessages,
                context.chat,
                textLease,
                runControl,
                {
                    expectedScope: requestScope,
                    retryMessage: latestMessage,
                },
            );
            fillResolved = true;
        }
        cancelRunScheduledRetry();
        runTableFillPostCommitEffects('secondary-filler-complete', [{
            label: 'notify-complete',
            run: () => toastr.success("分步填表执行完毕。", "Amily2-分步填表"),
        }]);

    } catch (error) {
        if (fillResolved || runControl.committed) {
            cancelRunScheduledRetry();
            console.error(
                '[Amily2-副API] 表格已提交，但后置处理失败；已阻止模型重跑。',
                error,
            );
            clearSecondaryRetryState(latestMessage);
            runTableFillPostCommitEffects('secondary-filler-committed-error', [{
                label: 'notify-post-commit-error',
                run: () => toastr.warning(
                    '表格已经保存，但界面刷新失败；请重新打开表格面板查看。',
                    '填表已保存',
                ),
            }]);
            return;
        }
        if (error?.name === 'AbortError' || signal.aborted) {
            cancelRunScheduledRetry();
            console.warn('[Amily2-副API] 分步填表已被用户中断，跳过结果处理与重试。');
            toastr.info('分步填表已中断。', 'Amily2-分步填表');
            clearSecondaryRetryState(latestMessage);
            return;
        }
        if (
            error?.code === 'SECONDARY_FILLER_STALE_CHAT_CONTEXT'
            || error?.code === 'TABLE_SYSTEM_STALE_CHAT_CONTEXT'
            || error?.code === 'TABLE_SYSTEM_NO_ACTIVE_CHAT'
        ) {
            cancelRunScheduledRetry();
            console.warn('[Amily2-副API] 聊天上下文已变化，旧填表结果已安全丢弃。', error);
            try {
                toastr.info('聊天已切换，旧聊天的填表结果未写入。', 'Amily2-分步填表');
            } catch {}
            return;
        }
        if (error?.code === 'TABLE_SYSTEM_SNAPSHOT_MISMATCH') {
            cancelRunScheduledRetry();
            clearPendingSecondaryCatchUpForScope(requestScope);
            console.error(
                '[Amily2-副API] 持久化后检测到本地快照变化；为避免重复写入，已停止自动重试。',
                error,
            );
            try {
                toastr.warning('服务器可能已保存本次填表结果，请重新打开聊天确认。', '需要重新载入');
            } catch {}
            return;
        }
        if (error?.code === 'SECONDARY_FILLER_CONFIGURATION') {
            cancelRunScheduledRetry();
            clearPendingSecondaryCatchUpForScope(requestScope);
            console.error('[Amily2-副API] 分步填表配置无效，已停止且不会自动重试。', error);
            try {
                toastr.error(error.message, 'Amily2-分步填表');
            } catch {}
            return;
        }
        if (isTableFillRequestLeaseError(error)) {
            console.warn('[Amily2-副API] 聊天或表格状态在模型请求期间发生变化，已丢弃过期结果。', error);
            toastr.warning('聊天或表格已变化，本次填表结果已安全丢弃。', 'Amily2-分步填表');
            clearSecondaryRetryState(latestMessage);
            queueSecondaryCatchUpForScope(requestScope, 'request-lease-changed');
            return;
        }
        const normalizedError = normalizeTableFillInferenceError(error);
        console.error(`[Amily2-副API] 发生严重错误:`, normalizedError);

        // 【新增】自定义重试逻辑
        const maxRetries = Math.max(0, parseInt(settings.secondary_filler_max_retries ?? 2, 10) || 0);
        const retryTargetKey = getSecondaryRetryTargetKey(targetMessages);
        const savedRetryTargetKey = latestMessage?.extra?.[SECONDARY_RETRY_TARGET_KEY];
        const currentRetryCount = savedRetryTargetKey === retryTargetKey
            ? Math.max(0, parseInt(latestMessage?.extra?.[SECONDARY_RETRY_COUNT_KEY] || 0, 10) || 0)
            : 0;

        if (currentRetryCount < maxRetries
            && canAutomaticallyRetryTableFill(normalizedError, runControl)) {
            const nextRetryCount = currentRetryCount + 1;
            console.log(`[Amily2-副API] 准备进行第 ${nextRetryCount}/${maxRetries} 次重试...`);
            try {
                toastr.warning(
                    `分步填表失败：${normalizedError.message}。`
                    + `3 秒后进行自动重试 ${nextRetryCount}/${maxRetries}；`
                    + `本轮请求预算剩余 ${runControl.requestBudget.remaining} 次，`
                    + '达到上限后将暂停对应楼层，避免循环请求。',
                    `分步填表自动重试 ${nextRetryCount}/${maxRetries}`,
                );
            } catch (notificationError) {
                console.error('[Amily2-副API] 自动重试提示显示失败:', notificationError);
            }

            // 重试次数与目标指纹绑定，避免等待期间批次变化后让新楼层继承旧次数。
            if (latestMessage) {
                if (!latestMessage.extra) latestMessage.extra = {};
                latestMessage.extra[SECONDARY_RETRY_COUNT_KEY] = nextRetryCount;
                latestMessage.extra[SECONDARY_RETRY_TARGET_KEY] = retryTargetKey;
            }

            if (secondaryFillerRetryTimer) {
                clearTimeout(secondaryFillerRetryTimer);
            }
            const scheduledGeneration = ++secondaryFillerRetryGeneration;
            secondaryFillerRetryTimer = setTimeout(() => {
                if (scheduledGeneration !== secondaryFillerRetryGeneration) return;
                secondaryFillerRetryTimer = null;
                invokeSecondaryFillAndResume(latestMessage, forceRun, nextSecondaryInvocationOptions(opts, {
                    __secondaryRetryGeneration: scheduledGeneration,
                    __secondaryDebounced: false,
                    __secondaryExpectedScope: requestScope,
                    __secondaryRetryTargets: snapshotSecondaryRetryTargets(targetMessages),
                }));
            }, 3000);
        } else {
            cancelRunScheduledRetry();
            const attempts = currentRetryCount + 1;
            const rangeLabel = targetMessages.length > 0
                ? `${targetMessages[0].index + 1}-${targetMessages[targetMessages.length - 1].index + 1}`
                : '';
            let failureLocked = false;
            let failureLatchPersisted = false;
            const splitBudgetUsage = describeSecondaryBatchBudget(error);
            const stopReason = runControl.automaticRetriesDisabled
                ? isTableFillBudgetError(error)
                    ? `按表拆批真实请求预算已耗尽`
                        + `${splitBudgetUsage ? `（${splitBudgetUsage}）` : ''}`
                    : `按表拆批整轮禁止自动重跑`
                        + `${splitBudgetUsage ? `（真实请求 ${splitBudgetUsage}）` : ''}`
                : normalizedError.retryable === true
                    ? `已达到重试/请求预算上限（剩余 ${runControl.requestBudget.remaining}）`
                    : '该错误不可通过重复请求修复';
            console.log(`[Amily2-副API] ${stopReason}，放弃本次填表。`);

            if (targetMessages.length > 0) {
                try {
                    assertSecondaryFillerScope(requestScope, targetMessages);
                    await markTargetsFailed(targetMessages, {
                        expectedScope: requestScope,
                        retryMessage: latestMessage,
                        attempts,
                    });
                    failureLocked = true;
                    failureLatchPersisted = true;
                } catch (latchError) {
                    console.error('[Amily2-副API] 分步填表失败锁持久化失败:', latchError);
                    // 即使服务器保存失败，也保留当前会话内的锁，避免网络故障造成请求风暴。
                    try {
                        assertSecondaryFillerScope(requestScope, targetMessages);
                        applySecondaryFailureLatch(targetMessages, attempts, latestMessage);
                        failureLocked = true;
                    } catch {}
                }
            } else {
                clearSecondaryRetryState(latestMessage);
            }
            if (failureLocked) {
                queueSecondaryCatchUpForScope(requestScope, 'terminal-failure-latch');
            }

            console.log(`[Amily2-副API] 已达到最大重试次数 (${maxRetries})，本次填表已暂停。`);
            const pauseMessage = failureLatchPersisted
                ? `楼层 ${rangeLabel} 的自动重试已暂停；内容未变化时不会再次调用。编辑该消息或执行手动强制重填可解除。`
                : failureLocked
                    ? `楼层 ${rangeLabel} 已在本次会话中暂停，但暂停标记未能保存；重新载入后可能再次触发。`
                    : '本次任务已终止；未能定位目标楼层，未写入失败锁。';
            try {
                toastr.error(
                    `分步填表失败：${normalizedError.message}。${stopReason}。${pauseMessage}`,
                    '分步填表已暂停',
                );
            } catch (notificationError) {
                console.error('[Amily2-副API] 最终失败提示显示失败:', notificationError);
            }
        }
    } finally {
        // reset 后可能已有新任务持有全局 controller；旧任务结束时不能清掉新锁。
        if (currentAbortController === runAbortController) {
            secondaryFillerRunning = false;
            currentAbortController = null;
            drainPendingSecondaryForceRuns();
            schedulePendingSecondaryCatchUp();
        }
    }
}

/**
 * Record one coalesced full scan for the currently active chat.
 *
 * This is intentionally safe to call while filling, retrying or while the
 * CHAT_CHANGED lifecycle gate is closed. The task only runs after all of
 * those blockers are gone and the captured chat scope is still current.
 */
export function requestSecondaryFillerCatchUp(reason = 'external') {
    const queued = queueCurrentSecondaryCatchUp(reason);
    if (queued) schedulePendingSecondaryCatchUp();
    return queued;
}

/**
 * Resume an already queued wake-up after the table lifecycle publishes ready.
 * Unlike requestSecondaryFillerCatchUp(), this never creates new work merely
 * because a user opened or switched to a chat.
 */
export function resumeSecondaryFillerCatchUp() {
    if (!secondaryFillerPendingCatchUp) return false;
    return schedulePendingSecondaryCatchUp();
}

export function resetSecondaryFillerLock() {
    const wasLocked = secondaryFillerRunning
        || Boolean(secondaryFillerDebounceTimer)
        || Boolean(secondaryFillerRetryTimer)
        || Boolean(secondaryFillerManualRetryTimer)
        || Boolean(secondaryFillerCatchUpTimer)
        || Boolean(secondaryFillerPendingCatchUp)
        || secondaryFillerPendingForceRuns.length > 0;
    if (secondaryFillerDebounceTimer) {
        clearTimeout(secondaryFillerDebounceTimer);
        secondaryFillerDebounceTimer = null;
    }
    cancelScheduledRetry();
    cancelManualRetry();
    clearPendingSecondaryCatchUp();
    clearPendingSecondaryForceRuns();
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch {}
        currentAbortController = null;
    }
    secondaryFillerRunning = false;
    return wasLocked;
}

/** CHAT_CHANGED hook: synchronously revoke every task owned by the old chat. */
export function resetSecondaryFillerForChatChange() {
    return resetSecondaryFillerLock();
}

export function isSecondaryFillerRunning() {
    return secondaryFillerRunning
        || Boolean(secondaryFillerDebounceTimer)
        || Boolean(secondaryFillerRetryTimer)
        || Boolean(secondaryFillerManualRetryTimer)
        || Boolean(secondaryFillerCatchUpTimer)
        || Boolean(secondaryFillerPendingCatchUp)
        || secondaryFillerPendingForceRuns.length > 0;
}

export function abortCurrentSecondaryFiller() {
    if (!secondaryFillerRunning
        && !currentAbortController
        && !secondaryFillerDebounceTimer
        && !secondaryFillerRetryTimer
        && !secondaryFillerManualRetryTimer
        && !secondaryFillerCatchUpTimer
        && !secondaryFillerPendingCatchUp
        && secondaryFillerPendingForceRuns.length === 0) {
        return false;
    }
    if (secondaryFillerDebounceTimer) {
        clearTimeout(secondaryFillerDebounceTimer);
        secondaryFillerDebounceTimer = null;
    }
    cancelScheduledRetry();
    cancelManualRetry();
    clearPendingSecondaryCatchUp();
    clearPendingSecondaryForceRuns();
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch {}
    }
    // 锁的释放由 finally 完成；这里只发出中断信号
    return true;
}

    async function getHistoryContext(
        messagesToFetch,
        historyEndIndex,
        tagsToExtract,
        exclusionRules,
        excludeUserMessages = false,
    ) {
        const context = getContext();
        const chat = context.chat;
        
        if (!chat || chat.length === 0 || messagesToFetch <= 0) {
            return null;
        }

        const historyUntil = Math.max(0, historyEndIndex); 
        // 【修复】slice 的 end 索引是不包含的，为了包含 historyUntil，end 必须 +1
        const sliceEnd = historyUntil + 1;
        const messagesToExtract = Math.min(messagesToFetch, sliceEnd);
        const sliceStart = Math.max(0, sliceEnd - messagesToExtract);

        const historySlice = chat.slice(sliceStart, sliceEnd);
        const userName = context.name1 || '用户';
        const characterName = context.name2 || '角色';

        const messages = historySlice.map((msg, index) => {
            if (excludeUserMessages && msg.is_user) return null;
            let content = String(msg.mes ?? '');

            if (!msg.is_user && tagsToExtract && tagsToExtract.length > 0) {
                const blocks = extractBlocksByTags(content, tagsToExtract);
                content = blocks.join('\n\n');
            }
            
            if (content && exclusionRules) {
                content = applyExclusionRules(content, exclusionRules);
            }

            if (!content.trim()) return null;
            
            return {
                floor: sliceStart + index + 1, 
                author: msg.is_user ? userName : characterName,
                authorType: msg.is_user ? 'user' : 'char',
                content: content.trim()
            };
        }).filter(Boolean);
    
    if (messages.length === 0) {
        return null;
    }

    const formattedHistory = messages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');

    return `<对话记录>\n${formattedHistory}\n</对话记录>`;
}
