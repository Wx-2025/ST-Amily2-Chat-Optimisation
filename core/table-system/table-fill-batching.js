/**
 * Table-axis batching for model-driven filling.
 *
 * A logical fill may contain many tables but only one immutable source chat
 * and table snapshot.  This module splits the AI-fillable tables without
 * renumbering them, builds a cache-friendly prompt tail, and validates every
 * returned operation against the exact subset that was exposed.
 */

import { applyOperations } from './actions/applyOperations.js';
import { isAiFillableTable, assertAiFillOperationTargets } from './module-tables.js';
import { tablesToCsvForAiFill } from './rendering.js';

export const MAX_TABLE_FILL_TABLES_PER_REQUEST = 128;
export const MAX_TABLE_FILL_SUB_BATCHES = 16;

const TABLE_DATA_PLACEHOLDER = '{{{Amily2TableData}}}';
const DEFERRED_TABLE_DATA_NOTICE = [
    '<当前表格数据>',
    '当前请求启用了按表拆批；本批允许处理的完整表格快照位于消息链末尾。',
    '只能修改末尾列出的表格，未列出的表格不属于本批任务。',
    '</当前表格数据>',
].join('\n');

export function normalizeTablesPerFillRequest(value) {
    let parsed;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
        parsed = Number(value.trim());
    } else {
        return 0;
    }
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0;
    return Math.min(parsed, MAX_TABLE_FILL_TABLES_PER_REQUEST);
}

export function planTableFillBatches(tableState, configuredSize) {
    if (!Array.isArray(tableState)) return Object.freeze([]);
    const tableIndices = tableState
        .map((table, tableIndex) => (isAiFillableTable(table) ? tableIndex : null))
        .filter(Number.isSafeInteger);
    if (tableIndices.length === 0) return Object.freeze([]);

    const normalizedSize = normalizeTablesPerFillRequest(configuredSize);
    // Zero is the explicit compatibility mode. Do not build or validate the
    // new relation/sub-batch plan at all, otherwise a large legacy schema can
    // be rejected by limits that did not exist before v2.3.2.
    if (normalizedSize === 0 || tableIndices.length <= normalizedSize) {
        return Object.freeze([Object.freeze(tableIndices)]);
    }

    const relationGroups = buildRelationGroups(tableState, tableIndices);
    const oversizedGroup = relationGroups.find(group => (
        group.length > MAX_TABLE_FILL_TABLES_PER_REQUEST
    ));
    if (oversizedGroup) {
        throw tableBatchError(
            'TABLE_FILL_RELATION_GROUP_TOO_LARGE',
            `一个外键连通表组包含 ${oversizedGroup.length} 张用户表，`
            + `超过单次安全上限 ${MAX_TABLE_FILL_TABLES_PER_REQUEST}；该关系组不会被强行拆开。`,
        );
    }

    const batches = [];
    let currentBatch = [];
    for (const relationGroup of relationGroups) {
        if (
            currentBatch.length > 0
            && currentBatch.length + relationGroup.length > normalizedSize
        ) {
            batches.push(Object.freeze(
                [...currentBatch].sort((left, right) => left - right),
            ));
            currentBatch = [];
        }
        currentBatch.push(...relationGroup);
    }
    if (currentBatch.length > 0) {
        batches.push(Object.freeze(
            [...currentBatch].sort((left, right) => left - right),
        ));
    }
    if (batches.length > MAX_TABLE_FILL_SUB_BATCHES) {
        throw tableBatchError(
            'TABLE_FILL_TOO_MANY_TABLE_BATCHES',
            `当前配置会产生 ${batches.length} 个表格子批，超过安全上限 `
            + `${MAX_TABLE_FILL_SUB_BATCHES}；请提高“每批处理表数”后重试。`,
        );
    }
    return Object.freeze(batches);
}

function buildRelationGroups(tableState, tableIndices) {
    const allowed = new Set(tableIndices);
    const tableIndexById = new Map(
        tableIndices.map(tableIndex => [tableState[tableIndex]?.id, tableIndex]),
    );
    const parent = new Map(tableIndices.map(tableIndex => [tableIndex, tableIndex]));

    const find = (value) => {
        let root = value;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(value) !== value) {
            const next = parent.get(value);
            parent.set(value, root);
            value = next;
        }
        return root;
    };
    const unite = (left, right) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };

    for (const sourceIndex of tableIndices) {
        const columns = Array.isArray(tableState[sourceIndex]?.columns)
            ? tableState[sourceIndex].columns
            : [];
        for (const column of columns) {
            const targetIndex = tableIndexById.get(column?.references?.tableId);
            if (allowed.has(targetIndex)) unite(sourceIndex, targetIndex);
        }
    }

    const groups = new Map();
    for (const tableIndex of tableIndices) {
        const root = find(tableIndex);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(tableIndex);
    }
    return [...groups.values()]
        .map(group => group.sort((left, right) => left - right))
        .sort((left, right) => left[0] - right[0]);
}

/**
 * Return a sparse state whose array indexes are still the runtime tableIndex.
 * Array#map/filter used by the Tool V2 catalog and CSV renderer skip holes, so
 * hidden tables are neither exposed nor accidentally renumbered.
 */
export function createTableFillSubsetState(tableState, allowedTableIndices) {
    if (!Array.isArray(tableState)) {
        throw tableBatchError('TABLE_FILL_INVALID_STATE', '表格快照无效，无法创建表格子批。');
    }
    const subset = new Array(tableState.length);
    for (const tableIndex of normalizeAllowedIndices(allowedTableIndices, tableState.length)) {
        const table = tableState[tableIndex];
        if (!isAiFillableTable(table)) {
            throw tableBatchError(
                'TABLE_FILL_FORBIDDEN_TABLE_BATCH',
                `表格子批包含不可由 AI 填写的表格索引 ${tableIndex}。`,
            );
        }
        subset[tableIndex] = table;
    }
    return Object.freeze(subset);
}

export function buildCacheStableFlowPrompt(flowTemplate) {
    const template = String(flowTemplate ?? '');
    if (template.includes(TABLE_DATA_PLACEHOLDER)) {
        return template.split(TABLE_DATA_PLACEHOLDER).join(DEFERRED_TABLE_DATA_NOTICE);
    }
    return template.trim();
}

export function appendTableFillBatchTail(
    stableMessages,
    tableState,
    allowedTableIndices,
    batchIndex,
    batchCount,
) {
    const subsetState = createTableFillSubsetState(tableState, allowedTableIndices);
    const snapshot = tablesToCsvForAiFill(subsetState);
    const ordinal = Number.isSafeInteger(batchIndex) ? batchIndex + 1 : 1;
    const total = Number.isSafeInteger(batchCount) && batchCount > 0 ? batchCount : 1;
    const indexes = [...allowedTableIndices].join(', ');
    const tail = {
        role: 'system',
        content: [
            `# 当前表格子批 ${ordinal}/${total}`,
            `允许修改的原始 tableIndex：${indexes}`,
            '以下是本批唯一可读取、可操作的表格。不得猜测或修改未列出的表格。',
            '<当前表格数据>',
            snapshot,
            '</当前表格数据>',
        ].join('\n'),
    };
    return [...stableMessages, tail];
}

export function assertOperationsWithinTableBatch(operations, allowedTableIndices) {
    if (!Array.isArray(operations)) {
        throw tableBatchError('TABLE_FILL_INVALID_OPERATION_BATCH', '表格操作批次不是数组。');
    }
    const allowed = new Set(allowedTableIndices);
    for (let index = 0; index < operations.length; index += 1) {
        const tableIndex = operations[index]?.tableIndex;
        if (!Number.isSafeInteger(tableIndex) || !allowed.has(tableIndex)) {
            throw tableBatchError(
                'TABLE_FILL_OPERATION_OUTSIDE_BATCH',
                `第 ${index + 1} 条操作指向未在本子批公开的表格索引 ${String(tableIndex)}。`,
            );
        }
    }
    return true;
}

/**
 * Apply all model responses to a shadow state.  Nothing is published or
 * persisted here; one invalid later batch rejects the whole logical run.
 */
export function applyTableFillOperationBatches(initialState, operationBatches) {
    if (!Array.isArray(initialState)) {
        throw tableBatchError('TABLE_FILL_INVALID_STATE', '表格快照无效，无法推演填表子批。');
    }
    if (!Array.isArray(operationBatches)) {
        throw tableBatchError('TABLE_FILL_INVALID_OPERATION_BATCH', '填表子批列表无效。');
    }

    let state = initialState;
    const changes = [];
    const operations = [];
    for (const batch of operationBatches) {
        const batchOperations = Array.isArray(batch?.operations) ? batch.operations : null;
        if (!batchOperations) {
            throw tableBatchError('TABLE_FILL_INVALID_OPERATION_BATCH', '某个填表子批缺少操作数组。');
        }
        assertOperationsWithinTableBatch(batchOperations, batch.allowedTableIndices || []);
        assertAiFillOperationTargets(state, batchOperations);
        if (batchOperations.length === 0) continue;
        const applied = applyOperations(state, batchOperations, {
            strictRowBounds: batch.strictRowBounds === true,
        });
        if (applied.accepted !== true) {
            const error = tableBatchError(
                'TABLE_FILL_OPERATION_BATCH_REJECTED',
                `表格子批 ${String(batch?.batchIndex ?? '?')} 的操作未通过数据库推演校验。`,
            );
            if (applied.error) {
                error.cause = applied.error;
                error.validationCode = applied.error.code || 'TABLE_VALIDATION_FAILED';
                error.validationMessage = applied.error.message || String(applied.error);
            }
            throw error;
        }
        state = applied.state;
        changes.push(...applied.changes);
        operations.push(...batchOperations);
    }
    return { state, changes, operations, accepted: true };
}

function normalizeAllowedIndices(value, stateLength) {
    if (!Array.isArray(value)) {
        throw tableBatchError('TABLE_FILL_INVALID_TABLE_BATCH', '表格子批索引列表无效。');
    }
    const seen = new Set();
    const indices = [];
    for (const tableIndex of value) {
        if (!Number.isSafeInteger(tableIndex)
            || tableIndex < 0
            || tableIndex >= stateLength
            || seen.has(tableIndex)) {
            throw tableBatchError(
                'TABLE_FILL_INVALID_TABLE_BATCH',
                `表格子批含无效或重复索引 ${String(tableIndex)}。`,
            );
        }
        seen.add(tableIndex);
        indices.push(tableIndex);
    }
    return indices;
}

function tableBatchError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.category = 'deterministic';
    error.retryable = false;
    error.deterministic = true;
    return error;
}
