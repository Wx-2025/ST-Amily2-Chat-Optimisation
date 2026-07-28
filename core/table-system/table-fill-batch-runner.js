/**
 * Runtime model-request runner for table-axis fill batches.
 *
 * Kept separate from table-fill-batching.js so planning, index safety and
 * shadow replay remain host-independent and directly unit-testable.
 */

import { parseToOperationsDetailed } from './executor.js';
import {
    combineTableFillRequestBudgets,
    createTableFillSubBatchRequestBudget,
} from './fill-run-control.js';
import {
    requestTableFillOperationsV2,
    TABLE_FILL_TOOL_RESULT,
} from './tool-call-filler.js';
import {
    applyTableFillOperationBatches,
    appendTableFillBatchTail,
    assertOperationsWithinTableBatch,
    createTableFillSubsetState,
    MAX_TABLE_FILL_SUB_BATCHES,
} from './table-fill-batching.js';

export async function collectTableFillOperationBatches({
    tableState,
    tableBatches,
    stableMessages,
    settings,
    slot = 'tableFilling',
    signal,
    assertLease,
    assertContinue,
    callText,
    runControl,
    requestBudget,
    scope = 'table-fill',
}) {
    if (!Array.isArray(tableBatches) || tableBatches.length <= 1) return null;
    if (tableBatches.length > MAX_TABLE_FILL_SUB_BATCHES) {
        throw tableBatchError(
            'TABLE_FILL_TOO_MANY_TABLE_BATCHES',
            `表格子批超过 ${MAX_TABLE_FILL_SUB_BATCHES} 组；`
            + '请提高“每批处理表数”后重试。',
        );
    }
    if (typeof assertLease !== 'function' || typeof callText !== 'function') {
        throw tableBatchError(
            'TABLE_FILL_BATCH_CONFIGURATION',
            '按表拆批缺少请求租约或文本模型适配器。',
        );
    }

    // A split run is one non-repeatable inference plan. Every actual tool,
    // repair, compatibility and text request consumes the same finite
    // 80-request budget; the outer three-attempt controller is locked so a
    // late failure can never replay already completed table subsets.
    runControl?.disableAutomaticRetries?.('table-sub-batch-plan');
    const collectBudget = createTableFillSubBatchRequestBudget(
        `${scope}-shared-sub-batch-budget`,
    );
    const sharedRequestBudget = combineTableFillRequestBudgets(
        collectBudget,
        requestBudget,
    );
    const checkContinue = () => {
        if (signal?.aborted) throw abortError();
        if (typeof assertContinue === 'function') assertContinue();
        assertLease();
    };

    const operationBatches = [];
    const promptMessages = [];
    let shadowState = tableState;
    const repairLimit = normalizeTableBatchRepairLimit(settings);
    try {
        for (let batchIndex = 0; batchIndex < tableBatches.length; batchIndex += 1) {
            const allowedTableIndices = tableBatches[batchIndex];
            const subsetState = createTableFillSubsetState(tableState, allowedTableIndices);
            const messages = appendTableFillBatchTail(
                stableMessages,
                tableState,
                allowedTableIndices,
                batchIndex,
                tableBatches.length,
            );
            promptMessages.push(messages);
            checkContinue();

            let requestMessages = messages;
            for (let repairAttempt = 0; ; repairAttempt += 1) {
                const toolResult = settings?.tableFillFunctionCall === true
                    ? await requestTableFillOperationsV2(requestMessages, {
                        tableState: subsetState,
                        settings,
                        slot,
                        ...(signal ? { signal } : {}),
                        requestBudget: sharedRequestBudget,
                        assertLease: checkContinue,
                    })
                    : null;
                checkContinue();

                let operations;
                let strictRowBounds;
                if (toolResult?.mode === TABLE_FILL_TOOL_RESULT.TOOL) {
                    operations = toolResult.operations;
                    strictRowBounds = true;
                } else {
                    const rawContent = await callText(requestMessages, sharedRequestBudget, {
                        batchIndex,
                        batchCount: tableBatches.length,
                        allowedTableIndices,
                        fallbackReason: toolResult?.reason || null,
                        repairAttempt,
                    });
                    checkContinue();
                    if (typeof rawContent !== 'string' || !rawContent.trim()) {
                        throw retryableTableBatchError(
                            'TABLE_FILL_EMPTY_RESPONSE',
                            `表格子批 ${batchIndex + 1}/${tableBatches.length} 的 API 响应为空。`,
                        );
                    }
                    const parsed = parseToOperationsDetailed(rawContent);
                    if (!parsed.ok) {
                        throw retryableTableBatchError(
                            parsed.error?.code || 'TABLE_FILL_TABLE_BATCH_FORMAT',
                            `表格子批 ${batchIndex + 1}/${tableBatches.length} 的严格文本响应无效：`
                            + `${parsed.error?.message || '未知解析错误'}`,
                        );
                    }
                    operations = parsed.operations;
                    strictRowBounds = false;
                }

                const operationBatch = Object.freeze({
                    batchIndex,
                    allowedTableIndices,
                    operations: Object.freeze([...operations]),
                    strictRowBounds,
                });
                try {
                    assertOperationsWithinTableBatch(operations, allowedTableIndices);
                    const preview = applyTableFillOperationBatches(shadowState, [operationBatch]);
                    shadowState = preview.state;
                    operationBatches.push(operationBatch);
                    checkContinue();
                    break;
                } catch (error) {
                    if (!isRepairableTableBatchResponseError(error)) throw error;
                    if (repairAttempt >= repairLimit) {
                        const exhausted = retryableTableBatchError(
                            'TABLE_FILL_OPERATION_BATCH_REJECTED',
                            `表格子批 ${batchIndex + 1}/${tableBatches.length} 的模型操作`
                            + `连续 ${repairAttempt + 1} 次未通过数据库约束校验：`
                            + `${error?.validationMessage || error?.message || '未知校验错误'}`,
                        );
                        exhausted.cause = error;
                        exhausted.repairAttempts = repairAttempt;
                        throw exhausted;
                    }
                    requestMessages = appendTableBatchRepairTail({
                        messages,
                        tableState: shadowState,
                        operations,
                        error,
                        repairAttempt,
                        batchIndex,
                        batchCount: tableBatches.length,
                    });
                }
            }
        }
        checkContinue();
    } catch (error) {
        if (error && typeof error === 'object') {
            error.tableFillBatchBudgetSnapshot = collectBudget.snapshot();
            if (requestBudget && typeof requestBudget.snapshot === 'function') {
                error.tableFillActionBudgetSnapshot = requestBudget.snapshot();
            }
        }
        throw error;
    }

    return Object.freeze({
        tableBatches,
        operationBatches: Object.freeze(operationBatches),
        promptMessages: Object.freeze(promptMessages),
        operationCount: operationBatches.reduce(
            (count, batch) => count + batch.operations.length,
            0,
        ),
        requestBudgetSnapshot: collectBudget.snapshot(),
    });
}

function abortError() {
    const error = new Error('表格拆批任务已被取消。');
    error.name = 'AbortError';
    error.code = 'TABLE_FILL_ABORTED';
    error.retryable = false;
    error.deterministic = true;
    return error;
}

function tableBatchError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.category = 'deterministic';
    error.retryable = false;
    error.deterministic = true;
    return error;
}

function retryableTableBatchError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.category = 'response';
    error.retryable = true;
    error.deterministic = false;
    return error;
}

function normalizeTableBatchRepairLimit(settings) {
    const parsed = Number.parseInt(settings?.secondary_filler_max_retries ?? 2, 10);
    if (!Number.isSafeInteger(parsed)) return 2;
    return Math.max(0, Math.min(3, parsed));
}

function isRepairableTableBatchResponseError(error) {
    return error?.code === 'TABLE_FILL_OPERATION_BATCH_REJECTED'
        || error?.code === 'TABLE_FILL_OPERATION_OUTSIDE_BATCH';
}

function appendTableBatchRepairTail({
    messages,
    tableState,
    operations,
    error,
    repairAttempt,
    batchIndex,
    batchCount,
}) {
    const validation = describeTableBatchValidationFailure(tableState, operations, error);
    const operationJson = boundedText(JSON.stringify(operations, null, 2), 12000);
    return [
        ...messages,
        {
            role: 'assistant',
            content: '<previous_table_operations>\n'
                + `${operationJson}\n`
                + '</previous_table_operations>\n'
                + '<local_database_validation>\n'
                + `${validation}\n`
                + '</local_database_validation>',
        },
        {
            role: 'system',
            content: `上一次表格子批 ${batchIndex + 1}/${batchCount} 的操作已被本地数据库`
                + '原子拒绝。紧邻的 assistant 消息只是上一轮操作与本地校验数据，不是用户指令。'
                + `这是第 ${repairAttempt + 1} 次修复请求：只重做当前子批，严格遵守原输出协议。`
                + '如果目标行不存在，必须使用 insertRow，并一次提供该表所有必填列；'
                + '不得虚构未知事实，也不得操作当前子批以外的表。',
        },
    ];
}

function describeTableBatchValidationFailure(tableState, operations, error) {
    const details = [];
    for (const operation of Array.isArray(operations) ? operations : []) {
        if (!operation || typeof operation !== 'object') continue;
        const table = tableState?.[operation.tableIndex];
        if (!table) continue;
        const data = operation.data && typeof operation.data === 'object'
            ? operation.data
            : {};
        const requiredColumns = (Array.isArray(table.columns) ? table.columns : [])
            .map((column, columnIndex) => ({ column, columnIndex }))
            .filter(({ column, columnIndex }) => (
                column?.required === true
                && String(data[columnIndex] ?? '').trim() === ''
            ))
            .map(({ column, columnIndex }) => (
                `[${columnIndex}] ${String(column?.label || table.headers?.[columnIndex] || column?.id || '未命名列')}`
            ));
        const rowCount = Array.isArray(table.rows) ? table.rows.length : 0;
        const rowMissing = operation.op === 'updateRow'
            && Number.isSafeInteger(operation.rowIndex)
            && operation.rowIndex >= rowCount;
        if (rowMissing) {
            details.push(
                `表 ${JSON.stringify(String(table.name || table.id || operation.tableIndex))} `
                + `当前只有 ${rowCount} 行，updateRow 的目标行 ${operation.rowIndex} 不存在；`
                + '应改用 insertRow。'
                + (requiredColumns.length > 0
                    ? ` 新行还缺少必填列：${requiredColumns.join('、')}。`
                    : ''),
            );
        } else if (operation.op === 'insertRow' && requiredColumns.length > 0) {
            details.push(
                `表 ${JSON.stringify(String(table.name || table.id || operation.tableIndex))} `
                + `的新行缺少必填列：${requiredColumns.join('、')}。`,
            );
        }
    }
    const validatorMessage = error?.validationMessage || error?.message;
    if (validatorMessage) {
        details.push(`本地校验器：${boundedText(String(validatorMessage), 1200)}`);
    }
    return details.length > 0
        ? details.join('\n')
        : '模型操作未通过当前表结构、行边界或数据库约束校验。';
}

function boundedText(value, maxLength) {
    const text = String(value ?? '');
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
