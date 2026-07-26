/**
 * @file Action: applyOperations —— 表格操作推演核心。
 *
 * 输入：基准 state + Operation[]
 * 输出：新 state（深拷贝）+ Change[] 变更记录
 *
 * 不依赖任何 formatter / store / persistence —— 纯函数。
 * 所有 formatter (legacy / json / toolcall) 解析完都吐 Operation[] 给本函数。
 *
 * 历史来源：从 executor.js 中 insertRow / updateRow / deleteRow 三个内部函数
 * 抽出，行为完全等价。executeCommands 改造为：parse 文本 → ops → 调本函数。
 *
 * 关键行为约定（不要随便改，否则破坏老存档）：
 *   - 入参 state 不被修改；返回的 state 是 JSON 深拷贝
 *   - updateRow 的 rowIndex 越界 → 自动转换为 insertRow（历史智能修正）
 *   - deleteRow 是延迟删除：rowStatuses[rowIndex] = 'pending-deletion'，行不实际从 rows 中移除
 *   - insertRow 的 changes 用 type='update'（每个被填的单元格一条），不要发明 'insert'
 *
 * @typedef {import('../dto/Table.js').TableState} TableState
 * @typedef {import('../dto/Operation.js').Operation} Operation
 * @typedef {import('../dto/Operation.js').InsertRowOperation} InsertRowOperation
 * @typedef {import('../dto/Operation.js').UpdateRowOperation} UpdateRowOperation
 * @typedef {import('../dto/Operation.js').DeleteRowOperation} DeleteRowOperation
 * @typedef {import('../dto/Change.js').Change} Change
 */

import { log } from '../logger.js';
import { createRecordMetadata, normalizeTableDatabaseState, normalizeTableIdentity } from '../infra/database-state.js';
import { validateTableState } from '../module-tables.js';

/**
 * 在表格末尾插入一行。in-place mutation（调用方已 clone）。
 * @param {TableState} state
 * @param {number} tableIndex
 * @param {Object<string, string>} data
 * @returns {{ state: TableState, changes: Change[] }}
 */
function _insertRow(state, tableIndex, data) {
    if (!state[tableIndex]) {
        log(`AI指令错误：尝试在不存在的表格索引 ${tableIndex} 中插入行。`, 'error');
        return { state, changes: [] };
    }

    if (typeof data !== 'object' || data === null) {
        log(`AI指令错误：insertRow 的 data 参数必须是对象，实际收到: ${typeof data} (${data})`, 'error');
        return { state, changes: [] };
    }

    const table = normalizeTableIdentity(state[tableIndex], tableIndex);
    const colCount = table.headers.length;
    const newRow = Array(colCount).fill('');
    /** @type {Change[]} */
    const changes = [];
    const newRowIndex = table.rows.length;

    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < colCount) {
            newRow[cIndex] = data[colIndex];
            changes.push({ type: 'update', tableIndex, rowIndex: newRowIndex, colIndex: cIndex });
        }
    }
    table.rows.push(newRow);

    // 同步更新 rowStatuses
    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length - 1).fill('normal');
    }
    table.rowStatuses.push('normal');
    table.rowMeta.push(createRecordMetadata(table, newRow, newRowIndex));

    return { state, changes };
}

/**
 * 更新指定行。in-place mutation。
 * 历史智能修正：rowIndex 越界自动降级为 insertRow。
 * @param {TableState} state
 * @param {number} tableIndex
 * @param {number} rowIndex
 * @param {Object<string, string>} data
 * @returns {{ state: TableState, changes: Change[] }}
 */
function _updateRow(state, tableIndex, rowIndex, data) {
    if (!state[tableIndex]) {
        log(`AI指令错误：尝试更新不存在的表格 ${tableIndex}。`, 'error');
        return { state, changes: [] };
    }

    if (typeof data !== 'object' || data === null) {
        log(`AI指令错误：updateRow 的 data 参数必须是对象，实际收到: ${typeof data} (${data})`, 'error');
        return { state, changes: [] };
    }

    const table = state[tableIndex];

    if (rowIndex >= table.rows.length) {
        log(`AI指令修正：updateRow 的行索引 ${rowIndex} 超出范围，自动转换为 insertRow。`, 'warn');
        return _insertRow(state, tableIndex, data);
    }

    const row = table.rows[rowIndex];
    /** @type {Change[]} */
    const changes = [];
    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < row.length) {
            row[cIndex] = data[colIndex];
            changes.push({ type: 'update', tableIndex, rowIndex, colIndex: cIndex });
        }
    }
    return { state, changes };
}

/**
 * 标记指定行为待删除（延迟删除）。in-place mutation。
 * 不从 rows 实际移除；commitPendingDeletions 才会真正 splice。
 * @param {TableState} state
 * @param {number} tableIndex
 * @param {number} rowIndex
 * @returns {{ state: TableState, changes: Change[] }}
 */
function _deleteRow(state, tableIndex, rowIndex) {
    const table = state[tableIndex];
    if (!table || !table.rows[rowIndex]) {
        log(`AI指令错误：尝试删除不存在的表格 ${tableIndex} 或行 ${rowIndex}。`, 'error');
        return { state, changes: [] };
    }

    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length).fill('normal');
    }

    if (table.rowStatuses[rowIndex] !== 'pending-deletion') {
        table.rowStatuses[rowIndex] = 'pending-deletion';
        /** @type {Change[]} */
        const changes = [{ type: 'delete', tableIndex, rowIndex }];
        return { state, changes };
    }

    return { state, changes: [] };
}

/** @type {Object<string, (state: TableState, op: Operation) => { state: TableState, changes: Change[] }>} */
const HANDLERS = {
    insertRow: (state, op) => _insertRow(state, op.tableIndex, /** @type {InsertRowOperation} */(op).data),
    updateRow: (state, op) => _updateRow(state, op.tableIndex, /** @type {UpdateRowOperation} */(op).rowIndex, /** @type {UpdateRowOperation} */(op).data),
    deleteRow: (state, op) => _deleteRow(state, op.tableIndex, /** @type {DeleteRowOperation} */(op).rowIndex),
};

/**
 * 把一组操作推演到 state 上。
 *
 * @param {TableState} initialState
 * @param {Operation[]} operations
 * @param {{ strictRowBounds?: boolean }} [options]
 * @returns {{ state: TableState, changes: Change[] }}
 */
export function applyOperations(initialState, operations, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return { state: initialState, changes: [] };
    }

    const originalState = normalizeTableDatabaseState(JSON.parse(JSON.stringify(initialState)));
    let state = JSON.parse(JSON.stringify(originalState));
    /** @type {Change[]} */
    let allChanges = [];

    for (const op of operations) {
        if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
            log(`发现非法操作，整批原子回退: ${JSON.stringify(op)}`, 'error');
            return { state: originalState, changes: [] };
        }
        const handler = HANDLERS[op.op];
        if (!handler) {
            log(`发现未知操作类型 ${op.op}，整批原子回退。`, 'error');
            return { state: originalState, changes: [] };
        }
        if (!Number.isSafeInteger(op.tableIndex) || op.tableIndex < 0) {
            log(`操作 ${op.op} 包含非法 tableIndex，整批原子回退。`, 'error');
            return { state: originalState, changes: [] };
        }
        const targetTable = state[op.tableIndex];
        if (!targetTable) {
            log(`操作 ${op.op} 指向不存在的表格索引 ${op.tableIndex}，整批原子回退。`, 'error');
            return { state: originalState, changes: [] };
        }
        if (targetTable?.owner && targetTable.owner !== 'user') {
            log(
                `普通填表操作试图修改模块 ${targetTable.owner} 的表格索引 ${op.tableIndex}，整批原子回退。`,
                'error',
            );
            return { state: originalState, changes: [] };
        }
        if (op.op === 'insertRow' || op.op === 'updateRow') {
            const data = /** @type {InsertRowOperation|UpdateRowOperation} */(op).data;
            if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
                log(`操作 ${op.op} 缺少有效 data，整批原子回退。`, 'error');
                return { state: originalState, changes: [] };
            }
            const colCount = Array.isArray(targetTable.headers) ? targetTable.headers.length : 0;
            const hasInvalidColumn = Object.keys(data).some(key => {
                const columnIndex = Number(key);
                return !Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= colCount;
            });
            if (hasInvalidColumn) {
                log(`操作 ${op.op} 包含超出表结构范围的列索引，整批原子回退。`, 'error');
                return { state: originalState, changes: [] };
            }
        }
        if (
            op.op === 'updateRow'
            && (
                !Number.isSafeInteger((/** @type {UpdateRowOperation} */(op)).rowIndex)
                || (/** @type {UpdateRowOperation} */(op)).rowIndex < 0
                || (
                    options.strictRowBounds === true
                    && (/** @type {UpdateRowOperation} */(op)).rowIndex >= targetTable.rows.length
                )
            )
        ) {
            log(`updateRow 包含非法或已过期的 rowIndex，整批原子回退。`, 'error');
            return { state: originalState, changes: [] };
        }
        if (
            op.op === 'deleteRow'
            && (
                !Number.isSafeInteger((/** @type {DeleteRowOperation} */(op)).rowIndex)
                || (/** @type {DeleteRowOperation} */(op)).rowIndex < 0
                || (/** @type {DeleteRowOperation} */(op)).rowIndex >= targetTable.rows.length
            )
        ) {
            log(`deleteRow 指向不存在的行，整批原子回退。`, 'error');
            return { state: originalState, changes: [] };
        }
        try {
            const result = handler(state, op);
            state = result.state;
            if (result.changes && result.changes.length > 0) {
                allChanges = allChanges.concat(result.changes);
            }
            const opLabel = op.op + '(' + op.tableIndex
                + (typeof (/** @type {any} */(op)).rowIndex === 'number' ? `, ${(/** @type {any} */(op)).rowIndex}` : '')
                + ')';
            log(`成功推演操作: ${opLabel}`, 'success');
        } catch (e) {
            log(`推演操作 ${op.op} 时发生运行时错误，整批原子回退: ${e.message}`, 'error');
            return { state: originalState, changes: [] };
        }
    }

    try {
        state = validateTableState(state);
    } catch (error) {
        log(`整批填表操作未通过数据库约束校验，已原子回退: ${error.code || 'TABLE_VALIDATION_FAILED'} ${error.message}`, 'error');
        return { state: originalState, changes: [] };
    }

    return { state, changes: allChanges };
}
