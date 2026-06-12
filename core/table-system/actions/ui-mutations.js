/**
 * @file actions/ui-mutations.js —— 19 个 UI 突变（Phase 0.4 自 manager.js 搬出）
 *
 * 表格面板上的所有用户操作入口：增删行列 / 移动 / 重命名 / 规则更新 / 清空等。
 * 函数签名与行为与搬出前完全一致；manager.js re-export 这些函数，外部调用路径零改动。
 *
 * 依赖说明：
 *   - 状态读写走 infra/store.js，持久化走 infra/persistence.js
 *   - SuperMemory 分发走 events-dispatch.js（与 manager 共用，无环）
 *   - loadTables / saveTables 仍从 manager 引入（addTable 空状态兜底 / 日志桩），
 *     manager ↔ ui-mutations 构成 ESM 循环，但二者均为 hoisted 函数声明、
 *     仅在运行时调用，与既有 manager ↔ ui/table-bindings 环同模式，安全
 */

import { getContext } from '/scripts/extensions.js';
import { saveChat } from '/script.js';
import { saveChatDebounced } from '../../../utils/utils.js';

import { log } from '../logger.js';
import { renderTables } from '../../../ui/table-bindings.js';
import { dispatchTableUpdate, dispatchAllTablesUpdate } from '../events-dispatch.js';
import { loadTables, saveTables } from '../manager.js';

import {
    getState,
    addHighlight,
    markTableUpdated,
    getUpdatedTables,
} from '../infra/store.js';

import {
    saveStateToMessage,
    commitToLastMessage,
} from '../infra/persistence.js';

export function deleteColumn(tableIndex, colIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex] || colIndex < 0 || colIndex >= tables[tableIndex].headers.length) {
        log(`删除列失败：在表格 ${tableIndex} 中找不到索引为 ${colIndex} 的列。`, 'error');
        return;
    }

    tables[tableIndex].headers.splice(colIndex, 1);
    tables[tableIndex].rows.forEach(row => {
        if (row.length > colIndex) row.splice(colIndex, 1);
    });
    if (tables[tableIndex].columnWidths && tables[tableIndex].columnWidths.length > colIndex) {
        tables[tableIndex].columnWidths.splice(colIndex, 1);
    }

    log(`成功删除了表格 ${tableIndex} 的第 ${colIndex + 1} 列。`, 'success');
    saveTables(tables);
    dispatchTableUpdate(tableIndex);
}

export function moveRow(tableIndex, rowIndex, direction) {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table || rowIndex < 0 || rowIndex >= table.rows.length) return;

    const newIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
    if (newIndex < 0 || newIndex >= table.rows.length) return;

    const [movedRow] = table.rows.splice(rowIndex, 1);
    table.rows.splice(newIndex, 0, movedRow);

    if (table.rowStatuses && table.rowStatuses.length === table.rows.length + 1) {
        const [movedStatus] = table.rowStatuses.splice(rowIndex, 1);
        table.rowStatuses.splice(newIndex, 0, movedStatus);
    }

    log(`成功将表格 ${tableIndex} 的第 ${rowIndex + 1} 行移动到第 ${newIndex + 1} 行。`, 'success');
    saveTables(tables);
    dispatchTableUpdate(tableIndex);
}

export function insertRow(tableIndex, data, position = 'below') {
    const tables = getState();
    const table = tables?.[tableIndex];
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
                addHighlight(tableIndex, insertIndex, cIndex);
            }
        }
    }

    table.rows.splice(insertIndex, 0, newRow);
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.splice(insertIndex, 0, 'normal');

    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`成功在表格 ${table.name} (索引 ${tableIndex}) 的第 ${insertIndex + 1} 行位置插入了新行。`, 'success');

    commitToLastMessage(tables);
}

export function addRow(tableIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    const colCount = table.headers.length;
    const newRow = Array(colCount).fill('');
    table.rows.push(newRow);
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.push('normal');
    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`表格 [${table.name}] 新增了一行。`, 'info');

    commitToLastMessage(tables);
}

export function addColumn(tableIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    const newHeader = `新列 ${table.headers.length + 1}`;
    table.headers.push(newHeader);
    table.rows.forEach(row => row.push(''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.push(null);
    log(`表格 [${table.name}] 新增了一列。`, 'info');

    commitToLastMessage(tables);
}

export function updateHeader(tableIndex, colIndex, value) {
    const tables = getState();
    if (!tables || !tables[tableIndex] || tables[tableIndex].headers[colIndex] === undefined) return;
    const tableName = tables[tableIndex].name;
    const originalHeader = tables[tableIndex].headers[colIndex];
    tables[tableIndex].headers[colIndex] = value;
    log(`表格 [${tableName}] 的表头“${originalHeader}”已更新为“${value}”。`, 'info');

    commitToLastMessage(tables);
}

export async function deleteRow(tableIndex, rowIndex) {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table || !table.rows[rowIndex]) return;

    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length).fill('normal');
    }

    table.rowStatuses[rowIndex] = 'pending-deletion';
    markTableUpdated(tableIndex);
    log(`表格 [${table.name}] 的第 ${rowIndex + 1} 行已标记为待删除。`, 'info');

    const context = getContext();
    if (context.chat?.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(tables, lastMessage)) {
            await saveChat();
            renderTables();
            dispatchTableUpdate(tableIndex);
            return;
        }
    }
    await saveChatDebounced();
    renderTables();
    dispatchTableUpdate(tableIndex);
}

export async function restoreRow(tableIndex, rowIndex) {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table || !table.rows[rowIndex] || !table.rowStatuses) return;

    table.rowStatuses[rowIndex] = 'normal';
    markTableUpdated(tableIndex);
    log(`表格 [${table.name}] 的第 ${rowIndex + 1} 行已恢复。`, 'info');

    const context = getContext();
    if (context.chat?.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(tables, lastMessage)) {
            await saveChat();
            renderTables();
            dispatchTableUpdate(tableIndex);
            return;
        }
    }
    await saveChatDebounced();
    renderTables();
    dispatchTableUpdate(tableIndex);
}

export function commitPendingDeletions() {
    const tables = getState();
    if (!tables) return false;
    let deletionCount = 0;

    tables.forEach((table, tableIndex) => {
        if (!table.rowStatuses || table.rowStatuses.length === 0) return;
        let tableHadDeletions = false;
        for (let i = table.rows.length - 1; i >= 0; i--) {
            if (table.rowStatuses[i] === 'pending-deletion') {
                table.rows.splice(i, 1);
                table.rowStatuses.splice(i, 1);
                deletionCount++;
                tableHadDeletions = true;
            }
        }
        if (tableHadDeletions) markTableUpdated(tableIndex);
    });

    if (deletionCount > 0) {
        log(`已提交并永久删除了 ${deletionCount} 行。`, 'info');
        const updated = getUpdatedTables();
        if (updated.size > 0) {
            updated.forEach(tableIndex => dispatchTableUpdate(tableIndex));
        }
        return true;
    }
    return false;
}

export function insertColumn(tableIndex, colIndex, position) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];

    const insertAt = position === 'left' ? colIndex : colIndex + 1;
    table.headers.splice(insertAt, 0, '新列');
    table.rows.forEach(row => row.splice(insertAt, 0, ''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.splice(insertAt, 0, null);

    log(`表格 [${table.name}] 在第 ${colIndex + 1} 列的${position === 'left' ? '左侧' : '右侧'}插入了新列。`, 'info');
    commitToLastMessage(tables);
}

export function moveColumn(tableIndex, colIndex, direction) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
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

    log(`表格 [${table.name}] 的列“${headerToMove}”已向${direction === 'left' ? '左' : '右'}移动。`, 'info');
    commitToLastMessage(tables);
}

export function deleteTable(tableIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const tableName = tables[tableIndex].name;
    tables.splice(tableIndex, 1);
    log(`表格 [${tableName}] 已被成功废黜。`, 'success');

    const success = commitToLastMessage(tables);
    if (success) {
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
    let tables = getState();
    if (!tables) {
        loadTables();
        tables = getState();
    }

    if (tables.some(table => table.name === tableName.trim())) {
        log(`无法创建表格：名为 "${tableName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${tableName}" 的表格已存在。`, '创建失败');
        return;
    }

    const newTable = {
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
    log(`已成功创建新表格：[${tableName.trim()}]。`, 'success');

    const success = commitToLastMessage(tables);
    if (success) {
        log('新表格状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，新表格可能不会被持久化！', 'error');
    }
}

export function renameTable(tableIndex, newName) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) {
        log('重命名失败：表格不存在。', 'error');
        toastr.error('表格不存在。', '重命名失败');
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
    log(`表格 "${oldName}" 已重命名为 "${trimmedName}"。`, 'success');

    commitToLastMessage(tables);
}

export function moveTable(tableIndex, direction) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;

    const newIndex = direction === 'up' ? tableIndex - 1 : tableIndex + 1;
    if (newIndex < 0 || newIndex >= tables.length) {
        log(`无法移动表格：索引 ${tableIndex} 已在边界。`, 'warn');
        return;
    }

    const temp = tables[tableIndex];
    tables[tableIndex] = tables[newIndex];
    tables[newIndex] = temp;

    log(`表格 [${temp.name}] 的顺序已调整。`, 'success');

    const success = commitToLastMessage(tables);
    if (success) {
        log('表格顺序调整后的状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，顺序调整可能不会被持久化！', 'error');
    }
}

export function updateTableRules(tableIndex, newRules) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    table.note = newRules.note;
    table.rule_add = newRules.rule_add;
    table.rule_delete = newRules.rule_delete;
    table.rule_update = newRules.rule_update;
    table.charLimitRules = newRules.charLimitRules;
    table.rowLimitRule = newRules.rowLimitRule;
    table.simplifyRowThreshold = newRules.simplifyRowThreshold;

    delete table.charLimitRule;

    log(`表格 [${table.name}] 的规则已更新。`, 'info');
    commitToLastMessage(tables);
}

export function updateRow(tableIndex, rowIndex, data) {
    const tables = getState();
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
    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < row.length) {
            row[cIndex] = data[cIndex];
            addHighlight(tableIndex, rowIndex, cIndex);
        }
    }

    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`AI 指令更新了表格 [${table.name}] 的第 ${rowIndex + 1} 行。`, 'info');

    commitToLastMessage(tables);
}

export function clearAllTables() {
    const tables = getState();
    if (!tables) {
        log('无法清空：当前表格状态为空。', 'error');
        return;
    }

    tables.forEach((table, tableIndex) => {
        if (table.rows.length > 0) markTableUpdated(tableIndex);
        table.rows = [];
        table.rowStatuses = [];
    });
    log('所有表格的行数据已在内存中清空。', 'warn');

    dispatchAllTablesUpdate();

    const success = commitToLastMessage(tables);
    if (success) {
        log('清空行数据后的状态已强制写入最新消息并立即保存。', 'success');
        toastr.success('所有表格的剧情内容已清空。', '操作完成');
    } else {
        log('无法找到可锚定的消息或保存失败，清空操作可能不会被持久化！', 'error');
    }
}

export function updateColumnWidth(tableIndex, colIndex, width) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    if (!table.columnWidths) table.columnWidths = [];
    while (table.columnWidths.length < table.headers.length) {
        table.columnWidths.push(null);
    }
    table.columnWidths[colIndex] = width;

    commitToLastMessage(tables);
}
