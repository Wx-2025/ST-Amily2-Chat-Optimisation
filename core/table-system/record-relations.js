import { isValidTableGroupId, TABLE_GROUP_REGISTRY_SCHEMA } from './table-groups.js';
import { isDeletedRow } from './row-lifecycle.js';
import { chatScopesMatch } from './infra/chat-scope.js';
import { createVerifiedRelationLifecycleReader } from './record-relation-lifecycle.js';

export const RECORD_RELATION_FORMAT = 'amily2.record-relation';
export const RECORD_RELATION_LIMITS = Object.freeze({
    items: 64, idChars: 256, cellChars: 32768, pageSize: 100,
    queryChars: 256, labelChars: 256, migrationRows: 1000, edges: 100000,
});

const fail = code => { throw Object.assign(new Error(code), { code }); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const id = value => typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= RECORD_RELATION_LIMITS.idChars && !/[\u0000-\u001f\u007f]/u.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Re-run inside main's locked transaction, using live host state, never a submitted authority. */
export function assertRecordRelationCommitContext(expected, current) {
    if (!expected || !Number.isSafeInteger(expected.expectedStateRevision)
        || !Number.isSafeInteger(expected.expectedGroupRevision)
        || !chatScopesMatch(expected.expectedChatScope, current?.scope)
        || expected.expectedStateRevision !== current.revision
        || expected.expectedGroupRevision !== current.access?.registry?.revision
        || expected.expectedGroupId !== current.access?.groupId
        || expected.expectedCaller !== current.access?.caller) fail('TABLE_STALE');
    group(current.access);
    return true;
}

/** Opt-in metadata on a STRING column; never reinterpret the legacy reference type. */
export function normalizeRecordRelation(value) {
    if (!object(value) || value.kind !== 'record' || value.version !== 1) fail('RELATION_UNSUPPORTED');
    if (Object.keys(value).some(key => !['kind', 'version', 'targetTableId', 'cardinality', 'required', 'onDelete', 'maxItems'].includes(key))
        || !id(value.targetTableId) || !['one', 'many'].includes(value.cardinality)
        || typeof value.required !== 'boolean') fail('RELATION_SCHEMA_INVALID');
    if ((value.onDelete ?? 'restrict') !== 'restrict') fail('RELATION_DELETE_POLICY_UNSUPPORTED');
    const maxItems = value.maxItems ?? (value.cardinality === 'one' ? 1 : RECORD_RELATION_LIMITS.items);
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > RECORD_RELATION_LIMITS.items
        || (value.cardinality === 'one' && maxItems !== 1)) fail('RELATION_CARDINALITY');
    return { kind: 'record', version: 1, targetTableId: value.targetTableId,
        cardinality: value.cardinality, required: value.required, onDelete: 'restrict', maxItems };
}

function checkIds(rowIds, relation) {
    if (!Array.isArray(rowIds) || rowIds.length > relation.maxItems || rowIds.some(value => !id(value))) fail('RELATION_CARDINALITY');
    if (new Set(rowIds).size !== rowIds.length) fail('RELATION_DUPLICATE');
    if (relation.required && !rowIds.length) fail('RELATION_REQUIRED');
    return [...rowIds];
}

export function encodeRecordRelation(definition, rowIds) {
    const relation = normalizeRecordRelation(definition);
    const ids = checkIds(rowIds, relation);
    if (!ids.length) return '';
    const encoded = JSON.stringify({ format: RECORD_RELATION_FORMAT, version: 1, tableId: relation.targetTableId, rowIds: ids });
    if (encoded.length > RECORD_RELATION_LIMITS.cellChars) fail('RELATION_CELL_INVALID');
    return encoded;
}

export function decodeRecordRelation(cell, definition) {
    const relation = normalizeRecordRelation(definition);
    if (typeof cell !== 'string' || cell.length > RECORD_RELATION_LIMITS.cellChars) fail('RELATION_CELL_INVALID');
    if (cell === '') return checkIds([], relation);
    let value;
    try { value = JSON.parse(cell); } catch { fail('RELATION_CELL_INVALID'); }
    if (!object(value) || value.format !== RECORD_RELATION_FORMAT || value.version !== 1) fail('RELATION_UNSUPPORTED');
    if (Object.keys(value).some(key => !['format', 'version', 'tableId', 'rowIds'].includes(key))
        || value.tableId !== relation.targetTableId) fail('RELATION_CELL_INVALID');
    return checkIds(value.rowIds, relation);
}

function indexState(state) {
    if (!Array.isArray(state) || state.length > 512) fail('RELATION_STATE_INVALID');
    const tables = new Map();
    for (const table of state) {
        if (!id(table?.id) || !id(table.owner) || tables.has(table.id)
            || !Array.isArray(table.columns) || !Array.isArray(table.rows)
            || !Array.isArray(table.rowMeta) || table.rows.length !== table.rowMeta.length) fail('RELATION_IDENTITY_INVALID');
        const rows = new Map();
        const columns = new Set();
        for (const column of table.columns) {
            if (!id(column?.id) || columns.has(column.id)) fail('RELATION_IDENTITY_INVALID');
            columns.add(column.id);
        }
        table.rowMeta.forEach((meta, index) => {
            if (!id(meta?.id) || rows.has(meta.id) || !Array.isArray(table.rows[index])
                || table.rows[index].length !== table.columns.length) fail('RELATION_IDENTITY_INVALID');
            rows.set(meta.id, index);
        });
        tables.set(table.id, { table, rows });
    }
    return tables;
}

function group(access) {
    if (!id(access?.caller) || !isValidTableGroupId(access.groupId)
        || access.registry?.schema !== TABLE_GROUP_REGISTRY_SCHEMA) fail('RELATION_SCOPE_DENIED');
    const result = access.registry.groups?.find(item => item.id === access.groupId);
    if (!result) fail('RELATION_SCOPE_DENIED');
    return result;
}

function readable(table, access) {
    return Boolean(table && table.groupId === access.groupId
        && (access.canReadTable ? access.canReadTable(table) === true : table.owner === access.caller));
}

function writable(table, access) {
    return readable(table, access) && access.caller === 'user' && table.owner === 'user' && group(access).readOnly === false
        && table.readOnly !== true && (!access.canWriteTable || access.canWriteTable(table) === true);
}

function sourceField(index, request, access, write = false) {
    group(access);
    const entry = index.get(request?.tableId);
    if (!readable(entry?.table, access) || (write && !writable(entry.table, access))) fail('RELATION_ACCESS_DENIED');
    const columnIndex = entry.table.columns.findIndex(column => column.id === request.columnId);
    if (columnIndex < 0) fail('RELATION_COLUMN_MISSING');
    return { ...entry, columnIndex, column: entry.table.columns[columnIndex] };
}

function definition(column) {
    const relation = normalizeRecordRelation(column.recordRelation);
    if (column.type !== 'string' || column.references != null || column.primaryKey === true
        || column.unique === true || column.required === true) fail('RELATION_SCHEMA_INVALID');
    return relation;
}

function hasRelations(state) {
    if (!Array.isArray(state)) return false;
    for (const table of state) {
        if (!Array.isArray(table?.columns)) continue;
        for (const column of table.columns) {
            if (column && own(column, 'recordRelation')) return true;
        }
    }
    return false;
}

/** Call before normalizeTableDatabaseState: identity repair must not silently rebind a relation. */
export function assertRecordRelationIdentities(state) {
    if (!hasRelations(state)) return true;
    relationIndex(state);
    return true;
}

function relationIndex(state) {
    if (state.length > 512) fail('RELATION_STATE_INVALID');
    const participating = new Set();
    for (const table of state) {
        for (const column of table.columns || []) {
            if (!own(column, 'recordRelation')) continue;
            participating.add(table.id);
            participating.add(definition(column).targetTableId);
        }
    }
    return indexState(state.filter(table => participating.has(table?.id)));
}

/**
 * Unconditional validateTableState hook, independent of the current UI caller.
 * No caller/grant/lifecycle callback can weaken this persisted-state guard.
 * Throws on any dangling/inactive/foreign-Group edge, including historical source rows.
 */
export function validateRecordRelationState(state, options = {}) {
    if (!hasRelations(state)) return true;
    const lifecycle = { getRowState: createVerifiedRelationLifecycleReader(state, options.relationLifecycleProof) };
    const index = relationIndex(state);
    for (const { table } of index.values()) {
        for (const column of table.columns) {
            if (!own(column, 'recordRelation')) continue;
            const relation = definition(column);
            if (table.primaryKey?.columnIds?.includes(column.id)) fail('RELATION_SCHEMA_INVALID');
            const target = index.get(relation.targetTableId);
            if (!target) fail('RELATION_TARGET_MISSING');
            if (table.owner !== 'user' || target.table.owner !== 'user') fail('RELATION_ACCESS_DENIED');
            if (!isValidTableGroupId(table.groupId) || table.groupId.startsWith('module:')
                || table.groupId !== target.table.groupId) fail('RELATION_SCOPE_DENIED');
        }
    }
    scanReferences(index, (_table, _column, _rowIndex, relation, ids) => {
        const target = index.get(relation.targetTableId);
        for (const rowId of ids) {
            const rowIndex = target.rows.get(rowId);
            if (rowIndex === undefined) fail('RELATION_TARGET_MISSING');
            const status = rowState(target.table, rowIndex, lifecycle);
            if (status !== 'active' && status !== 'archived') fail(`RELATION_TARGET_${status.toUpperCase().replaceAll('-', '_')}`);
        }
    });
    return true;
}

function targetTable(index, source, relation, access) {
    const target = index.get(relation.targetTableId);
    // Authorization precedes existence/label diagnostics. Hidden targets have one opaque result.
    if (!target) return { status: 'missing-table' };
    if (!readable(target.table, access)) return { status: 'forbidden' };
    if (source.owner !== 'user' || target.table.owner !== 'user') return { status: 'forbidden' };
    return { status: 'active', ...target };
}

function rowState(table, index, access) {
    const state = access.getRowState?.(table, index);
    if (state !== undefined && !['active', 'archived', 'deleted', 'pending-deletion'].includes(state)) fail('RELATION_LIFECYCLE_INVALID');
    // Only a trusted lifecycle adapter can identify compaction archives that reuse is_delete.
    if (state === 'archived') return state;
    if (isDeletedRow(table, index)) return 'deleted';
    if (table.rowStatuses?.[index] === 'pending-deletion') return 'pending-deletion';
    return state ?? 'active';
}

function label(table, rowIndex) {
    const columnIndex = table.columns.findIndex(column => !own(column, 'recordRelation'));
    return String(table.rows[rowIndex][columnIndex] ?? table.rowMeta[rowIndex].id).slice(0, RECORD_RELATION_LIMITS.labelChars);
}

function resolveIds(index, source, relation, ids, access) {
    const target = targetTable(index, source, relation, access);
    return ids.map(rowId => {
        const base = { tableId: relation.targetTableId, rowId };
        if (!target.table) return { ...base, status: target.status };
        const rowIndex = target.rows.get(rowId);
        if (rowIndex === undefined) return { ...base, status: 'missing' };
        return { ...base, status: rowState(target.table, rowIndex, access), label: label(target.table, rowIndex) };
    });
}

/** Read-only diagnostics preserve broken cells; no automatic repairs or label-based rebinding. */
export function inspectRecordRelation(state, request, access) {
    try {
        const index = indexState(state);
        const source = sourceField(index, request, access);
        const relation = definition(source.column);
        const rowIndex = source.rows.get(request.rowId);
        if (rowIndex === undefined) fail('RELATION_SOURCE_MISSING');
        const ids = decodeRecordRelation(source.table.rows[rowIndex][source.columnIndex], relation);
        return { status: ids.length ? 'resolved' : 'empty', relation,
            records: resolveIds(index, source.table, relation, ids, access) };
    } catch (error) {
        return { status: error.code === 'RELATION_ACCESS_DENIED' ? 'forbidden' : 'invalid', code: error.code || 'RELATION_STATE_INVALID', records: [] };
    }
}

export function searchRecordRelationTargets(state, request, access) {
    const index = indexState(state);
    const source = sourceField(index, request, access);
    const relation = definition(source.column);
    const target = targetTable(index, source.table, relation, access);
    if (!target.table) return { status: target.status, records: [], hasMore: false };
    const query = request.query ?? '';
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 50;
    if (typeof query !== 'string' || query.length > RECORD_RELATION_LIMITS.queryChars
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit)
        || limit < 1 || limit > RECORD_RELATION_LIMITS.pageSize) fail('RELATION_QUERY_INVALID');
    const records = [];
    let matched = 0;
    for (const [rowId, rowIndex] of target.rows) {
        if (rowState(target.table, rowIndex, access) !== 'active') continue;
        const display = label(target.table, rowIndex);
        if (!`${display}\n${rowId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        if (matched++ < offset) continue;
        if (records.length === limit) return { status: 'ok', records, hasMore: true };
        records.push({ tableId: target.table.id, rowId, label: display, status: 'active' });
    }
    return { status: 'ok', records, hasMore: false };
}

function assertTargets(index, source, relation, ids, access, allowArchived = false) {
    const target = targetTable(index, source, relation, access);
    if (!target.table) fail(target.status === 'forbidden' ? 'RELATION_ACCESS_DENIED' : 'RELATION_TARGET_MISSING');
    for (const record of resolveIds(index, source, relation, ids, access)) {
        if (record.status === 'active' || (allowArchived && record.status === 'archived')) continue;
        fail(`RELATION_TARGET_${record.status.toUpperCase().replaceAll('-', '_')}`);
    }
}

/** Inspect every source, including invisible owners and historical rows, without leaking their data. */
export function previewRecordDeletion(state, request, access) {
    const index = indexState(state);
    group(access);
    const target = index.get(request?.tableId);
    if (!writable(target?.table, access)) fail('RELATION_ACCESS_DENIED');
    if (!target.rows.has(request.rowId)) fail('RELATION_TARGET_MISSING');
    const visible = [];
    let hiddenCount = 0;
    let invalid = false;
    try {
        scanReferences(index, (table, column, rowIndex, relation, ids) => {
            if (relation.targetTableId !== target.table.id || !ids.includes(request.rowId)) return;
            if (readable(table, access) && visible.length < RECORD_RELATION_LIMITS.pageSize) {
                visible.push({ tableId: table.id, rowId: table.rowMeta[rowIndex].id,
                    columnId: column.id, label: label(table, rowIndex), writable: writable(table, access) });
            } else hiddenCount += 1;
        });
    } catch { invalid = true; }
    return { allowed: !invalid && !visible.length && !hiddenCount, visible, hiddenCount,
        reasons: [...(invalid ? ['RELATION_INTEGRITY_UNKNOWN'] : []),
            ...(visible.length || hiddenCount ? ['RELATION_RESTRICTED'] : [])] };
}

function scanReferences(index, visit) {
    let edges = 0;
    for (const { table } of index.values()) {
        table.columns.forEach((column, columnIndex) => {
            if (!own(column, 'recordRelation')) return;
            const relation = definition(column);
            table.rows.forEach((row, rowIndex) => {
                const ids = decodeRecordRelation(row[columnIndex], relation);
                edges += ids.length;
                if (edges > RECORD_RELATION_LIMITS.edges) fail('RELATION_LIMIT');
                visit(table, column, rowIndex, relation, ids);
            });
        });
    }
}

/** Global preflight for main's commit lane. Run BEFORE normalization can repair duplicate IDs. */
export function assertRecordRelationTransition(before, after, access) {
    if (!hasRelations(before) && !hasRelations(after)) return true;
    const oldIndex = indexState(before);
    const nextIndex = indexState(after);
    group(access);
    let edges = 0;
    for (const { table, rows } of nextIndex.values()) {
        const old = oldIndex.get(table.id);
        table.columns.forEach((column, columnIndex) => {
            if (!own(column, 'recordRelation')) return;
            const relation = definition(column);
            if (table.primaryKey?.columnIds?.includes(column.id)) fail('RELATION_SCHEMA_INVALID');
            const oldColumnIndex = old?.table.columns.findIndex(item => item.id === column.id) ?? -1;
            const oldColumn = old?.table.columns[oldColumnIndex];
            const schemaChanged = JSON.stringify(oldColumn?.recordRelation) !== JSON.stringify(column.recordRelation);
            for (const [rowId, rowIndex] of rows) {
                const ids = decodeRecordRelation(table.rows[rowIndex][columnIndex], relation);
                edges += ids.length;
                if (edges > RECORD_RELATION_LIMITS.edges) fail('RELATION_LIMIT');
                const oldRow = old?.rows.get(rowId);
                const changed = schemaChanged || oldRow === undefined || old?.table.owner !== table.owner
                    || old?.table.groupId !== table.groupId
                    || old.table.rows[oldRow][oldColumnIndex] !== table.rows[rowIndex][columnIndex];
                const restored = oldRow !== undefined && rowState(old.table, oldRow, access) !== 'active'
                    && rowState(table, rowIndex, access) === 'active';
                if (changed || restored) {
                    if (!writable(table, access) || (old && !writable(old.table, access))) fail('RELATION_ACCESS_DENIED');
                    assertTargets(nextIndex, table, relation, ids, access, restored && !changed);
                }
            }
            if (schemaChanged && (!writable(table, access) || (old && !writable(old.table, access)))) fail('RELATION_ACCESS_DENIED');
        });
    }
    assertRecordRelationDeletionTransition(before, after, access);
    validateRecordRelationState(after, access);
    return true;
}

/** Pure common-writer preimage guard; no caller/access needed, no state mutation or repair. */
export function assertRecordRelationDeletionTransition(before, after, options = {}) {
    if (!hasRelations(before) && !hasRelations(after)) return true;
    if (!Array.isArray(after)) fail('RELATION_STATE_INVALID');
    const oldIndex = relationIndex(before);
    const oldLifecycle = { getRowState: createVerifiedRelationLifecycleReader(before, options.beforeRelationLifecycleProof) };
    const lifecycle = { getRowState: createVerifiedRelationLifecycleReader(after, options.relationLifecycleProof) };
    // A persisted archive may retain old edges, never gain a new one through another writer.
    const allNext = relationIndex(after);
    scanReferences(allNext, (source, column, index, relation, ids) => {
        const target = allNext.get(relation.targetTableId);
        const oldSource = oldIndex.get(source.id);
        const oldRow = oldSource?.rows.get(source.rowMeta[index].id);
        const oldColumnIndex = oldSource?.table.columns.findIndex(item => item.id === column.id) ?? -1;
        const oldColumn = oldSource?.table.columns[oldColumnIndex];
        const sameField = oldRow !== undefined && oldColumnIndex >= 0
            && oldSource.table.owner === source.owner && oldSource.table.groupId === source.groupId
            && JSON.stringify(oldColumn.recordRelation) === JSON.stringify(column.recordRelation);
        const previousIds = sameField ? decodeRecordRelation(oldSource.table.rows[oldRow][oldColumnIndex], relation) : [];
        for (const rowId of ids) {
            const targetRow = target?.rows.get(rowId);
            if (targetRow !== undefined && rowState(target.table, targetRow, lifecycle) === 'archived'
                && !previousIds.includes(rowId)) fail('RELATION_TARGET_ARCHIVED');
        }
    });
    const nextIndex = indexState(after.filter(table => oldIndex.has(table?.id)));
    for (const { table } of oldIndex.values()) {
        const next = nextIndex.get(table.id);
        for (const column of table.columns) {
            if (!own(column, 'recordRelation')) continue;
            const nextColumn = next?.table.columns.find(item => item.id === column.id);
            if (!nextColumn || !own(nextColumn, 'recordRelation')) fail('RELATION_SCHEMA_REMOVAL_UNSUPPORTED');
            definition(nextColumn);
            if (next.table.owner !== table.owner || next.table.groupId !== table.groupId) fail('RELATION_RESTRICTED');
        }
    }
    // Follow preimage edges, not candidate edges: clear+delete in the same batch cannot bypass restrict.
    scanReferences(oldIndex, (_source, _column, _rowIndex, relation, ids) => {
        const previous = oldIndex.get(relation.targetTableId);
        const next = nextIndex.get(relation.targetTableId);
        for (const rowId of ids) {
            const previousRow = previous?.rows.get(rowId);
            // Already-missing historical identities may be explicitly repaired; they were not deleted here.
            if (previousRow === undefined) continue;
            const nextRow = next?.rows.get(rowId);
            if (nextRow === undefined || next.table.owner !== previous.table.owner
                || next.table.groupId !== previous.table.groupId) fail('RELATION_RESTRICTED');
            const previousStatus = rowState(previous.table, previousRow, oldLifecycle);
            const nextStatus = rowState(next.table, nextRow, lifecycle);
            if (nextStatus !== 'active' && nextStatus !== 'archived' && nextStatus !== previousStatus) fail('RELATION_RESTRICTED');
        }
    });
    return true;
}

export function previewValueReferenceMigration(state, request, access) {
    const index = indexState(state);
    const source = sourceField(index, request, access, true);
    if (own(source.column, 'recordRelation') || source.column.type !== 'reference'
        || !source.column.references || source.table.rows.length > RECORD_RELATION_LIMITS.migrationRows
        || source.column.primaryKey || source.column.unique
        || source.table.primaryKey?.columnIds?.includes(source.column.id)) fail('RELATION_MIGRATION_UNSUPPORTED');
    const relation = normalizeRecordRelation({ kind: 'record', version: 1,
        targetTableId: source.column.references.tableId, cardinality: 'one',
        required: source.column.required === true, onDelete: 'restrict' });
    const target = targetTable(index, source.table, relation, access);
    if (!target.table) fail('RELATION_ACCESS_DENIED');
    const targetColumn = target.table.columns.findIndex(column => column.id === source.column.references.columnId);
    if (targetColumn < 0) fail('RELATION_COLUMN_MISSING');
    const matches = new Map();
    for (const [rowId, rowIndex] of target.rows) {
        if (rowState(target.table, rowIndex, access) !== 'active') continue;
        const value = target.table.rows[rowIndex][targetColumn];
        if (!matches.has(value)) matches.set(value, []);
        const ids = matches.get(value);
        if (ids.length < 2) ids.push(rowId);
    }
    const rows = source.table.rows.map((row, rowIndex) => {
        const value = row[source.columnIndex];
        const ids = value === '' ? [] : matches.get(value) || [];
        const status = value === '' ? (relation.required ? 'missing' : 'empty')
            : ids.length === 1 ? 'matched' : ids.length ? 'ambiguous' : 'missing';
        return { rowId: source.table.rowMeta[rowIndex].id, status,
            rowIds: status === 'matched' ? ids : [] };
    });
    return { ok: rows.every(row => ['matched', 'empty'].includes(row.status)), relation, rows };
}

/** Pure isolated candidate. Persistence, CAS, full legacy validation and backup storage belong to main. */
export function createRecordRelationCandidate(state, request, access) {
    const draft = clone(state);
    const index = indexState(draft);
    const source = sourceField(index, request, access, true);
    let repairBackup = null;
    if (request.type === 'configure') {
        const relation = normalizeRecordRelation(request.relation);
        const existing = own(source.column, 'recordRelation');
        if (!existing && (source.column.type !== 'string' || source.column.references != null
            || source.table.rows.some(row => row[source.columnIndex] !== ''))) fail('RELATION_EXPLICIT_MIGRATION_REQUIRED');
        if (existing) definition(source.column);
        source.column.recordRelation = relation;
        definition(source.column);
        assertTargets(index, source.table, relation, [], access);
    } else if (request.type === 'set') {
        const relation = definition(source.column);
        const rowIndex = source.rows.get(request.rowId);
        if (rowIndex === undefined) fail('RELATION_SOURCE_MISSING');
        if (rowState(source.table, rowIndex, access) !== 'active') fail('RELATION_SOURCE_INACTIVE');
        assertTargets(index, source.table, relation, checkIds(request.rowIds, relation), access);
        source.table.rows[rowIndex][source.columnIndex] = encodeRecordRelation(relation, request.rowIds);
    } else if (request.type === 'migrate') {
        const preview = previewValueReferenceMigration(state, request, access);
        if (!preview.ok) fail('RELATION_MIGRATION_UNRESOLVED');
        repairBackup = { format: 'amily2.record-relation-migration', version: 1,
            tableId: source.table.id, columnId: source.column.id, column: clone(source.column),
            cells: source.table.rows.map((row, i) => ({ rowId: source.table.rowMeta[i].id, value: row[source.columnIndex] })) };
        source.column.type = 'string';
        delete source.column.references;
        delete source.column.required;
        source.column.recordRelation = preview.relation;
        preview.rows.forEach((row, i) => { source.table.rows[i][source.columnIndex] = encodeRecordRelation(preview.relation, row.rowIds); });
    } else fail('RELATION_OPERATION_UNSUPPORTED');
    assertRecordRelationTransition(state, draft, access);
    return { state: draft, repairBackup };
}
