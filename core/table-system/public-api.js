import { getState } from './infra/store.js';
import { deepClone, normalizeTableDatabaseState } from './infra/database-state.js';

/** Read-only snapshots for AmilyBus consumers. */
export function listTableSnapshots() {
    const state = getState();
    if (!state) return [];
    return normalizeTableDatabaseState(deepClone(state));
}

export function getTableSnapshot(tableId) {
    if (!tableId) return null;
    const state = getState();
    if (!state) return null;
    const tables = normalizeTableDatabaseState(deepClone(state));
    const table = tables.find(item => item.id === tableId);
    return table ? deepClone(table) : null;
}
