import {
    createRecordMetadata,
    deepClone,
    normalizeTableDatabaseState,
    normalizeTableIdentity,
} from './infra/database-state.js';

const definitions = new Map();
const COLUMN_TYPES = new Set(['string', 'number', 'boolean', 'datetime', 'reference']);
const DELETE_POLICIES = new Set(['restrict', 'setNull']);
const QUERY_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isEmpty']);

export function registerTableDefinition(caller, definition) {
    const normalized = normalizeDefinition(caller, definition);
    const existing = definitions.get(normalized.id);
    if (existing && !isCompatibleDefinition(existing, normalized)) {
        throw tableError('TABLE_DEFINITION_CONFLICT', `Incompatible definition for table "${normalized.id}".`);
    }
    definitions.set(normalized.id, normalized);
    return deepClone(normalized);
}

export function ensureRegisteredTable(caller, tableId, currentState) {
    const definition = requireDefinition(tableId);
    assertOwner(caller, definition);

    const state = normalizeTableDatabaseState(deepClone(currentState || []));
    const existing = state.find(table => table.id === tableId);
    if (existing) {
        if (existing.owner !== caller) {
            throw tableError('TABLE_ACCESS_DENIED', `Table "${tableId}" belongs to "${existing.owner}".`);
        }
        return { state, table: deepClone(existing), created: false };
    }

    const table = {
        id: definition.id,
        owner: definition.owner,
        schemaVersion: definition.schemaVersion,
        name: definition.name,
        headers: definition.columns.map(column => column.label),
        columns: deepClone(definition.columns),
        rows: [],
        rowMeta: [],
        rowStatuses: [],
        columnWidths: deepClone(definition.columnWidths),
        note: definition.note,
        rule_add: definition.rule_add,
        rule_delete: definition.rule_delete,
        rule_update: definition.rule_update,
        charLimitRules: deepClone(definition.charLimitRules),
        rowLimitRule: definition.rowLimitRule,
    };

    // Add the table first so initial rows may safely reference a previously added row in it.
    state.push(table);
    for (const values of definition.initialRows) {
        appendRecord(table, values);
        validateStateConstraints(state);
    }
    return { state, table: deepClone(table), created: true };
}

export function mutateOwnedRecord(caller, request, currentState) {
    const { tableId, action, recordId, values } = request || {};
    const state = normalizeTableDatabaseState(deepClone(currentState || []));
    const table = state.find(item => item.id === tableId);
    if (!table) throw tableError('TABLE_NOT_FOUND', `Table "${tableId}" is not initialized.`);
    assertOwner(caller, table);

    if (action === 'insert') {
        const rowIndex = appendRecord(table, values);
        validateStateConstraints(state);
        return { state, result: { action, tableId, recordId: table.rowMeta[rowIndex].id, rowIndex } };
    }

    const rowIndex = table.rowMeta.findIndex(meta => meta.id === recordId);
    if (rowIndex < 0) throw tableError('RECORD_NOT_FOUND', `Record "${recordId}" is not present in "${tableId}".`);

    if (action === 'update') {
        patchRecord(table, rowIndex, values);
        validateStateConstraints(state);
        return { state, result: { action, tableId, recordId, rowIndex } };
    }
    if (action === 'delete') {
        deleteRecordWithReferences(state, table, rowIndex);
        validateStateConstraints(state);
        return { state, result: { action, tableId, recordId, rowIndex } };
    }
    throw tableError('INVALID_RECORD_ACTION', `Unsupported record action "${action}".`);
}

/**
 * Read-only deterministic record query. It intentionally omits joins and formulas;
 * views will build on this validated single-table primitive.
 */
export function queryTableRecords(tableId, request, currentState) {
    const state = normalizeTableDatabaseState(deepClone(currentState || []));
    const table = state.find(item => item.id === tableId);
    if (!table) throw tableError('TABLE_NOT_FOUND', `Table "${tableId}" is not initialized.`);

    const query = normalizeQuery(table, request);
    const columnIndex = new Map(table.columns.map((column, index) => [column.id, index]));
    const records = table.rows.map((row, rowIndex) => ({
        recordId: table.rowMeta[rowIndex].id,
        rowIndex,
        row,
    })).filter(record => query.filters.every(filter => matchesFilter(record.row[columnIndex.get(filter.columnId)], filter)));

    records.sort((left, right) => compareRecords(left, right, query.sort, columnIndex, table.columns));
    const limited = query.limit === null ? records : records.slice(0, query.limit);
    const columns = query.select.map(columnId => table.columns[columnIndex.get(columnId)]);

    return {
        tableId: table.id,
        schemaVersion: table.schemaVersion,
        columns: deepClone(columns),
        records: limited.map(record => ({
            recordId: record.recordId,
            values: Object.fromEntries(query.select.map(columnId => [columnId, String(record.row[columnIndex.get(columnId)] ?? '')])),
        })),
    };
}

function normalizeDefinition(caller, definition) {
    if (!definition || typeof definition !== 'object') {
        throw tableError('INVALID_TABLE_DEFINITION', 'Table definition must be an object.');
    }
    if (!validId(definition.id) || !validId(definition.name) || !Array.isArray(definition.columns) || !definition.columns.length) {
        throw tableError('INVALID_TABLE_DEFINITION', 'Definition requires id, name and at least one column.');
    }
    if (definition.owner !== caller) {
        throw tableError('TABLE_ACCESS_DENIED', `Caller "${caller}" cannot register a table owned by "${definition.owner}".`);
    }

    const columnIds = new Set();
    const columns = definition.columns.map(column => {
        if (!column || !validId(column.id) || !validId(column.label)) {
            throw tableError('INVALID_TABLE_DEFINITION', 'Every column requires stable id and label.');
        }
        if (columnIds.has(column.id)) {
            throw tableError('INVALID_TABLE_DEFINITION', `Duplicate column id "${column.id}".`);
        }
        columnIds.add(column.id);
        return normalizeColumnDefinition(column);
    });

    if (columns.filter(column => column.primaryKey).length > 1) {
        throw tableError('INVALID_TABLE_DEFINITION', 'A table may declare only one business primary-key column.');
    }

    return Object.freeze({
        id: definition.id,
        owner: caller,
        schemaVersion: positiveInteger(definition.schemaVersion, 1),
        name: definition.name,
        columns,
        initialRows: Array.isArray(definition.initialRows) ? deepClone(definition.initialRows) : [],
        columnWidths: Array.isArray(definition.columnWidths) ? deepClone(definition.columnWidths) : [],
        note: String(definition.note || ''),
        rule_add: String(definition.rule_add || '允许'),
        rule_delete: String(definition.rule_delete || '允许'),
        rule_update: String(definition.rule_update || '允许'),
        charLimitRules: deepClone(definition.charLimitRules || {}),
        rowLimitRule: Number.isInteger(definition.rowLimitRule) ? definition.rowLimitRule : 0,
    });
}

function normalizeColumnDefinition(column) {
    const type = COLUMN_TYPES.has(column.type) ? column.type : 'string';
    const references = normalizeReference(column.references, column.id, type);
    const primaryKey = column.primaryKey === true;
    const required = primaryKey || column.required === true;
    const unique = primaryKey || column.unique === true;

    if (references?.onDelete === 'setNull' && required) {
        throw tableError('INVALID_TABLE_DEFINITION', `Reference column "${column.id}" cannot be required with setNull deletion.`);
    }

    return { id: column.id, label: column.label, type, required, unique, primaryKey, ...(references ? { references } : {}) };
}

function normalizeReference(reference, columnId, type) {
    if (reference === undefined || reference === null) return null;
    if (type !== 'reference') {
        throw tableError('INVALID_TABLE_DEFINITION', `Column "${columnId}" must use type "reference" when declaring references.`);
    }
    if (!reference || typeof reference !== 'object' || !validId(reference.tableId) || !validId(reference.columnId)) {
        throw tableError('INVALID_TABLE_DEFINITION', `Reference column "${columnId}" requires target tableId and columnId.`);
    }
    const onDelete = reference.onDelete || 'restrict';
    if (!DELETE_POLICIES.has(onDelete)) {
        throw tableError('INVALID_REFERENCE_DELETE_POLICY', `Reference column "${columnId}" uses unsupported onDelete policy "${onDelete}".`);
    }
    return { tableId: reference.tableId, columnId: reference.columnId, onDelete };
}

function appendRecord(table, values) {
    normalizeTableIdentity(table);
    const row = Array(table.columns.length).fill('');
    writeValues(table, row, values, false);
    const rowIndex = table.rows.length;
    table.rows.push(row);
    table.rowStatuses.push('normal');
    table.rowMeta.push(createRecordMetadata(table, row, rowIndex));
    return rowIndex;
}

function patchRecord(table, rowIndex, values) {
    writeValues(table, table.rows[rowIndex], values, true);
}

function writeValues(table, row, values, patch) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw tableError('INVALID_RECORD_VALUES', 'Record values must be an object keyed by column id.');
    }
    const columns = new Map(table.columns.map((column, index) => [column.id, index]));
    for (const [columnId, value] of Object.entries(values)) {
        const index = columns.get(columnId);
        if (index === undefined) {
            throw tableError('UNKNOWN_COLUMN', `Column "${columnId}" does not belong to "${table.id}".`);
        }
        row[index] = String(value ?? '');
    }
    if (!patch && !Object.keys(values).length) {
        throw tableError('INVALID_RECORD_VALUES', 'Initial records cannot be empty.');
    }
}

function validateStateConstraints(state) {
    state.forEach(table => validateTableConstraints(state, table));
}

function validateTableConstraints(state, table) {
    normalizeTableIdentity(table);
    const columnIndex = new Map(table.columns.map((column, index) => [column.id, index]));
    const uniqueValues = new Map();
    table.columns.forEach(column => {
        if (column.unique || column.primaryKey) uniqueValues.set(column.id, new Map());
    });

    table.rows.forEach((row, rowIndex) => {
        table.columns.forEach((column, columnIndex) => {
            const value = String(row[columnIndex] ?? '');
            if (column.required && isBlank(value)) {
                throw tableError('REQUIRED_VALUE_MISSING', `Column "${column.id}" requires a value in table "${table.id}".`);
            }
            validateValueType(table, column, value);

            const seen = uniqueValues.get(column.id);
            if (seen && !isBlank(value)) {
                if (seen.has(value)) {
                    throw tableError('UNIQUE_CONSTRAINT_VIOLATION', `Column "${column.id}" contains duplicate value "${value}" in table "${table.id}".`);
                }
                seen.set(value, rowIndex);
            }
        });
    });

    table.rows.forEach(row => {
        table.columns.forEach((column, index) => {
            if (!column.references) return;
            const value = String(row[index] ?? '');
            if (isBlank(value)) return;
            const targetTable = state.find(candidate => candidate.id === column.references.tableId);
            if (!targetTable) {
                throw tableError('REFERENCE_TARGET_NOT_FOUND', `Reference "${table.id}.${column.id}" target table "${column.references.tableId}" is unavailable.`);
            }
            const targetIndex = targetTable.columns.findIndex(target => target.id === column.references.columnId);
            if (targetIndex < 0) {
                throw tableError('REFERENCE_TARGET_COLUMN_NOT_FOUND', `Reference "${table.id}.${column.id}" target column "${column.references.columnId}" is unavailable.`);
            }
            const targetColumn = targetTable.columns[targetIndex];
            if (!targetColumn.unique && !targetColumn.primaryKey) {
                throw tableError('REFERENCE_TARGET_NOT_UNIQUE', `Reference "${table.id}.${column.id}" must target a unique column.`);
            }
            if (!targetTable.rows.some(targetRow => String(targetRow[targetIndex] ?? '') === value)) {
                throw tableError('FOREIGN_KEY_VIOLATION', `Reference "${table.id}.${column.id}" points to missing value "${value}".`);
            }
        });
    });
}

function validateValueType(table, column, value) {
    if (isBlank(value) || column.type === 'string' || column.type === 'reference') return;
    if (column.type === 'number' && !Number.isFinite(Number(value))) {
        throw tableError('INVALID_COLUMN_VALUE', `Column "${column.id}" in table "${table.id}" requires a finite number.`);
    }
    if (column.type === 'boolean' && !['true', 'false', '1', '0'].includes(value.toLowerCase())) {
        throw tableError('INVALID_COLUMN_VALUE', `Column "${column.id}" in table "${table.id}" requires a boolean value.`);
    }
    if (column.type === 'datetime' && Number.isNaN(Date.parse(value))) {
        throw tableError('INVALID_COLUMN_VALUE', `Column "${column.id}" in table "${table.id}" requires a parseable datetime.`);
    }
}

function deleteRecordWithReferences(state, targetTable, rowIndex) {
    const pendingNulls = [];
    targetTable.columns.forEach((targetColumn, targetColumnIndex) => {
        const targetValue = String(targetTable.rows[rowIndex][targetColumnIndex] ?? '');
        if (isBlank(targetValue)) return;

        state.forEach(sourceTable => {
            sourceTable.columns.forEach((sourceColumn, sourceColumnIndex) => {
                if (sourceColumn.references?.tableId !== targetTable.id || sourceColumn.references?.columnId !== targetColumn.id) return;
                sourceTable.rows.forEach((sourceRow, sourceRowIndex) => {
                    if (sourceTable === targetTable && sourceRowIndex === rowIndex) return;
                    if (String(sourceRow[sourceColumnIndex] ?? '') !== targetValue) return;
                    if (sourceColumn.references.onDelete === 'restrict') {
                        throw tableError('REFERENCE_RESTRICTED', `Cannot delete "${targetTable.id}" record while "${sourceTable.id}.${sourceColumn.id}" references it.`);
                    }
                    if (sourceColumn.required) {
                        throw tableError('REFERENCE_SET_NULL_REQUIRED', `Cannot set required reference "${sourceTable.id}.${sourceColumn.id}" to null.`);
                    }
                    pendingNulls.push({ sourceRow, sourceColumnIndex });
                });
            });
        });
    });

    pendingNulls.forEach(({ sourceRow, sourceColumnIndex }) => {
        sourceRow[sourceColumnIndex] = '';
    });
    targetTable.rows.splice(rowIndex, 1);
    targetTable.rowMeta.splice(rowIndex, 1);
    targetTable.rowStatuses.splice(rowIndex, 1);
}

function normalizeQuery(table, request) {
    if (request === undefined || request === null) request = {};
    if (typeof request !== 'object' || Array.isArray(request)) {
        throw tableError('INVALID_QUERY', 'Query must be an object.');
    }
    const columnIds = new Set(table.columns.map(column => column.id));
    const select = request.select === undefined ? [...columnIds] : request.select;
    if (!Array.isArray(select) || !select.length || select.some(columnId => !columnIds.has(columnId))) {
        throw tableError('INVALID_QUERY', 'Query select must contain known column ids.');
    }
    if (new Set(select).size !== select.length) {
        throw tableError('INVALID_QUERY', 'Query select cannot repeat column ids.');
    }

    const rawFilters = request.filters ?? request.where ?? [];
    if (!Array.isArray(rawFilters)) throw tableError('INVALID_QUERY', 'Query filters must be an array.');
    const filters = rawFilters.map(filter => {
        if (!filter || typeof filter !== 'object' || !columnIds.has(filter.columnId)) {
            throw tableError('INVALID_QUERY', 'Every filter requires a known columnId.');
        }
        const op = filter.op || 'eq';
        if (!QUERY_OPERATORS.has(op)) throw tableError('INVALID_QUERY_OPERATOR', `Unsupported query operator "${op}".`);
        if (op !== 'isEmpty' && !Object.prototype.hasOwnProperty.call(filter, 'value')) {
            throw tableError('INVALID_QUERY', `Query operator "${op}" requires a value.`);
        }
        return { columnId: filter.columnId, op, value: filter.value };
    });

    const rawSort = request.sort ?? [];
    if (!Array.isArray(rawSort)) throw tableError('INVALID_QUERY', 'Query sort must be an array.');
    const sort = rawSort.map(item => {
        if (!item || typeof item !== 'object' || !columnIds.has(item.columnId)) {
            throw tableError('INVALID_QUERY', 'Every sort entry requires a known columnId.');
        }
        const direction = String(item.direction || 'asc').toLowerCase();
        if (direction !== 'asc' && direction !== 'desc') {
            throw tableError('INVALID_QUERY', 'Sort direction must be asc or desc.');
        }
        return { columnId: item.columnId, direction };
    });

    const limit = request.limit === undefined ? null : Number(request.limit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
        throw tableError('INVALID_QUERY', 'Query limit must be a non-negative integer.');
    }
    return { select: [...select], filters, sort, limit };
}

function matchesFilter(rawValue, filter) {
    const value = String(rawValue ?? '');
    if (filter.op === 'isEmpty') return isBlank(value);
    const expected = String(filter.value ?? '');
    if (filter.op === 'eq') return value === expected;
    if (filter.op === 'neq') return value !== expected;
    if (filter.op === 'contains') return value.includes(expected);

    const actualNumber = Number(value);
    const expectedNumber = Number(expected);
    if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
    if (filter.op === 'gt') return actualNumber > expectedNumber;
    if (filter.op === 'gte') return actualNumber >= expectedNumber;
    if (filter.op === 'lt') return actualNumber < expectedNumber;
    return actualNumber <= expectedNumber;
}

function compareRecords(left, right, sort, columnIndex, columns) {
    for (const item of sort) {
        const index = columnIndex.get(item.columnId);
        const column = columns[index];
        const compared = compareValues(left.row[index], right.row[index], column.type);
        if (compared !== 0) return item.direction === 'desc' ? -compared : compared;
    }
    return left.rowIndex - right.rowIndex;
}

function compareValues(left, right, type) {
    const a = String(left ?? '');
    const b = String(right ?? '');
    if (type === 'number') {
        const numeric = Number(a) - Number(b);
        if (Number.isFinite(numeric) && numeric !== 0) return numeric;
    }
    return a === b ? 0 : (a < b ? -1 : 1);
}

function requireDefinition(tableId) {
    const definition = definitions.get(tableId);
    if (!definition) throw tableError('TABLE_DEFINITION_NOT_FOUND', `Table "${tableId}" is not registered.`);
    return definition;
}

function assertOwner(caller, table) {
    if (table.owner !== caller) {
        throw tableError('TABLE_ACCESS_DENIED', `Caller "${caller}" cannot modify table "${table.id}" owned by "${table.owner}".`);
    }
}

function isCompatibleDefinition(a, b) {
    return a.owner === b.owner
        && a.schemaVersion === b.schemaVersion
        && JSON.stringify(a.columns) === JSON.stringify(b.columns);
}

function isBlank(value) {
    return String(value ?? '').trim().length === 0;
}

function tableError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validId(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
