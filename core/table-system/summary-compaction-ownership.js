// Dependency-free: shared schema/store/persistence code must not import the
// compaction controller and create a database-state/module-tables cycle.
export const COMPACTION_KEY = 'summaryCompaction';
export const COMPACTION_ARCHIVE_KEY = 'summaryCompactionArchive';
export const COMPACTION_INVALIDATED_KEY = 'summaryCompactionInvalidated';
const ownershipTokens = new WeakMap();
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function createSummaryCompactionOwnershipToken(beforeTables, afterTables) {
    const token = Object.freeze({});
    ownershipTokens.set(token, { before: stable(beforeTables), after: stable(afterTables) });
    return token;
}

export function assertSummaryCompactionOwnershipToken(token, beforeTables, afterTables) {
    const owned = ownershipTokens.get(token);
    if (!owned || owned.before !== stable(beforeTables) || owned.after !== stable(afterTables)) {
        throw Object.assign(new Error('Compaction ownership token does not match this transition.'), { code: 'SUMMARY_COMPACTION_OWNERSHIP_MISMATCH' });
    }
    return true;
}

// Mutates only the candidate. Call before receipt hashing; repeat at the shared
// commit boundary. touchedRows is essential for explicit no-op user operations.
export function invalidateSummaryCompactionTransition(beforeTables, afterTables, {
    operationId = globalThis.crypto.randomUUID(), reason = 'shared-mutation', touchedRows = [], ownershipToken,
} = {}) {
    if (ownershipToken !== undefined) {
        assertSummaryCompactionOwnershipToken(ownershipToken, beforeTables, afterTables);
        return afterTables;
    }
    if (!Array.isArray(beforeTables) || !Array.isArray(afterTables) || !Array.isArray(touchedRows)
        || !id(operationId) || typeof reason !== 'string' || !reason || reason.length > 128
        || touchedRows.some(ref => !id(ref?.tableId) || !id(ref?.rowId))) throw new TypeError('Invalid compaction mutation transition.');
    const touched = new Set(touchedRows.map(ref => JSON.stringify([ref.tableId, ref.rowId])));
    const previousTables = new Map(beforeTables.map(table => [table.id, table]));
    for (const table of afterTables) {
        const before = previousTables.get(table.id);
        if (!before) continue;
        const previousRows = new Map((before.rowMeta ?? []).map((metadata, index) => [metadata.id, index]));
        for (let index = 0; index < (table.rowMeta?.length ?? 0); index++) {
            const metadata = table.rowMeta[index];
            const priorIndex = previousRows.get(metadata.id) ?? -1;
            const prior = before.rowMeta?.[priorIndex];
            if (!prior || (!prior[COMPACTION_ARCHIVE_KEY] && !prior[COMPACTION_KEY] && !prior[COMPACTION_INVALIDATED_KEY])) continue;
            if (metadata[COMPACTION_INVALIDATED_KEY]) continue;
            const changed = stable({ row: before.rows[priorIndex], metadata: prior, status: before.rowStatuses?.[priorIndex], columns: before.columns })
                !== stable({ row: table.rows[index], metadata, status: table.rowStatuses?.[index], columns: table.columns });
            if (!changed && !touched.has(JSON.stringify([table.id, metadata.id]))) continue;
            // Preserve provenance when a writer replaces row metadata wholesale.
            if (prior[COMPACTION_KEY]) metadata[COMPACTION_KEY] = structuredClone(prior[COMPACTION_KEY]);
            metadata[COMPACTION_INVALIDATED_KEY] = { version: 1, operationId, reason };
            delete metadata[COMPACTION_ARCHIVE_KEY];
        }
    }
    return afterTables;
}

// Explicit no-op edits also revoke the claim, preventing edit/revert ABA.
export function invalidateSummaryCompactionOwnership(table, rowIndex, { operationId = globalThis.crypto.randomUUID(), reason = 'user-mutation' } = {}) {
    const metadata = table?.rowMeta?.[rowIndex];
    if (!metadata || (!metadata[COMPACTION_ARCHIVE_KEY] && !metadata[COMPACTION_KEY])) return false;
    if (!id(operationId) || typeof reason !== 'string' || !reason || reason.length > 128) throw new TypeError('Invalid ownership invalidation.');
    metadata[COMPACTION_INVALIDATED_KEY] = { version: 1, operationId, reason };
    delete metadata[COMPACTION_ARCHIVE_KEY];
    return true;
}
