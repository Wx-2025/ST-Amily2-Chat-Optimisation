import { getAutomationOwnedTableIds } from './ownership.js';

/** Preserve absolute legacy indices while excluding tables with a separate writer. */
export function projectLegacyFillTables(tables, context) {
    const owned = new Set(getAutomationOwnedTableIds(context));
    if (!owned.size) return tables;
    const projected = new Array(tables.length);
    tables.forEach((table, index) => { if (table && !owned.has(table.id)) projected[index] = table; });
    return projected;
}

export function restrictLegacyFillScope(scope, context) {
    const scopedState = projectLegacyFillTables(scope.scopedState, context);
    if (scopedState === scope.scopedState) return scope;
    const targetTables = scope.targetTables.filter(target => scopedState[target.tableIndex]);
    return Object.freeze({ ...scope, scopedState: Object.freeze(scopedState),
        targetTables: Object.freeze(targetTables),
        targetTableIds: Object.freeze(targetTables.map(target => target.tableId)),
        targetTableIndices: Object.freeze(targetTables.map(target => target.tableIndex)) });
}
