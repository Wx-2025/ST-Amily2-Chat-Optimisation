import { isDeletedRow } from '../row-lifecycle.js';
const ROW_STATUSES = new Set(['normal', 'pending-deletion', 'deleted']);

/**
 * Replace one row status without cloning unchanged table data. The store treats
 * published states as immutable snapshots, so rows, columns and unaffected
 * tables can be shared until the persistence boundary creates its private copy.
 */
export function createRowStatusCandidate(currentState, tableIndex, rowIndex, nextStatus) {
    if (!ROW_STATUSES.has(nextStatus)) {
        throw new TypeError(`Unsupported row status "${nextStatus}".`);
    }
    if (!Array.isArray(currentState)
        || !Number.isInteger(tableIndex)
        || !Number.isInteger(rowIndex)) {
        return null;
    }

    const sourceTable = currentState[tableIndex];
    if (!sourceTable || !Array.isArray(sourceTable.rows)
        || rowIndex < 0 || rowIndex >= sourceTable.rows.length) {
        return null;
    }

    if (nextStatus === 'pending-deletion' && sourceTable.softDelete === true) nextStatus = 'deleted';
    const previousStatus = isDeletedRow(sourceTable, rowIndex) ? 'deleted' : sourceTable.rowStatuses?.[rowIndex] === 'pending-deletion'
        ? 'pending-deletion'
        : 'normal';
    if (previousStatus === nextStatus) {
        return { changed: false, state: currentState, table: sourceTable, previousStatus };
    }

    const rowStatuses = sourceTable.rows.map((_, index) => (
        isDeletedRow(sourceTable, index) ? 'deleted' : sourceTable.rowStatuses?.[index] === 'pending-deletion'
            ? 'pending-deletion'
            : 'normal'
    ));
    rowStatuses[rowIndex] = nextStatus;

    let rowMeta = sourceTable.rowMeta;
    if (nextStatus === 'deleted' || previousStatus === 'deleted') {
        rowMeta = (rowMeta || []).slice();
        rowMeta[rowIndex] = { ...rowMeta[rowIndex], is_delete: nextStatus === 'deleted' };
    }
    const table = { ...sourceTable, rowStatuses, ...(sourceTable.rowMeta || nextStatus === 'deleted' ? { rowMeta } : {}) };
    const state = currentState.slice();
    state[tableIndex] = table;
    return { changed: true, state, table, previousStatus };
}
