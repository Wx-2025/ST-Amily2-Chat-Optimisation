import { fingerprint } from './metadata.js';
import { fail } from '../validation.js';

function columnIdentity(table, columnIds) {
    return columnIds.map(columnId => {
        const column = table.columns.find(item => item.id === columnId);
        if (!column) fail('FILL_DEPENDENCY_CHANGED');
        return { id: column.id, type: column.type, label: column.label };
    });
}

function rowIdentity(table, index, columnIds) {
    const metadata = table.rowMeta[index];
    const archived = !!metadata.summaryCompactionArchive && !metadata.summaryCompactionInvalidated;
    return { rowId: metadata.id,
        values: columnIds.map(columnId => table.rows[index][table.columns.findIndex(column => column.id === columnId)]),
        deleted: !archived && (metadata.is_delete === true || ['deleted', 'pending-deletion'].includes(table.rowStatuses[index])),
        invalidated: metadata.summaryCompactionInvalidated ?? null };
}

export async function captureFillReadDependencies(readTables, committedTables) {
    const dependencies = [];
    for (const projection of readTables) {
        const table = committedTables.find(item => item.id === projection.tableId);
        if (!table) fail('FILL_DEPENDENCY_CHANGED');
        const columnIds = projection.columns.map(column => column.id);
        const rows = [];
        for (const source of projection.rows) {
            const index = table.rowMeta.findIndex(row => row.id === source.rowId);
            if (index < 0) fail('FILL_DEPENDENCY_CHANGED');
            rows.push({ rowId: source.rowId, hash: await fingerprint(rowIdentity(table, index, columnIds)) });
        }
        dependencies.push({ tableId: table.id, columnIds,
            schemaFingerprint: await fingerprint(columnIdentity(table, columnIds)), rows });
    }
    return dependencies;
}

export async function areFillReadDependenciesCurrent(dependencies, tables) {
    if (!Array.isArray(tables)) return dependencies.length === 0;
    for (const dependency of dependencies) {
        const table = tables.find(item => item.id === dependency.tableId);
        if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rowMeta)) return false;
        try {
            if (await fingerprint(columnIdentity(table, dependency.columnIds)) !== dependency.schemaFingerprint) return false;
            for (const source of dependency.rows) {
                const index = table.rowMeta.findIndex(row => row.id === source.rowId);
                if (index < 0 || await fingerprint(rowIdentity(table, index, dependency.columnIds)) !== source.hash) return false;
            }
        } catch { return false; }
    }
    return true;
}
