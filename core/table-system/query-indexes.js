import { isInactiveRow } from './row-lifecycle.js';

export const QUERY_INDEX_LIMITS = Object.freeze({ definitions: 16, columns: 8, rows: 20000, chars: 4 * 1024 * 1024, terms: 16, termChars: 256, results: 200 });
const FIELDS = new Set(['version', 'id', 'name', 'columnIds', 'mode', 'fieldMatch', 'termMatch', 'caseSensitive', 'trim']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value); }

export function normalizeQueryIndexes(table, definitions = table.indexes ?? []) {
    if (!Array.isArray(definitions) || definitions.length > QUERY_INDEX_LIMITS.definitions) fail('INDEX_CONFIG_INVALID', 'Too many index definitions.');
    const used = new Set();
    const columns = new Set(table.columns?.map(column => column.id));
    if (definitions.length && (!Array.isArray(table.columns) || columns.size !== table.columns.length
        || table.columns.some(column => !id(column?.id)))) {
        fail('INDEX_IDENTITY_INVALID', 'Indexed columns require unique stable IDs.');
    }
    return definitions.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !FIELDS.has(key))
            || raw.version !== 1 || !id(raw.id) || used.has(raw.id)
            || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100
            || !Array.isArray(raw.columnIds) || !raw.columnIds.length || raw.columnIds.length > QUERY_INDEX_LIMITS.columns
            || new Set(raw.columnIds).size !== raw.columnIds.length || raw.columnIds.some(key => !columns.has(key))
            || !['exact', 'keywords'].includes(raw.mode) || !['all', 'any'].includes(raw.fieldMatch)
            || !['all', 'any'].includes(raw.termMatch) || typeof raw.caseSensitive !== 'boolean' || typeof raw.trim !== 'boolean') {
            fail('INDEX_CONFIG_INVALID', 'Invalid index identity, fields or matching options.');
        }
        used.add(raw.id);
        return { version: 1, id: raw.id, name: raw.name, columnIds: [...raw.columnIds], mode: raw.mode,
            fieldMatch: raw.fieldMatch, termMatch: raw.termMatch, caseSensitive: raw.caseSensitive, trim: raw.trim };
    });
}

function normalizeValue(value, definition) {
    if (value === undefined) return ['missing'];
    if (value === null) return ['null'];
    if (typeof value === 'number' && Number.isFinite(value)) return ['number', value];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value !== 'string') fail('INDEX_VALUE_INVALID', 'Unsupported index value.');
    let text = definition.trim ? value.trim() : value;
    if (!definition.caseSensitive) text = text.toLowerCase();
    return ['string', text];
}

// Built from a caller-authorized snapshot for one query. No cross-chat cache or
// retained source values survive this function, so stale indexes cannot leak in.
export function queryTableIndex(table, indexId, query, access) {
    if (!table || table.owner !== 'user' || access?.owner !== 'user' || !access.groupId || table.groupId !== access.groupId) {
        fail('INDEX_ACCESS_DENIED', 'The table is not available in this scope.');
    }
    const definition = normalizeQueryIndexes(table).find(item => item.id === indexId);
    if (!definition) fail('INDEX_NOT_FOUND', 'Index not found.');
    if (!Array.isArray(access.columnIds) || definition.columnIds.some(key => !access.columnIds.includes(key))) {
        fail('INDEX_ACCESS_DENIED', 'Index columns are outside the authorized projection.');
    }
    if (!query || !Array.isArray(query.values) || query.values.length !== definition.columnIds.length
        || !Number.isInteger(query.limit ?? 50) || (query.limit ?? 50) < 1 || (query.limit ?? 50) > QUERY_INDEX_LIMITS.results) {
        fail('INDEX_QUERY_INVALID', 'Supply one value per index field and a bounded result limit.');
    }
    const indices = definition.columnIds.map(key => table.columns.findIndex(column => column.id === key));
    let terms;
    let expected;
    if (definition.mode === 'keywords') {
        terms = query.values.map(values => {
            if (!Array.isArray(values) || !values.length || values.length > QUERY_INDEX_LIMITS.terms
                || values.some(value => typeof value !== 'string' || !value.trim() || value.length > QUERY_INDEX_LIMITS.termChars)) {
                fail('INDEX_QUERY_INVALID', 'Keyword fields need nonempty bounded terms.');
            }
            return values.map(value => normalizeValue(value, definition)[1]);
        });
    } else {
        if (query.values.some(value => typeof value === 'string' && value.length > QUERY_INDEX_LIMITS.termChars)) fail('INDEX_QUERY_INVALID', 'Query value too long.');
        expected = query.values.map(value => JSON.stringify(normalizeValue(value, definition)));
    }
    if (!Array.isArray(table.rows) || table.rows.length > QUERY_INDEX_LIMITS.rows) fail('INDEX_LIMIT', 'Index row limit exceeded.');
    let chars = 0;
    let matches = 0;
    const results = [];
    const ids = new Set();
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
        if (isInactiveRow(table, rowIndex)) continue;
        if (!Array.isArray(table.rows[rowIndex])) fail('INDEX_VALUE_INVALID', 'Indexed records must be cell arrays.');
        const rowId = table.rowMeta?.[rowIndex]?.id;
        if (!id(rowId) || ids.has(rowId)) fail('INDEX_IDENTITY_INVALID', 'Active records require unique stable IDs.');
        ids.add(rowId);
        const fields = indices.map((columnIndex, fieldIndex) => {
            const value = normalizeValue(table.rows[rowIndex]?.[columnIndex], definition);
            const encoded = JSON.stringify(value);
            chars += encoded.length;
            if (chars > QUERY_INDEX_LIMITS.chars) fail('INDEX_LIMIT', 'Index input budget exceeded.');
            if (definition.mode === 'exact') return encoded === expected[fieldIndex];
            if (value[0] !== 'string') return false;
            const hits = terms[fieldIndex].map(term => value[1].includes(term));
            return definition.termMatch === 'all' ? hits.every(Boolean) : hits.some(Boolean);
        });
        const hit = definition.fieldMatch === 'all' ? fields.every(Boolean) : fields.some(Boolean);
        if (!hit) continue;
        matches++;
        if (results.length < (query.limit ?? 50)) results.push({ rowId, matchedColumnIds: definition.columnIds.filter((_, i) => fields[i]) });
    }
    return { indexId, matches, truncated: matches > results.length, records: results };
}
