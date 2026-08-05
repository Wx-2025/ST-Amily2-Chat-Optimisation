/**
 * @file actions/ui-mutations.js —— 19 个 UI 突变（Phase 0.4 自 manager.js 搬出）
 *
 * 表格面板上的所有用户操作入口：增删行列 / 移动 / 重命名 / 规则更新 / 清空等。
 * 函数签名与行为与搬出前完全一致；manager.js re-export 这些函数，外部调用路径零改动。
 *
 * 依赖说明：
 *   - 状态读写走 infra/store.js，持久化走 infra/persistence.js
 *   - SuperMemory 分发走 events-dispatch.js（与 manager 共用，无环）
 *   - loadTables 仍从 manager 引入（addTable 空状态兜底），
 *     manager ↔ ui-mutations 构成 ESM 循环，但二者均为 hoisted 函数声明、
 *     仅在运行时调用，与既有 manager ↔ ui/table-bindings 环同模式，安全
 */

import { getContext } from '/scripts/extensions.js';
import { log } from '../logger.js';
import { updateRenderedTableRowStatus } from '../../../ui/table-bindings.js';
import { dispatchTableUpdate, dispatchAllTablesUpdate } from '../events-dispatch.js';
import { loadTables, setMemoryState } from '../manager.js';

import {
    getState,
    getStateRevision,
    addHighlight,
    markTableUpdated,
    getUpdatedTables,
} from '../infra/store.js';

import {
    commitToLastMessage,
    commitToLastMessageAsync,
} from '../infra/persistence.js';
import {
    createRecordMetadata,
    deepClone,
    normalizeTableDatabaseState,
    normalizeTableIdentity,
} from '../infra/database-state.js';
import { applyPendingRecordDeletions, validateTableState } from '../module-tables.js';
import { captureChatScope, chatScopesMatch } from '../infra/chat-scope.js';
import { CURRENT_TABLE_FILL_PROTOCOL_VERSION } from '../table-fill-protocol.js';
import { createRowStatusCandidate } from './row-status-candidate.js';

const ROW_STATUS_PERSIST_DELAY_MS = 75;
let rowStatusPersistenceTimer = null;
let rowStatusPersistenceSequence = 0;

function createMutationDraft() {
    const current = getState();
    return Array.isArray(current) ? deepClone(current) : null;
}

function assertStructureEditable(table, action) {
    if (table?.owner && table.owner !== 'user') {
        const error = new Error(`模块表“${table.name || table.id}”的固定结构不能通过普通表格界面${action}。`);
        error.code = 'TABLE_STRUCTURE_LOCKED';
        throw error;
    }
}

function acceptMutation(draft, action, { persist = true } = {}) {
    const previous = Array.isArray(getState()) ? deepClone(getState()) : null;
    let applied = false;
    try {
        const validated = validateTableState(draft);
        setMemoryState(validated);
        applied = true;
        if (persist && !commitToLastMessage(validated)) {
            throw Object.assign(new Error('当前聊天状态无法持久化。'), { code: 'TABLE_PERSIST_FAILED' });
        }
        if (persist) cancelScheduledRowStatusPersistence();
        return validated;
    } catch (error) {
        if (applied) setMemoryState(previous);
        log(`${action}失败，变更已回退: ${error.code || 'TABLE_VALIDATION_FAILED'} ${error.message}`, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, `${action}失败`);
        return null;
    }
}

function cancelScheduledRowStatusPersistence() {
    rowStatusPersistenceSequence += 1;
    if (rowStatusPersistenceTimer !== null) {
        clearTimeout(rowStatusPersistenceTimer);
        rowStatusPersistenceTimer = null;
    }
}

function scheduleRowStatusPersistence() {
    const sequence = ++rowStatusPersistenceSequence;
    const expectedScope = captureChatScope(getContext());
    if (rowStatusPersistenceTimer !== null) clearTimeout(rowStatusPersistenceTimer);
    rowStatusPersistenceTimer = setTimeout(() => {
        rowStatusPersistenceTimer = null;
        void persistLatestRowStatusSnapshot(sequence, expectedScope);
    }, ROW_STATUS_PERSIST_DELAY_MS);
}

async function persistLatestRowStatusSnapshot(sequence, expectedScope) {
    if (sequence !== rowStatusPersistenceSequence
        || !chatScopesMatch(expectedScope, captureChatScope(getContext()))) {
        return;
    }

    const state = getState();
    if (!Array.isArray(state)) return;
    const expectedStateRevision = getStateRevision();
    const transaction = { expectedStateRevision };
    if (expectedScope?.chatId) {
        transaction.expectedChatId = expectedScope.chatId;
        transaction.expectedChatScope = expectedScope;
    }

    let committed = false;
    try {
        committed = await commitToLastMessageAsync(state, undefined, transaction);
    } catch (error) {
        log(`删除状态后台保存失败: ${error.code || 'TABLE_PERSIST_FAILED'} ${error.message}`, 'error');
    }

    const stillLatest = sequence === rowStatusPersistenceSequence
        && getStateRevision() === expectedStateRevision
        && chatScopesMatch(expectedScope, captureChatScope(getContext()));
    if (!committed && stillLatest) {
        log('删除状态尚未持久化；数据没有被永久删除，后续表格提交会再次保存当前状态。', 'warn');
        if (typeof toastr !== 'undefined') {
            toastr.warning('删除标记暂未保存，原记录仍然安全。', '表格保存延迟');
        }
    }
}

function applyRowStatusMutation(tableIndex, rowIndex, nextStatus, action) {
    const mutation = createRowStatusCandidate(getState(), tableIndex, rowIndex, nextStatus);
    if (!mutation || !mutation.changed) return false;

    try {
        setMemoryState(mutation.state);
    } catch (error) {
        log(`${action}失败: ${error.code || 'TABLE_STATE_UPDATE_FAILED'} ${error.message}`, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, `${action}失败`);
        return false;
    }

    markTableUpdated(tableIndex);
    updateRenderedTableRowStatus(tableIndex, rowIndex);
    dispatchTableUpdate(tableIndex);
    scheduleRowStatusPersistence();
    return mutation.table;
}

export function deleteColumn(tableIndex, colIndex) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex] || colIndex < 0 || colIndex >= tables[tableIndex].headers.length) {
        log(`删除列失败：在表格 ${tableIndex} 中找不到索引为 ${colIndex} 的列。`, 'error');
        return;
    }

    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '删除列');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '删除列失败');
        return;
    }
    table.headers.splice(colIndex, 1);
    table.rows.forEach(row => {
        if (row.length > colIndex) row.splice(colIndex, 1);
    });
    if (table.columnWidths && table.columnWidths.length > colIndex) {
        table.columnWidths.splice(colIndex, 1);
    }
    table.columns.splice(colIndex, 1);

    if (!acceptMutation(tables, '删除列')) return;
    log(`成功删除了表格 ${tableIndex} 的第 ${colIndex + 1} 列。`, 'success');
    dispatchTableUpdate(tableIndex);
}

export function moveRow(tableIndex, rowIndex, direction) {
    const tables = createMutationDraft();
    const table = tables?.[tableIndex] && normalizeTableIdentity(tables[tableIndex], tableIndex);
    if (!table || rowIndex < 0 || rowIndex >= table.rows.length) return;

    const newIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
    if (newIndex < 0 || newIndex >= table.rows.length) return;

    const [movedRow] = table.rows.splice(rowIndex, 1);
    table.rows.splice(newIndex, 0, movedRow);

    if (table.rowStatuses && table.rowStatuses.length === table.rows.length) {
        const [movedStatus] = table.rowStatuses.splice(rowIndex, 1);
        table.rowStatuses.splice(newIndex, 0, movedStatus);
    }
    const [movedMeta] = table.rowMeta.splice(rowIndex, 1);
    table.rowMeta.splice(newIndex, 0, movedMeta);

    if (!acceptMutation(tables, '移动行')) return;
    log(`成功将表格 ${tableIndex} 的第 ${rowIndex + 1} 行移动到第 ${newIndex + 1} 行。`, 'success');
    dispatchTableUpdate(tableIndex);
}

export function insertRow(tableIndex, data, position = 'below') {
    const tables = createMutationDraft();
    const table = tables?.[tableIndex] && normalizeTableIdentity(tables[tableIndex], tableIndex);
    if (!table) {
        log(`插入行失败：找不到索引为 ${tableIndex} 的表格。`, 'error');
        return;
    }

    let insertIndex;
    if (typeof data === 'number') {
        insertIndex = position === 'above' ? data : data + 1;
    } else {
        insertIndex = table.rows.length;
    }
    if (insertIndex < 0) insertIndex = 0;
    if (insertIndex > table.rows.length) insertIndex = table.rows.length;

    const newRow = new Array(table.headers.length).fill('');

    if (typeof data === 'object' && data !== null) {
        for (const colIndex in data) {
            const cIndex = parseInt(colIndex, 10);
            if (!isNaN(cIndex) && cIndex < newRow.length) {
                newRow[cIndex] = data[colIndex];
            }
        }
    }

    table.rows.splice(insertIndex, 0, newRow);
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.splice(insertIndex, 0, 'normal');
    table.rowMeta.splice(insertIndex, 0, createRecordMetadata(table, newRow, insertIndex));

    if (!acceptMutation(tables, '插入行')) return;
    if (typeof data === 'object' && data !== null) {
        Object.keys(data).forEach(colIndex => {
            const parsed = Number.parseInt(colIndex, 10);
            if (Number.isInteger(parsed) && parsed >= 0 && parsed < newRow.length) {
                addHighlight(tableIndex, insertIndex, parsed);
            }
        });
    }
    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`成功在表格 ${table.name} (索引 ${tableIndex}) 的第 ${insertIndex + 1} 行位置插入了新行。`, 'success');
}

export function addRow(tableIndex) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    const colCount = table.headers.length;
    const newRow = Array(colCount).fill('');
    table.rows.push(newRow);
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.push('normal');
    table.rowMeta.push(createRecordMetadata(table, newRow, table.rows.length - 1));
    if (!acceptMutation(tables, '新增行')) return;
    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`表格 [${table.name}] 新增了一行。`, 'info');

}

export function addColumn(tableIndex) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '新增列');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '新增列失败');
        return;
    }
    const newHeader = `新列 ${table.headers.length + 1}`;
    table.headers.push(newHeader);
    table.rows.forEach(row => row.push(''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.push(null);
    table.columns.push({ id: `column-${globalThis.crypto?.randomUUID?.() || Date.now()}`, label: newHeader, type: 'string' });
    if (!acceptMutation(tables, '新增列')) return;
    log(`表格 [${table.name}] 新增了一列。`, 'info');
}

export function updateHeader(tableIndex, colIndex, value) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex] || tables[tableIndex].headers[colIndex] === undefined) return;
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '修改列名');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '修改列名失败');
        return;
    }
    const tableName = table.name;
    const originalHeader = table.headers[colIndex];
    table.headers[colIndex] = value;
    table.columns[colIndex].label = value;
    if (!acceptMutation(tables, '修改列名')) return;
    log(`表格 [${tableName}] 的表头“${originalHeader}”已更新为“${value}”。`, 'info');
}

export async function deleteRow(tableIndex, rowIndex) {
    const table = applyRowStatusMutation(
        tableIndex,
        rowIndex,
        'pending-deletion',
        '标记删除行',
    );
    if (!table) return false;
    log(`表格 [${table.name}] 的第 ${rowIndex + 1} 行已标记为待删除。`, 'info');
    return true;
}

export async function restoreRow(tableIndex, rowIndex) {
    const table = applyRowStatusMutation(tableIndex, rowIndex, 'normal', '恢复行');
    if (!table) return false;
    log(`表格 [${table.name}] 的第 ${rowIndex + 1} 行已恢复。`, 'info');
    return true;
}

export function commitPendingDeletions() {
    const tables = createMutationDraft();
    if (!tables) return false;
    let result;
    try {
        result = applyPendingRecordDeletions(tables);
    } catch (error) {
        log(`提交删除行失败，整批变更已回退: ${error.code || 'TABLE_VALIDATION_FAILED'} ${error.message}`, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '提交删除行失败');
        return false;
    }

    if (result.deletedCount > 0) {
        if (!acceptMutation(result.state, '提交删除行', { persist: false })) return false;
        result.affectedTableIndices.forEach(tableIndex => markTableUpdated(tableIndex));
        log(`已提交并永久删除了 ${result.deletedCount} 行。`, 'info');
        const updated = getUpdatedTables();
        if (updated.size > 0) {
            updated.forEach(tableIndex => dispatchTableUpdate(tableIndex));
        }
        return true;
    }
    return false;
}

export function insertColumn(tableIndex, colIndex, position) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '插入列');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '插入列失败');
        return;
    }

    const insertAt = position === 'left' ? colIndex : colIndex + 1;
    table.headers.splice(insertAt, 0, '新列');
    table.rows.forEach(row => row.splice(insertAt, 0, ''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.splice(insertAt, 0, null);
    table.columns.splice(insertAt, 0, { id: `column-${globalThis.crypto?.randomUUID?.() || Date.now()}`, label: '新列', type: 'string' });

    if (!acceptMutation(tables, '插入列')) return;
    log(`表格 [${table.name}] 在第 ${colIndex + 1} 列的${position === 'left' ? '左侧' : '右侧'}插入了新列。`, 'info');
}

export function moveColumn(tableIndex, colIndex, direction) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '移动列');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '移动列失败');
        return;
    }
    const headers = table.headers;
    const rows = table.rows;

    const targetIndex = direction === 'left' ? colIndex - 1 : colIndex + 1;
    if (targetIndex < 0 || targetIndex >= headers.length) {
        log(`无法移动列：索引 ${colIndex} 已在边界。`, 'warn');
        return;
    }

    const [headerToMove] = headers.splice(colIndex, 1);
    headers.splice(targetIndex, 0, headerToMove);

    rows.forEach(row => {
        const [cellToMove] = row.splice(colIndex, 1);
        row.splice(targetIndex, 0, cellToMove);
    });

    if (table.columnWidths && table.columnWidths.length > colIndex) {
        const [widthToMove] = table.columnWidths.splice(colIndex, 1);
        table.columnWidths.splice(targetIndex, 0, widthToMove);
    }
    const [columnToMove] = table.columns.splice(colIndex, 1);
    table.columns.splice(targetIndex, 0, columnToMove);

    if (!acceptMutation(tables, '移动列')) return;
    log(`表格 [${table.name}] 的列“${headerToMove}”已向${direction === 'left' ? '左' : '右'}移动。`, 'info');
}

export function deleteTable(tableIndex) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    try {
        assertStructureEditable(tables[tableIndex], '删除表格');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '删除表格失败');
        return;
    }
    const tableName = tables[tableIndex].name;
    tables.splice(tableIndex, 1);
    const success = !!acceptMutation(tables, '删除表格');
    if (success) {
        log(`表格 [${tableName}] 已被成功废黜。`, 'success');
        log('废黜表格后的状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，删除操作可能不会被持久化！', 'error');
    }
}

export function addTable(tableName) {
    if (!tableName || !tableName.trim()) {
        log('无法创建表格：名称不能为空。', 'error');
        toastr.error('表格名称不能为空。', '创建失败');
        return;
    }
    let tables = createMutationDraft();
    if (!tables) {
        loadTables();
        tables = createMutationDraft();
    }

    if (tables.some(table => table.name === tableName.trim())) {
        log(`无法创建表格：名为 "${tableName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${tableName}" 的表格已存在。`, '创建失败');
        return;
    }

    const newTable = {
        fillProtocolVersion: CURRENT_TABLE_FILL_PROTOCOL_VERSION,
        name: tableName.trim(),
        headers: ['新列 1'],
        rows: [],
        rowStatuses: [],
        columnWidths: [],
        note: '这是一个新创建的表格。',
        rule_add: '允许',
        rule_delete: '允许',
        rule_update: '允许',
        charLimitRules: {},
        rowLimitRule: 0,
    };

    tables.push(newTable);
    normalizeTableDatabaseState(tables);
    const success = !!acceptMutation(tables, '创建表格');
    if (success) {
        log(`已成功创建新表格：[${tableName.trim()}]。`, 'success');
        log('新表格状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，新表格可能不会被持久化！', 'error');
    }
}

export function renameTable(tableIndex, newName) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) {
        log('重命名失败：表格不存在。', 'error');
        toastr.error('表格不存在。', '重命名失败');
        return;
    }
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '重命名');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '重命名失败');
        return;
    }
    const trimmedName = newName.trim();
    if (!trimmedName) {
        log('重命名失败：名称不能为空。', 'error');
        toastr.error('表格名称不能为空。', '重命名失败');
        return;
    }
    if (tables.some((table, index) => index !== tableIndex && table.name === trimmedName)) {
        log(`重命名失败：名为 "${trimmedName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${trimmedName}" 的表格已存在。`, '重命名失败');
        return;
    }

    const oldName = tables[tableIndex].name;
    tables[tableIndex].name = trimmedName;
    if (!acceptMutation(tables, '重命名表格')) return;
    log(`表格 "${oldName}" 已重命名为 "${trimmedName}"。`, 'success');
}

export function moveTable(tableIndex, direction) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;

    const newIndex = direction === 'up' ? tableIndex - 1 : tableIndex + 1;
    if (newIndex < 0 || newIndex >= tables.length) {
        log(`无法移动表格：索引 ${tableIndex} 已在边界。`, 'warn');
        return;
    }

    const temp = tables[tableIndex];
    tables[tableIndex] = tables[newIndex];
    tables[newIndex] = temp;

    const success = !!acceptMutation(tables, '移动表格');
    if (success) {
        log(`表格 [${temp.name}] 的顺序已调整。`, 'success');
        log('表格顺序调整后的状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，顺序调整可能不会被持久化！', 'error');
    }
}

export function updateTableRules(tableIndex, newRules) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    const table = normalizeTableIdentity(tables[tableIndex], tableIndex);
    try {
        assertStructureEditable(table, '修改规则');
    } catch (error) {
        log(error.message, 'error');
        if (typeof toastr !== 'undefined') toastr.error(error.message, '更新规则失败');
        return;
    }
    table.note = newRules.note;
    table.rule_add = newRules.rule_add;
    table.rule_delete = newRules.rule_delete;
    table.rule_update = newRules.rule_update;
    table.charLimitRules = newRules.charLimitRules;
    table.rowLimitRule = newRules.rowLimitRule;
    table.simplifyRowThreshold = newRules.simplifyRowThreshold;

    delete table.charLimitRule;

    if (!acceptMutation(tables, '更新表格规则')) return;
    log(`表格 [${table.name}] 的规则已更新。`, 'info');
}

export function updateRow(tableIndex, rowIndex, data) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) {
        log(`AI指令错误：尝试在不存在的表格索引 ${tableIndex} 中操作。`, 'error');
        return;
    }
    const table = tables[tableIndex];

    if (rowIndex >= table.rows.length) {
        log(`AI指令意图更新不存在的行 (rowIndex: ${rowIndex})，已智能转换为在表格 [${table.name}] 末尾新增一行。`, 'warn');
        insertRow(tableIndex, data);
        return;
    }

    const row = table.rows[rowIndex];
    const highlightedColumns = [];
    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < row.length) {
            row[cIndex] = data[cIndex];
            highlightedColumns.push(cIndex);
        }
    }

    if (!acceptMutation(tables, '更新行')) return;
    highlightedColumns.forEach(colIndex => addHighlight(tableIndex, rowIndex, colIndex));
    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`AI 指令更新了表格 [${table.name}] 的第 ${rowIndex + 1} 行。`, 'info');
}

export function clearAllTables() {
    const tables = createMutationDraft();
    if (!tables) {
        log('无法清空：当前表格状态为空。', 'error');
        return;
    }

    tables.forEach((table, tableIndex) => {
        if (table.rows.length > 0) markTableUpdated(tableIndex);
        table.rows = [];
        table.rowStatuses = [];
    });
    if (!acceptMutation(tables, '清空表格')) return;
    log('所有表格的行数据已在内存中清空。', 'warn');

    dispatchAllTablesUpdate();

    log('清空行数据后的状态已强制写入最新消息并立即保存。', 'success');
    toastr.success('所有表格的剧情内容已清空。', '操作完成');
}

export function updateColumnWidth(tableIndex, colIndex, width) {
    const tables = createMutationDraft();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    if (!table.columnWidths) table.columnWidths = [];
    while (table.columnWidths.length < table.headers.length) {
        table.columnWidths.push(null);
    }
    table.columnWidths[colIndex] = width;

    acceptMutation(tables, '更新列宽');
}
