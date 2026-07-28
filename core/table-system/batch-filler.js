import { getContext, extension_settings } from '/scripts/extensions.js';
import { characters } from '/script.js';
import { loadWorldInfo } from '/scripts/world-info.js';
import { log } from './logger.js';
import {
    convertAiFillableTablesToCsvString,
    getBatchFillerFlowTemplate,
    getBatchFillerRuleTemplate,
    updateTableFromOps,
    updateTableFromOperationBatches,
    updateTableFromText,
} from './manager.js';
import { extensionName } from '../../utils/settings.js';
import { renderTables } from '../../ui/table-bindings.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';
import { extractBlocksByTags, applyExclusionRules } from '../utils/rag-tag-extractor.js';
import { resolveTableRuleConfig } from '../../utils/config/RuleProfileManager.js';
import { showTableFillReviewModal } from '../../ui/page-window.js';
import { TABLE_FILL_SAFETY_POLICY } from './settings.js';
import {
    BATCH_REQUIRED_FILLER_BLOCKS,
    buildFillerFlowPrompt,
    completeFillerPromptOrder,
} from './filler-prompt-order.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import {
    requestTableFillOperationsV2,
    TABLE_FILL_TOOL_RESULT,
} from './tool-call-filler.js';
import {
    assertTableFillRequestLease,
    captureTableFillRequestLease,
    isTableFillRequestLeaseError,
} from './infra/persistence-scope.js';
import {
    canAutomaticallyRetryTableFill,
    combineTableFillRequestBudgets,
    createDeterministicTableFillError,
    createImmediateFillActionRequestBudget,
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
import { commitToLastMessageAsync } from './infra/persistence.js';
import { createManualFillHandoffTransaction } from './manual-fill-handoff.js';
import { parseToOperationsDetailed } from './executor.js';

const CONTINUE_PROMPT = '上一条回复不完整或缺少 <Amily2Edit> 指令块。请直接从中断处继续生成剩余内容，不要重复已输出的文本，也不要添加任何解释或寒暄，确保最终输出中包含完整的 <Amily2Edit>...</Amily2Edit> 指令块。';

function createBatchFillerError(code, message) {
    const error = new Error(message);
    error.code = `BATCH_FILLER_${code}`;
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

function assertBatchFillerScope(expectedScope) {
    if (!chatScopesMatch(expectedScope, captureChatScope(getContext()))) {
        throw createBatchFillerError('STALE_CHAT_CONTEXT', '聊天已切换，本次填表结果已丢弃。');
    }
}

function tableCommitTransaction(expectedScope) {
    return {
        expectedChatId: expectedScope.chatId,
        expectedChatScope: expectedScope,
    };
}

function createManualFillPersistCandidate(fillEvidence, expectedScope) {
    const transaction = createManualFillHandoffTransaction({
        sourceMessages: fillEvidence.sourceMessages,
        targetMessages: fillEvidence.targetMessages,
        expectedScope,
        transaction: tableCommitTransaction(expectedScope),
    });
    return state => commitToLastMessageAsync(state, undefined, transaction);
}

async function commitExplicitManualTextNoop(
    text,
    fillLease,
    persistCandidate,
    runControl,
    rangeLabel,
) {
    const parsed = parseToOperationsDetailed(text);
    if (!parsed.ok || !parsed.empty) return false;
    assertTableFillRequestLease(fillLease, getContext());
    const committed = await persistCandidate(fillLease.state);
    if (!committed) {
        throw createDeterministicTableFillError(
            'TABLE_FILL_WRITE_REJECTED',
            `${rangeLabel} 的空操作交接标记未能持久化。`,
        );
    }
    runControl.markCommitted();
    return true;
}

async function requestContinuation(baseMessages, partialResponse, requestLease, requestBudget) {
    assertTableFillRequestLease(requestLease, getContext());
    const continueMessages = [
        ...baseMessages,
        { role: 'assistant', content: partialResponse || '' },
        { role: 'user', content: CONTINUE_PROMPT },
    ];
    const continued = await callTableModel(continueMessages, requestLease, requestBudget);
    if (typeof continued !== 'string' || !continued.trim()) return null;
    return `${partialResponse || ''}${continued}`;
}

let isFilling = false;
let manualStopRequested = false;
let currentBatch = 0;
let totalBatches = 0;
let chatHistoryLength = 0;
let threshold = 30;
let activeBatchChatScope = null;
let activeImmediateFillRequestBudget = null;
const MAX_RETRIES = 2; 

function assertImmediateFillContinue() {
    if (manualStopRequested) {
        throw createBatchFillerError(
            'STOP_REQUESTED',
            '用户已请求暂停立即填表，当前楼层批次不会提交。',
        );
    }
}

function assertSignalActive(signal) {
    if (!signal?.aborted) return;
    const error = new Error('表格填表任务已被取消。');
    error.name = 'AbortError';
    throw error;
}

function describeRequestBudget(error, fallbackBudget) {
    // A TableFillRequestBudgetError carries the exact budget that stopped the
    // request. Prefer it over the diagnostic snapshots attached by the runner
    // so an 80-request action ceiling is not mistaken for the per-batch limit,
    // or vice versa.
    const snapshot = error?.snapshot
        || error?.tableFillBatchBudgetSnapshot
        || error?.tableFillActionBudgetSnapshot
        || fallbackBudget?.snapshot?.();
    if (!snapshot) return '';
    if (Array.isArray(snapshot.components)) {
        return snapshot.components
            .map(item => `${item.used ?? '?'} / ${item.limit ?? '?'}`)
            .join('，');
    }
    return `${snapshot.used ?? '?'} / ${snapshot.limit ?? '?'}`;
}

function logImmediateFillBudgetUsage(batchNum) {
    const usage = describeRequestBudget(null, activeImmediateFillRequestBudget);
    if (usage) {
        log(`立即填表完成批次 ${batchNum} 后，真实总请求用量为 ${usage}。`, 'info');
    }
}


async function getWorldBookContext() {
    const settings = extension_settings[extensionName] || {};
    if (!settings.table_worldbook_enabled) {
        return '';
    }

    const context = getContext();
    let bookNames = [];
    let content = '';

    if (settings.table_worldbook_source === 'character') {
        const characterId = context.characterId;
        const character = characters[characterId];
        const characterBook = character?.data?.extensions?.world;
        if (characterBook) {
            bookNames.push(characterBook);
        }
    } else {
        bookNames = settings.table_selected_worldbooks || [];
    }

    if (bookNames.length === 0) {
        return '';
    }

    const selectedEntriesConfig = settings.table_selected_entries || {};

    for (const bookName of bookNames) {
        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData || !bookData.entries) continue;

            const entriesToInclude = settings.table_worldbook_source === 'manual'
                ? (selectedEntriesConfig[bookName] || []).map(uid => String(uid))
                : Object.values(bookData.entries).map(entry => String(entry.uid));

            for (const entry of Object.values(bookData.entries)) {
                if (entriesToInclude.includes(String(entry.uid))) {
                    content += `[来源：世界书，条目名字：${entry.comment || '无标题条目'}]\n${entry.content}\n\n`;
                }
            }
        } catch (error) {
            log(`加载世界书 "${bookName}" 失败: ${error.message}`, 'error');
        }
    }

    if (content.length > settings.table_worldbook_char_limit) {
        content = content.substring(0, settings.table_worldbook_char_limit);
    }

    return content.trim() ? `<世界书>\n${content.trim()}\n</世界书>` : '';
}

const fillButton = () => document.getElementById('fill-table-now-btn');

function updateButtonState(state, batchNum = 0, attemptNum = 0) {
    const button = fillButton();
    if (!button) return;

    switch (state) {
        case 'processing':
            let attemptText = attemptNum > 0 ? ` (尝试 ${attemptNum + 1})` : '';
            button.textContent = `点击停止 (${batchNum}/${totalBatches})${attemptText}`;
            button.disabled = false;
            isFilling = true;
            break;
        case 'stopping':
            button.textContent = '正在停止...';
            button.disabled = true;
            break;
        case 'paused':
            button.textContent = '继续填表';
            button.disabled = false;
            isFilling = true;
            break;
        case 'error':
            button.textContent = '继续填表 (出错)';
            button.disabled = false;
            isFilling = true;
            break;
        case 'idle':
        default:
            button.textContent = '立即填表';
            button.disabled = false;
            isFilling = false;
            currentBatch = 0;
            activeBatchChatScope = null;
            manualStopRequested = false;
            break;
    }
}

async function callTableModel(messages, requestLease, requestBudget, signal) {
    try {
        const settings = extension_settings[extensionName] || {};

        if (settings.nccsEnabled) {
            log('使用独立API填表进行表格填充...', 'info');
            requestBudget?.assertAvailable();
            requestBudget?.consume('text-fallback');
            const result = await callNccsAI(messages, {
                ...(signal ? { signal } : {}),
                throwOnError: true,
            });
            if (requestLease) assertTableFillRequestLease(requestLease, getContext());
            const normalizedResult = typeof result === 'string' ? result : '';
            if (!normalizedResult.trim()) {
                throw createRetryableResponseError(
                    'TABLE_FILL_EMPTY_RESPONSE',
                    '独立API填表返回内容为空。',
                );
            }
            return normalizedResult;
        } else {
            log('使用 tableFilling slot 进行表格填充...', 'info');
            const result = await callAI(messages, {
                slot: 'tableFilling',
                requestBudget,
                requestKind: 'text-fallback',
                throwOnError: true,
                ...(signal ? { signal } : {}),
            });
            if (requestLease) assertTableFillRequestLease(requestLease, getContext());
            const normalizedResult = typeof result === 'string' ? result : '';
            if (!normalizedResult.trim()) {
                throw createRetryableResponseError(
                    'TABLE_FILL_EMPTY_RESPONSE',
                    'API返回内容为空。',
                );
            }
            return normalizedResult;
        }
    } catch (error) {
        if (isTableFillRequestLeaseError(error)) throw error;
        const normalizedError = normalizeTableFillInferenceError(error);
        log(`与模型通讯时发生异常: ${normalizedError.message}`, "error");
        throw normalizedError;
    }
}
function getRawMessagesForSummary(startFloor, endFloor, context = getContext()) {
    const chat = context.chat;
    const settings = extension_settings[extensionName] || {};

    const historySlice = chat.slice(startFloor - 1, endFloor);
    if (historySlice.length === 0) return null;

    const userName = context.name1 || '用户';
    const characterName = context.name2 || '角色';
    
    let tagsToExtract = [];
    let exclusionRules = [];
    let excludeUserMessages = false;

    const tableRuleConfig = resolveTableRuleConfig(settings);
    if (
        (tableRuleConfig.tagExtractionEnabled && tableRuleConfig.tags)
        || (tableRuleConfig.exclusionRules && tableRuleConfig.exclusionRules.length)
        || tableRuleConfig.excludeUserMessages
    ) {
        log('批量填表：使用提取规则配置。', 'info');
        tagsToExtract = tableRuleConfig.tagExtractionEnabled
            ? (tableRuleConfig.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            : [];
        exclusionRules = tableRuleConfig.exclusionRules || [];
        excludeUserMessages = Boolean(tableRuleConfig.excludeUserMessages);
    }

    const messages = historySlice.map((msg, index) => {
        if (excludeUserMessages && msg.is_user) return null;
        let content = String(msg.mes ?? '');

        if (tagsToExtract.length > 0) {
            const blocks = extractBlocksByTags(content, tagsToExtract);
            content = blocks.length > 0 ? blocks.join('\n\n') : '';
        }
        
        if (content) {
            content = applyExclusionRules(content, exclusionRules);
        }
        
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

function getFillEvidence(context, startFloor, endFloor) {
    const sourceMessages = context.chat;
    const targetMessages = [];
    const startIndex = Math.max(0, startFloor - 1);
    const endIndex = Math.min(sourceMessages.length - 1, endFloor - 1);
    for (let index = startIndex; index <= endIndex; index++) {
        const msg = sourceMessages[index];
        if (msg && !msg.is_user) {
            targetMessages.push({ index, msg });
        }
    }
    return { sourceMessages, targetMessages };
}

async function runBatchAttempt(batchNum, attemptNum, runControl) {
    runControl = resolveTableFillRunControl(runControl, {
        scope: `batch-${batchNum}`,
    });
    try {
        if (manualStopRequested) {
            log(`任务已在批次 ${batchNum} 开始前手动暂停。`, 'warn');
            updateButtonState('paused');
            return;
        }

        if (!activeBatchChatScope?.chatId) {
            throw createBatchFillerError('MISSING_CHAT_CONTEXT', '当前聊天缺少可验证的聊天标识，无法安全执行填表。');
        }
        assertBatchFillerScope(activeBatchChatScope);

        updateButtonState('processing', batchNum, attemptNum);

        const startFloor = (batchNum - 1) * threshold + 1;
        const endFloor = Math.min(startFloor + threshold - 1, chatHistoryLength);
        const fillContext = getContext();
        const fillLease = captureTableFillRequestLease(fillContext);
        const fillEvidence = getFillEvidence(fillContext, startFloor, endFloor);
        const persistManualCandidate = createManualFillPersistCandidate(
            fillEvidence,
            activeBatchChatScope,
        );
        const batchSettings = extension_settings[extensionName] || {};
        const tableBatches = planTableFillBatches(
            fillLease.state,
            batchSettings.table_fill_tables_per_request,
        );
        const splitTablesAcrossRequests = tableBatches.length > 1;
        const immediateRequestBudget = splitTablesAcrossRequests
            ? combineTableFillRequestBudgets(
                runControl.requestBudget,
                activeImmediateFillRequestBudget,
            )
            : runControl.requestBudget;

        log(`正在处理批次 ${batchNum}/${totalBatches} (楼层 ${startFloor}-${endFloor}, 尝试 ${attemptNum + 1}/${MAX_RETRIES + 1})`, 'info');

        const purifiedMessages = getRawMessagesForSummary(startFloor, endFloor, fillContext);
        if (!purifiedMessages || purifiedMessages.length === 0) {
            throw new Error('净化后无有效内容可处理。');
        }

        const batchContent = purifiedMessages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');
        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        const currentTableDataString = convertAiFillableTablesToCsvString();
        const finalFlowPrompt = splitTablesAcrossRequests
            ? buildCacheStableFlowPrompt(flowTemplate)
            : buildFillerFlowPrompt(flowTemplate, currentTableDataString);

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[批量填表] 加载混合顺序失败:", e);
        }
        const completedOrder = completeFillerPromptOrder(
            getMixedOrder('batch_filler'),
            BATCH_REQUIRED_FILLER_BLOCKS,
        );
        const order = completedOrder.order;
        if (completedOrder.added.length > 0) {
            log(
                `批量填表提示链缺少必要块，已仅为本次请求补齐：${completedOrder.added.join(', ')}`,
                'warn',
            );
        }

        const presetPrompts = await getPresetPrompts('batch_filler');
        
        const worldBookContext = await getWorldBookContext();
        
        const seedMessages = createTableFillRandomSeedMessages(
            batchSettings,
            () => runControl.getOrCreateStableSeed(generateRandomSeed),
        );
        const messages = [...seedMessages];

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
                            messages.push({ role: 'system', content: worldBookContext });
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"对话记录"中的内容进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<对话记录>\n${batchContent}\n</对话记录>` });
                        break;
                }
            }
        }

        messages.push({ role: 'system', content: TABLE_FILL_SAFETY_POLICY });

        const tableBatchResult = splitTablesAcrossRequests
            ? await collectTableFillOperationBatches({
                tableState: fillLease.state,
                tableBatches,
                stableMessages: messages,
                settings: batchSettings,
                slot: 'tableFilling',
                runControl,
                requestBudget: activeImmediateFillRequestBudget,
                scope: `batch-${batchNum}`,
                assertContinue: assertImmediateFillContinue,
                assertLease: () => {
                    assertBatchFillerScope(activeBatchChatScope);
                    assertTableFillRequestLease(fillLease, getContext());
                },
                callText: async (batchMessages, requestBudget, batchMeta) => {
                    if (batchMeta.fallbackReason) {
                        log(
                            `批次 ${batchNum} 的表格子批 ${batchMeta.batchIndex + 1}/${batchMeta.batchCount} `
                            + `Tool Call V2 不可用（${batchMeta.fallbackReason}），改用严格文本指令。`,
                            'warn',
                        );
                    }
                    return await callTableModel(
                        batchMessages,
                        fillLease,
                        requestBudget,
                        batchMeta.signal,
                    );
                },
            })
            : null;
        if (tableBatchResult) {
            assertImmediateFillContinue();
            assertBatchFillerScope(activeBatchChatScope);
            assertTableFillRequestLease(fillLease, getContext());
            if (tableBatchResult.operationCount > 0) {
                const applied = await updateTableFromOperationBatches(
                    tableBatchResult.operationBatches,
                    {
                        immediateDelete: true,
                        requestLease: fillLease,
                        onCommitted: () => runControl.markCommitted(),
                        ...fillEvidence,
                        persistCandidate: persistManualCandidate,
                    },
                );
                if (!applied) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        `批次 ${batchNum} 的按表拆批结果未通过整轮校验。`,
                    );
                }
                runControl.markCommitted();
            } else {
                const committed = await persistManualCandidate(fillLease.state);
                if (!committed) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        `批次 ${batchNum} 的空操作交接标记未能持久化。`,
                    );
                }
                runControl.markCommitted();
            }
            runTableFillPostCommitEffects(`batch-${batchNum}-table-batches`, [
                { label: 'render-tables', run: () => renderTables() },
                {
                    label: 'log-success',
                    run: () => log(
                        `批次 ${batchNum} 已按 ${tableBatchResult.tableBatches.length} 个表格子批原子完成。`,
                        'success',
                    ),
                },
            ]);
            if (splitTablesAcrossRequests) {
                logImmediateFillBudgetUsage(batchNum);
            }
            currentBatch = batchNum;
            setTimeout(processNextBatch, 1000);
            return;
        }

        console.groupCollapsed(`[Amily2 立即远征] 批次 ${batchNum}/${totalBatches} - 即将发送至 API 的内容`);
        console.dir(messages);
        console.groupEnd();

        assertTableFillRequestLease(fillLease, getContext());
        assertBatchFillerScope(activeBatchChatScope);
        const toolResult = batchSettings.tableFillFunctionCall
            ? await requestTableFillOperationsV2(messages, {
                tableState: fillLease.state,
                settings: batchSettings,
                slot: 'tableFilling',
                requestBudget: immediateRequestBudget,
                assertLease: () => assertTableFillRequestLease(fillLease, getContext()),
            })
            : null;
        if (toolResult?.mode === TABLE_FILL_TOOL_RESULT.TOOL) {
            const ops = toolResult.operations;
            if (ops.length === 0) {
                assertTableFillRequestLease(fillLease, getContext());
                const committed = await persistManualCandidate(fillLease.state);
                if (!committed) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        `批次 ${batchNum} 的空操作交接标记未能持久化。`,
                    );
                }
                runControl.markCommitted();
                runTableFillPostCommitEffects(`batch-${batchNum}-noop`, [
                    {
                        label: 'log-noop',
                        run: () => log(`批次 ${batchNum} 的 Tool Call V2 判断没有可靠的新事实。`, 'info'),
                    },
                    {
                        label: 'notify-noop',
                        run: () => toastr.info('AI 判断此批次无需修改。', `批次 ${batchNum}`),
                    },
                ]);
            } else {
                const applied = await updateTableFromOps(ops, {
                    immediateDelete: true,
                    requestLease: fillLease,
                    onCommitted: () => runControl.markCommitted(),
                    ...fillEvidence,
                    persistCandidate: persistManualCandidate,
                });
                if (!applied) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        'Tool Call V2 操作未产生可提交变更，或表格保存失败。',
                    );
                }
                runControl.markCommitted();
                runTableFillPostCommitEffects(`batch-${batchNum}-tool`, [
                    { label: 'render-tables', run: () => renderTables() },
                    {
                        label: 'log-success',
                        run: () => log(
                            `批次 ${batchNum} Tool Call V2 处理成功（${ops.length} 条操作）。`,
                            'success',
                        ),
                    },
                ]);
            }
        } else {
            if (toolResult?.reason && toolResult.reason !== 'tool-disabled') {
                log(`批次 ${batchNum} 的 Tool Call V2 不可用（${toolResult.reason}），改用严格文本指令。`, 'warn');
                toastr.warning('Tool Call V2 当前不可用，已改用严格文本填表。', `批次 ${batchNum}`);
            }
            const resultText = await callTableModel(
                messages,
                fillLease,
                immediateRequestBudget,
            );
            console.log(`[Amily2 立即远征] 批次 ${batchNum}/${totalBatches} - 收到 API 原始回复:`, resultText);
            if (typeof resultText !== 'string' || !resultText.trim()) {
                throw createRetryableResponseError('TABLE_FILL_EMPTY_RESPONSE', 'API返回内容为空。');
            }
            assertBatchFillerScope(activeBatchChatScope);

            if (!resultText.includes('<Amily2Edit>')) {
                log(`批次 ${batchNum} 的响应未包含 <Amily2Edit> 指令块，弹出检查窗口等待用户处理。`, 'warn');
                updateButtonState('paused');
                showTableFillReviewModal(resultText, {
                    title: `填表响应检查 - 批次 ${batchNum}/${totalBatches}`,
                    subtitle: `批次 ${batchNum}/${totalBatches}（楼层 ${startFloor}-${endFloor}）的 AI 响应未包含有效的 <Amily2Edit> 指令块。请检查原始响应并选择处理方式。`,
                    onContinue: async (currentText) => {
                        try {
                            assertBatchFillerScope(activeBatchChatScope);
                        } catch {
                            toastr.warning('聊天已经切换，旧响应不能继续补全。', '已取消操作');
                            return null;
                        }
                        const merged = await requestContinuation(
                            messages,
                            currentText,
                            fillLease,
                            immediateRequestBudget,
                        );
                        if (!merged) { toastr.error('补全请求失败或返回为空。', '继续补全'); return null; }
                        try {
                            assertBatchFillerScope(activeBatchChatScope);
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
                            assertBatchFillerScope(activeBatchChatScope);
                            let applied = await commitExplicitManualTextNoop(
                                editedText,
                                fillLease,
                                persistManualCandidate,
                                runControl,
                                `批次 ${batchNum}`,
                            );
                            if (!applied) {
                                applied = await updateTableFromText(editedText, {
                                    strictTextResponse: true,
                                    immediateDelete: true,
                                    requestLease: fillLease,
                                    onCommitted: () => runControl.markCommitted(),
                                    ...fillEvidence,
                                    persistCandidate: persistManualCandidate,
                                });
                            }
                            if (!applied) {
                                throw createDeterministicTableFillError(
                                    'TABLE_FILL_WRITE_REJECTED',
                                    '文本未产生可提交变更，或表格保存失败。',
                                );
                            }
                            runControl.markCommitted();
                            runTableFillPostCommitEffects(`batch-${batchNum}-manual`, [
                                { label: 'render-tables', run: () => renderTables() },
                                {
                                    label: 'log-success',
                                    run: () => log(`批次 ${batchNum} 已由用户手动处理完成。`, 'success'),
                                },
                            ]);
                        } catch (err) {
                            if (runControl.committed) {
                                log(`批次 ${batchNum} 已保存，后置界面处理失败: ${err.message}`, 'error');
                                currentBatch = batchNum;
                                setTimeout(processNextBatch, 500);
                                return;
                            }
                            log(`批次 ${batchNum} 手动应用失败: ${err.message}`, 'error');
                            toastr.error(`手动应用失败: ${err.message}`, '写入异常');
                            currentBatch = batchNum - 1;
                            updateButtonState('error');
                            return;
                        }
                        currentBatch = batchNum;
                        setTimeout(processNextBatch, 500);
                    },
                    onRetry: () => {
                        try {
                            assertBatchFillerScope(activeBatchChatScope);
                        } catch (error) {
                            log(`批次 ${batchNum} 所属聊天已切换，已取消重新填表。`, 'warn');
                            toastr.warning('聊天已经切换，旧批次不会重新执行。', '已取消重试');
                            return;
                        }
                        log(`用户选择重新填表，批次 ${batchNum} 将重新执行。`, 'warn');
                        setTimeout(() => runBatchAttempt(
                            batchNum,
                            0,
                            createTableFillRunControl({
                                scope: `batch-${batchNum}-manual-retry`,
                            }),
                        ), 300);
                    },
                    onCancel: () => {
                        log(`用户取消了批次 ${batchNum} 的处理，任务已暂停。`, 'warn');
                        currentBatch = batchNum - 1;
                        updateButtonState('error');
                    },
                });
                return;
            }

            let applied = await commitExplicitManualTextNoop(
                resultText,
                fillLease,
                persistManualCandidate,
                runControl,
                `批次 ${batchNum}`,
            );
            if (!applied) {
                applied = await updateTableFromText(resultText, {
                    strictTextResponse: true,
                    immediateDelete: true,
                    requestLease: fillLease,
                    onCommitted: () => runControl.markCommitted(),
                    ...fillEvidence,
                    persistCandidate: persistManualCandidate,
                });
            }
            if (!applied) {
                throw createDeterministicTableFillError(
                    'TABLE_FILL_WRITE_REJECTED',
                    '文本未产生可提交变更，或表格保存失败。',
                );
            }
            runControl.markCommitted();
            runTableFillPostCommitEffects(`batch-${batchNum}-text`, [
                { label: 'render-tables', run: () => renderTables() },
                {
                    label: 'log-success',
                    run: () => log(`批次 ${batchNum} 处理成功。`, 'success'),
                },
            ]);
        }

        if (splitTablesAcrossRequests) {
            logImmediateFillBudgetUsage(batchNum);
        }
        currentBatch = batchNum;
        setTimeout(processNextBatch, 1000);

    } catch (error) {
        if (runControl.committed) {
            log(`批次 ${batchNum} 已提交，后置处理失败；已阻止模型重跑: ${error.message}`, 'error');
            currentBatch = batchNum;
            setTimeout(processNextBatch, 1000);
            return;
        }
        if (error?.code === 'BATCH_FILLER_STOP_REQUESTED') {
            log(`批次 ${batchNum} 已按用户请求在提交前暂停。`, 'warn');
            currentBatch = batchNum - 1;
            updateButtonState('paused');
            return;
        }
        if (isTableFillBudgetError(error)) {
            const usage = describeRequestBudget(error, activeImmediateFillRequestBudget);
            log(
                `批次 ${batchNum} 在提交前达到真实请求预算上限`
                + `${usage ? `（${usage}）` : ''}，已暂停。`,
                'warn',
            );
            toastr.warning(
                `当前楼层批次尚未提交；已完成的较早楼层批次会保留。`
                + `${usage ? `真实请求用量：${usage}。` : ''}`
                + '请点击“继续填表”创建新的明确预算。',
                '立即填表已暂停',
            );
            manualStopRequested = true;
            currentBatch = batchNum - 1;
            updateButtonState('paused');
            return;
        }
        if (error?.code === 'BATCH_FILLER_STALE_CHAT_CONTEXT'
            || error?.code === 'BATCH_FILLER_MISSING_CHAT_CONTEXT'
            || error?.code === 'TABLE_SYSTEM_STALE_CHAT_CONTEXT'
            || error?.code === 'TABLE_SYSTEM_NO_ACTIVE_CHAT') {
            log(`批次 ${batchNum} 因聊天上下文已变化而停止：${error.message}`, 'warn');
            toastr.warning('聊天已经切换，旧聊天的填表结果已丢弃，不会自动重试。', '填表已停止');
            updateButtonState('idle');
            return;
        }
        if (error?.code === 'TABLE_SYSTEM_SNAPSHOT_MISMATCH') {
            log(`批次 ${batchNum} 保存后检测到本地快照变化，已停止以避免重复写入。`, 'error');
            toastr.warning('服务器可能已经保存本批结果。请重新打开聊天确认后再继续，系统不会自动重试。', '需要重新载入');
            updateButtonState('idle');
            return;
        }
        log(`批次 ${batchNum} 尝试 ${attemptNum + 1} 失败: ${error.message}`, 'error');
        if (isTableFillRequestLeaseError(error)) {
            log(`批次 ${batchNum} 的聊天或表格请求租约已失效，已停止任务且不会自动重试。`, 'warn');
            toastr.warning('聊天或表格已变化，过期填表结果已安全丢弃。', '任务停止');
            currentBatch = batchNum - 1;
            manualStopRequested = true;
            updateButtonState('idle');
            return;
        }
        const normalizedError = normalizeTableFillInferenceError(error);
        if (attemptNum >= MAX_RETRIES
            || !canAutomaticallyRetryTableFill(normalizedError, runControl)) {
            const usage = describeRequestBudget(error, activeImmediateFillRequestBudget);
            const stopReason = runControl.automaticRetriesDisabled
                ? `按表拆批整轮禁止自动重跑${usage ? `（真实请求 ${usage}）` : ''}`
                : normalizedError.retryable === true
                    ? `请求预算已用 ${runControl.requestBudget.used}/${runControl.requestBudget.limit}`
                    : '错误不可通过重复请求修复';
            const isFormatError = String(normalizedError?.code || '').startsWith('TOOL_CALL_V2_')
                || String(normalizedError?.code || '').startsWith('TABLE_FILL_TOOL_ARGS_');
            const failureDetail = isFormatError
                ? `模型返回的结构化数据未通过整批校验：${normalizedError.message}`
                : normalizedError.message;
            log(`批次 ${batchNum} 已停止自动重试：${stopReason}。`, 'error');
            toastr.error(
                `批次 ${batchNum} 失败：${failureDetail}；${stopReason}。当前批次尚未跳过，可手动继续。`,
                '任务暂停',
            );
            currentBatch = batchNum - 1;
            updateButtonState('error');
        } else {
            log(`将在3秒后自动重试批次 ${batchNum}...`, 'warn');
            try {
                toastr.warning(
                    `批次 ${batchNum} 填表失败：${normalizedError.message}。`
                    + `3 秒后自动重试 ${attemptNum + 1}/${MAX_RETRIES}；`
                    + `本轮请求预算剩余 ${runControl.requestBudget.remaining} 次。`,
                    `批次 ${batchNum} 自动重试`,
                );
            } catch {}
            setTimeout(() => runBatchAttempt(
                batchNum,
                attemptNum + 1,
                runControl,
            ), 3000);
        }
    }
}

async function processNextBatch() {
    if (manualStopRequested) {
        log(`任务已在批次 ${currentBatch + 1} 开始前手动暂停。`, 'warn');
        updateButtonState('paused');
        return;
    }

    if (currentBatch >= totalBatches) {
        log('所有批次处理完毕！', 'success');
        updateButtonState('idle');
        return;
    }

    const batchNum = currentBatch + 1;
    runBatchAttempt(batchNum, 0, createTableFillRunControl({
        scope: `batch-${batchNum}`,
    }));
}

export function startBatchFilling() {
    const button = fillButton();
    if (!button) return;

    const settings = extension_settings[extensionName] || {};
    const tableSystemEnabled = settings.table_system_enabled !== false; 
    if (!tableSystemEnabled) {
        log('表格系统总开关已关闭，跳过批量填表。', 'info');
        toastr.info('表格系统总开关已关闭，无法执行批量填表。');
        return;
    }

    if (isFilling) {
        if (button.textContent.startsWith('点击停止')) {
            manualStopRequested = true;
            updateButtonState('stopping');
            log('停战敕令已下达！将在当前批次完成后暂停。', 'warn');
        } else if (button.textContent.startsWith('继续填表')) {
            manualStopRequested = false;
            activeImmediateFillRequestBudget = createImmediateFillActionRequestBudget(
                'immediate-table-fill-resumed-action',
            );
            log('从上次暂停处继续处理...', 'info');
            processNextBatch();
        }
        return;
    }

    manualStopRequested = false;
    activeImmediateFillRequestBudget = createImmediateFillActionRequestBudget(
        'immediate-table-fill-action',
    );
    const context = getContext();
    chatHistoryLength = context.chat.length;
    threshold = extension_settings[extensionName]?.batch_filling_threshold
        ?? parseInt(/** @type {HTMLInputElement|null} */ (document.getElementById('batch-filling-threshold'))?.value, 10)
        ?? 30;
    
    const ruleTemplate = getBatchFillerRuleTemplate();
    const flowTemplate = getBatchFillerFlowTemplate();

    if (!ruleTemplate || !flowTemplate) {
        log('规则或流程提示词为空，无法开始填表。', 'error');
        toastr.error('请确保"规则提示词"和"流程提示词"都已填写。', '无法开始');
        return;
    }

    if (chatHistoryLength === 0) {
        log('聊天记录为空，无需填表。', 'info');
        return;
    }

    activeBatchChatScope = captureChatScope(context);
    if (!activeBatchChatScope.chatId) {
        activeBatchChatScope = null;
        log('当前聊天缺少可验证的聊天标识，无法安全开始批量填表。', 'error');
        toastr.error('当前聊天尚未完成初始化，请保存或重新打开聊天后再试。', '无法开始填表');
        return;
    }

    totalBatches = Math.ceil(chatHistoryLength / threshold);
    currentBatch = 0;

    const startFloorInput = document.getElementById('floor-start-input');
    console.log('[Amily2 Debug] startFloorInput found:', !!startFloorInput);
    if (startFloorInput) {
        console.log('[Amily2 Debug] startFloorInput value:', startFloorInput.value);
        const val = parseInt(startFloorInput.value, 10);
        console.log('[Amily2 Debug] Parsed val:', val, 'Threshold:', threshold);
        
        if (!isNaN(val) && val > 1) {
            const startBatch = Math.ceil(val / threshold);
            console.log('[Amily2 Debug] Calculated startBatch:', startBatch);
            currentBatch = startBatch - 1;
            log(`根据设定，将从第 ${startBatch} 批次（包含楼层 ${val}）开始执行。`, 'info');
        } else {
            console.log('[Amily2 Debug] Value is NaN or <= 1');
        }
    } else {
        console.log('[Amily2 Debug] startFloorInput element not found');
    }

    log(`准备开始批量填表任务，共 ${totalBatches} 个批次。`, 'info');
    processNextBatch();
}


export async function startFloorRangeFilling(startFloor, endFloor, options = {}) {
    const runControl = resolveTableFillRunControl(options.runControl, {
        scope: `floor-range-${startFloor}-${endFloor}`,
    });
    const signal = options.signal;
    const settings = extension_settings[extensionName] || {};
    const tableSystemEnabled = settings.table_system_enabled !== false;
    if (!tableSystemEnabled) {
        log('表格系统总开关已关闭，跳过楼层填表。', 'info');
        toastr.info('表格系统总开关已关闭，无法执行楼层填表。');
        return;
    }

    const context = getContext();
    const currentChatLength = context.chat.length;
    const requestScope = captureChatScope(context);

    if (!requestScope.chatId) {
        log('当前聊天缺少可验证的聊天标识，无法安全执行楼层填表。', 'error');
        toastr.error('当前聊天尚未完成初始化，请保存或重新打开聊天后再试。', '无法开始填表');
        return;
    }

    if (endFloor > currentChatLength) {
        toastr.warning(`结束楼层 ${endFloor} 超出了当前聊天记录长度 ${currentChatLength}。`);
        return;
    }

    const ruleTemplate = getBatchFillerRuleTemplate();
    const flowTemplate = getBatchFillerFlowTemplate();

    if (!ruleTemplate || !flowTemplate) {
        log('规则或流程提示词为空，无法开始楼层填表。', 'error');
        toastr.error('请确保"规则提示词"和"流程提示词"都已填写。', '无法开始');
        return;
    }

    try {
        const fillLease = captureTableFillRequestLease(context);
        const fillEvidence = getFillEvidence(context, startFloor, endFloor);
        const persistManualCandidate = createManualFillPersistCandidate(
            fillEvidence,
            requestScope,
        );
        const floorSettings = extension_settings[extensionName] || {};
        const tableBatches = planTableFillBatches(
            fillLease.state,
            floorSettings.table_fill_tables_per_request,
        );
        const splitTablesAcrossRequests = tableBatches.length > 1;
        assertBatchFillerScope(requestScope);
        log(`开始处理楼层 ${startFloor}-${endFloor} 的内容...`, 'info');
        
        const purifiedMessages = getRawMessagesForSummary(startFloor, endFloor, context);
        if (!purifiedMessages || purifiedMessages.length === 0) {
            toastr.warning('指定楼层范围内没有有效内容可处理。');
            return;
        }

        const batchContent = purifiedMessages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');
        const currentTableDataString = convertAiFillableTablesToCsvString();
        const finalFlowPrompt = splitTablesAcrossRequests
            ? buildCacheStableFlowPrompt(flowTemplate)
            : buildFillerFlowPrompt(flowTemplate, currentTableDataString);

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[楼层填表] 加载混合顺序失败:", e);
        }
        const completedOrder = completeFillerPromptOrder(
            getMixedOrder('batch_filler'),
            BATCH_REQUIRED_FILLER_BLOCKS,
        );
        const order = completedOrder.order;
        if (completedOrder.added.length > 0) {
            log(
                `楼层填表提示链缺少必要块，已仅为本次请求补齐：${completedOrder.added.join(', ')}`,
                'warn',
            );
        }

        const presetPrompts = await getPresetPrompts('batch_filler');
        
        const worldBookContext = await getWorldBookContext();

        const seedMessages = createTableFillRandomSeedMessages(
            floorSettings,
            () => runControl.getOrCreateStableSeed(generateRandomSeed),
        );
        const messages = [...seedMessages];

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
                            messages.push({ role: 'system', content: worldBookContext });
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"对话记录"中的内容进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<对话记录>\n${batchContent}\n</对话记录>` });
                        break;
                }
            }
        }

        messages.push({ role: 'system', content: TABLE_FILL_SAFETY_POLICY });

        const tableBatchResult = splitTablesAcrossRequests
            ? await collectTableFillOperationBatches({
                tableState: fillLease.state,
                tableBatches,
                stableMessages: messages,
                settings: floorSettings,
                slot: 'tableFilling',
                signal,
                runControl,
                scope: `floor-range-${startFloor}-${endFloor}`,
                assertContinue: () => assertSignalActive(signal),
                assertLease: () => {
                    assertBatchFillerScope(requestScope);
                    assertTableFillRequestLease(fillLease, getContext());
                },
                callText: async (batchMessages, requestBudget, batchMeta) => {
                    if (batchMeta.fallbackReason) {
                        log(
                            `楼层 ${startFloor}-${endFloor} 的表格子批 `
                            + `${batchMeta.batchIndex + 1}/${batchMeta.batchCount} Tool Call V2 `
                            + `不可用（${batchMeta.fallbackReason}），改用严格文本指令。`,
                            'warn',
                        );
                    }
                    return await callTableModel(
                        batchMessages,
                        fillLease,
                        requestBudget,
                        batchMeta.signal,
                    );
                },
            })
            : null;
        if (tableBatchResult) {
            assertSignalActive(signal);
            assertBatchFillerScope(requestScope);
            assertTableFillRequestLease(fillLease, getContext());
            if (tableBatchResult.operationCount > 0) {
                const applied = await updateTableFromOperationBatches(
                    tableBatchResult.operationBatches,
                    {
                        immediateDelete: true,
                        requestLease: fillLease,
                        onCommitted: () => runControl.markCommitted(),
                        ...fillEvidence,
                        persistCandidate: persistManualCandidate,
                    },
                );
                if (!applied) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        `楼层 ${startFloor}-${endFloor} 的按表拆批结果未通过整轮校验。`,
                    );
                }
                runControl.markCommitted();
            } else {
                const committed = await persistManualCandidate(fillLease.state);
                if (!committed) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        `楼层 ${startFloor}-${endFloor} 的空操作交接标记未能持久化。`,
                    );
                }
                runControl.markCommitted();
            }
            runTableFillPostCommitEffects(
                `floor-${startFloor}-${endFloor}-table-batches`,
                [
                    { label: 'render-tables', run: () => renderTables() },
                    {
                        label: 'notify-success',
                        run: () => toastr.success(
                            `楼层 ${startFloor}-${endFloor} 已按 `
                            + `${tableBatchResult.tableBatches.length} 个表格子批完成。`,
                        ),
                    },
                    {
                        label: 'log-success',
                        run: () => log(
                            `楼层 ${startFloor}-${endFloor} 已按 `
                            + `${tableBatchResult.tableBatches.length} 个表格子批原子完成。`,
                            'success',
                        ),
                    },
                ],
            );
            return;
        }

        console.groupCollapsed(`[Amily2 楼层填表] 楼层 ${startFloor}-${endFloor} - 即将发送至 API 的内容`);
        console.dir(messages);
        console.groupEnd();

        assertTableFillRequestLease(fillLease, getContext());
        assertBatchFillerScope(requestScope);
        const toolResult = floorSettings.tableFillFunctionCall
            ? await requestTableFillOperationsV2(messages, {
                tableState: fillLease.state,
                settings: floorSettings,
                slot: 'tableFilling',
                ...(signal ? { signal } : {}),
                requestBudget: runControl.requestBudget,
                assertLease: () => assertTableFillRequestLease(fillLease, getContext()),
            })
            : null;
        if (toolResult?.mode === TABLE_FILL_TOOL_RESULT.TOOL) {
            const ops = toolResult.operations;
            if (ops.length === 0) {
                assertTableFillRequestLease(fillLease, getContext());
                const committed = await persistManualCandidate(fillLease.state);
                if (!committed) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        `楼层 ${startFloor}-${endFloor} 的空操作交接标记未能持久化。`,
                    );
                }
                runControl.markCommitted();
                runTableFillPostCommitEffects(`floor-${startFloor}-${endFloor}-noop`, [
                    {
                        label: 'log-noop',
                        run: () => log(
                            `楼层 ${startFloor}-${endFloor} 的 Tool Call V2 判断没有可靠的新事实。`,
                            'info',
                        ),
                    },
                    {
                        label: 'notify-noop',
                        run: () => toastr.info(
                            'AI 判断此楼层范围无需修改。',
                            `楼层 ${startFloor}-${endFloor}`,
                        ),
                    },
                ]);
            } else {
                const applied = await updateTableFromOps(ops, {
                    immediateDelete: true,
                    requestLease: fillLease,
                    onCommitted: () => runControl.markCommitted(),
                    ...fillEvidence,
                    persistCandidate: persistManualCandidate,
                });
                if (!applied) {
                    throw createDeterministicTableFillError(
                        'TABLE_FILL_WRITE_REJECTED',
                        'Tool Call V2 操作未产生可提交变更，或表格保存失败。',
                    );
                }
                runControl.markCommitted();
                runTableFillPostCommitEffects(`floor-${startFloor}-${endFloor}-tool`, [
                    { label: 'render-tables', run: () => renderTables() },
                    {
                        label: 'notify-success',
                        run: () => toastr.success(`楼层 ${startFloor}-${endFloor} 填表完成！`),
                    },
                    {
                        label: 'log-success',
                        run: () => log(
                            `楼层 ${startFloor}-${endFloor} Tool Call V2 处理成功（${ops.length} 条操作）。`,
                            'success',
                        ),
                    },
                ]);
            }
        } else {
            if (toolResult?.reason && toolResult.reason !== 'tool-disabled') {
                log(`楼层 ${startFloor}-${endFloor} 的 Tool Call V2 不可用（${toolResult.reason}），改用严格文本指令。`, 'warn');
                toastr.warning('Tool Call V2 当前不可用，已改用严格文本填表。', `楼层 ${startFloor}-${endFloor}`);
            }
            const resultText = await callTableModel(
                messages,
                fillLease,
                runControl.requestBudget,
            );
            console.log(`[Amily2 楼层填表] 楼层 ${startFloor}-${endFloor} - 收到 API 原始回复:`, resultText);
            if (typeof resultText !== 'string' || !resultText.trim()) {
                throw createRetryableResponseError('TABLE_FILL_EMPTY_RESPONSE', 'API返回内容为空。');
            }
            assertBatchFillerScope(requestScope);

            if (!resultText.includes('<Amily2Edit>')) {
                log(`楼层 ${startFloor}-${endFloor} 的响应未包含 <Amily2Edit> 指令块，弹出检查窗口等待用户处理。`, 'warn');
                showTableFillReviewModal(resultText, {
                    title: `填表响应检查 - 楼层 ${startFloor}-${endFloor}`,
                    subtitle: `楼层 ${startFloor}-${endFloor} 的 AI 响应未包含有效的 <Amily2Edit> 指令块。请检查原始响应并选择处理方式。`,
                    onContinue: async (currentText) => {
                        try {
                            assertBatchFillerScope(requestScope);
                        } catch {
                            toastr.warning('聊天已经切换，旧响应不能继续补全。', '已取消操作');
                            return null;
                        }
                        const merged = await requestContinuation(
                            messages,
                            currentText,
                            fillLease,
                            runControl.requestBudget,
                        );
                        if (!merged) { toastr.error('补全请求失败或返回为空。', '继续补全'); return null; }
                        try {
                            assertBatchFillerScope(requestScope);
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
                            assertBatchFillerScope(requestScope);
                            let applied = await commitExplicitManualTextNoop(
                                editedText,
                                fillLease,
                                persistManualCandidate,
                                runControl,
                                `楼层 ${startFloor}-${endFloor}`,
                            );
                            if (!applied) {
                                applied = await updateTableFromText(editedText, {
                                    strictTextResponse: true,
                                    immediateDelete: true,
                                    requestLease: fillLease,
                                    onCommitted: () => runControl.markCommitted(),
                                    ...fillEvidence,
                                    persistCandidate: persistManualCandidate,
                                });
                            }
                            if (!applied) {
                                throw createDeterministicTableFillError(
                                    'TABLE_FILL_WRITE_REJECTED',
                                    '文本未产生可提交变更，或表格保存失败。',
                                );
                            }
                            runControl.markCommitted();
                            runTableFillPostCommitEffects(
                                `floor-${startFloor}-${endFloor}-manual`,
                                [
                                    { label: 'render-tables', run: () => renderTables() },
                                    {
                                        label: 'notify-success',
                                        run: () => toastr.success(
                                            `楼层 ${startFloor}-${endFloor} 填表完成！`,
                                        ),
                                    },
                                    {
                                        label: 'log-success',
                                        run: () => log(
                                            `楼层 ${startFloor}-${endFloor} 填表由用户手动处理完成。`,
                                            'success',
                                        ),
                                    },
                                ],
                            );
                        } catch (err) {
                            if (runControl.committed) {
                                log(
                                    `楼层 ${startFloor}-${endFloor} 已保存，后置界面处理失败: ${err.message}`,
                                    'error',
                                );
                                return;
                            }
                            log(`楼层 ${startFloor}-${endFloor} 手动应用失败: ${err.message}`, 'error');
                            toastr.error(`手动应用失败: ${err.message}`, '写入异常');
                        }
                    },
                    onRetry: () => {
                        try {
                            assertBatchFillerScope(requestScope);
                        } catch {
                            toastr.warning('聊天已经切换，旧楼层范围不会重新执行。', '已取消重试');
                            return;
                        }
                        log(`用户请求重新填写楼层 ${startFloor}-${endFloor}。`, 'warn');
                        setTimeout(() => startFloorRangeFilling(startFloor, endFloor, {
                            runControl: createTableFillRunControl({
                                scope: `floor-range-${startFloor}-${endFloor}-manual-retry`,
                            }),
                        }), 300);
                    },
                    onCancel: () => {
                        log(`用户取消了楼层 ${startFloor}-${endFloor} 的填表。`, 'warn');
                        toastr.info(`已取消楼层 ${startFloor}-${endFloor} 的填表。`);
                    },
                });
                return;
            }

            let applied = await commitExplicitManualTextNoop(
                resultText,
                fillLease,
                persistManualCandidate,
                runControl,
                `楼层 ${startFloor}-${endFloor}`,
            );
            if (!applied) {
                applied = await updateTableFromText(resultText, {
                    strictTextResponse: true,
                    immediateDelete: true,
                    requestLease: fillLease,
                    onCommitted: () => runControl.markCommitted(),
                    ...fillEvidence,
                    persistCandidate: persistManualCandidate,
                });
            }
            if (!applied) {
                throw createDeterministicTableFillError(
                    'TABLE_FILL_WRITE_REJECTED',
                    '文本未产生可提交变更，或表格保存失败。',
                );
            }
            runControl.markCommitted();
            runTableFillPostCommitEffects(`floor-${startFloor}-${endFloor}-text`, [
                { label: 'render-tables', run: () => renderTables() },
                {
                    label: 'notify-success',
                    run: () => toastr.success(`楼层 ${startFloor}-${endFloor} 填表完成！`),
                },
                {
                    label: 'log-success',
                    run: () => log(`楼层 ${startFloor}-${endFloor} 填表处理完成。`, 'success'),
                },
            ]);
        }

    } catch (error) {
        if (runControl.committed) {
            log(
                `楼层 ${startFloor}-${endFloor} 已提交，后置处理失败；已阻止模型重跑: ${error.message}`,
                'error',
            );
            runTableFillPostCommitEffects(`floor-${startFloor}-${endFloor}-committed-error`, [{
                label: 'notify-post-commit-error',
                run: () => toastr.warning(
                    '表格已经保存，但界面刷新失败；请重新打开表格面板查看。',
                    '填表已保存',
                ),
            }]);
            return;
        }
        if (error?.name === 'AbortError' || signal?.aborted) {
            log(`楼层 ${startFloor}-${endFloor} 的填表已在提交前取消。`, 'warn');
            toastr.info('本次楼层填表已取消，未提交任何子批结果。');
            return;
        }
        if (error?.code === 'BATCH_FILLER_STALE_CHAT_CONTEXT'
            || error?.code === 'BATCH_FILLER_MISSING_CHAT_CONTEXT'
            || error?.code === 'TABLE_SYSTEM_STALE_CHAT_CONTEXT'
            || error?.code === 'TABLE_SYSTEM_NO_ACTIVE_CHAT') {
            log(`楼层 ${startFloor}-${endFloor} 因聊天上下文已变化而停止：${error.message}`, 'warn');
            toastr.warning('聊天已经切换，旧聊天的填表结果已丢弃。', '填表已停止');
            return;
        }
        if (error?.code === 'TABLE_SYSTEM_SNAPSHOT_MISMATCH') {
            log(`楼层 ${startFloor}-${endFloor} 保存后检测到本地快照变化，已停止以避免重复写入。`, 'error');
            toastr.warning('服务器可能已经保存本次结果。请重新打开聊天确认，系统不会自动重试。', '需要重新载入');
            return;
        }
        if (isTableFillRequestLeaseError(error)) {
            log(`楼层 ${startFloor}-${endFloor} 的聊天或表格请求租约已失效，过期结果已丢弃。`, 'warn');
            toastr.warning('聊天或表格已变化，本次楼层填表结果已安全丢弃。', '处理停止');
            return;
        }
        const normalizedError = normalizeTableFillInferenceError(error);
        log(`楼层 ${startFloor}-${endFloor} 填表失败: ${normalizedError.message}`, 'error');
        toastr.error(`楼层填表失败: ${normalizedError.message}`, '处理失败');
    }
}


export async function startCurrentFloorFilling() {
    const context = getContext();
    const currentFloor = context.chat.length;
    
    if (currentFloor === 0) {
        toastr.info('当前没有聊天记录。');
        return;
    }
    
    log(`准备填写当前楼层（第 ${currentFloor} 楼）...`, 'info');
    await startFloorRangeFilling(currentFloor, currentFloor);
}
