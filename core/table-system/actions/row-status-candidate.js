const ROW_STATUSES = new Set(['normal', 'pending-deletion']);

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

    const previousStatus = sourceTable.rowStatuses?.[rowIndex] === 'pending-deletion'
        ? 'pending-deletion'
        : 'normal';
    if (previousStatus === nextStatus) {
        return { changed: false, state: currentState, table: sourceTable, previousStatus };
    }

    const rowStatuses = sourceTable.rows.map((_, index) => (
        sourceTable.rowStatuses?.[index] === 'pending-deletion'
            ? 'pending-deletion'
            : 'normal'
    ));
    rowStatuses[rowIndex] = nextStatus;

    const table = { ...sourceTable, rowStatuses };
    const state = currentState.slice();
    state[tableIndex] = table;
    return { changed: true, state, table, previousStatus };
}
