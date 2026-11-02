import { normalizeQueryIndexes, QUERY_INDEX_LIMITS } from './query-indexes.js';
import { isInactiveRow } from './row-lifecycle.js';

export const INDEX_WORLDBOOK_NAMESPACE = 'amily2.index-worldbook@1';
// SillyTavern/public/scripts/world-info.js: world_info_logic (not UI labels).
export const INDEX_WORLDBOOK_LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });
export const INDEX_WORLDBOOK_LIMITS = Object.freeze({
    rows: 20000, columns: 128, entries: 200, contentColumns: 16,
    cellChars: 8192, inputChars: 1024 * 1024, outputChars: 512 * 1024,
    terms: QUERY_INDEX_LIMITS.terms, termChars: QUERY_INDEX_LIMITS.termChars,
});
const SNAPSHOT_KEYS = ['chatId', 'epoch', 'groupId', 'stateRevision', 'authorizationRevision', 'configRevision'];
// Both host macro engines support legacy markers; the new engine also
// unescapes backslashed braces. Keep plaintext keys/content unchanged.
const HOST_SUBSTITUTION = /\{\{|\}\}|<(?:user|bot|char|charifnotgroup|group)>|\\[{}]|\u0000/iu;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value); }
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function snapshotOf(value) {
    if (!value || !validId(value.chatId) || !revision(value.epoch) || !validId(value.groupId)
        || SNAPSHOT_KEYS.slice(3).some(key => !revision(value[key]))) fail('WORLDBOOK_SNAPSHOT_INVALID');
    return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, value[key]]));
}
function columnList(value, max) {
    return Array.isArray(value) && value.length > 0 && value.length <= max
        && value.every(validId) && new Set(value).size === value.length;
}

function literalKey(term, caseSensitive) {
    if (caseSensitive) {
        // Only fixed UTF-16 literals: no user regex, flags, macros, or trimmed
        // whitespace reaches the host parser. Regex overrides host case settings.
        let pattern = '';
        for (let i = 0; i < term.length; i++) pattern += `\\u${term.charCodeAt(i).toString(16).padStart(4, '0')}`;
        return `/${pattern}/`;
    }
    // Host plaintext lowercasing is not equivalent to RegExp /i for all Unicode.
    // Do not substitute /i when escaping would change that contract.
    if (term !== term.trim() || /^\/[\s\S]+\/[gimsuy]*$/u.test(term) || HOST_SUBSTITUTION.test(term)) {
        fail('WORLDBOOK_MAPPING_UNSUPPORTED');
    }
    return term;
}

function mapKeys(fields, definition) {
    const logic = INDEX_WORLDBOOK_LOGIC;
    const all = fields.flat();
    if (definition.fieldMatch === 'any' && definition.termMatch === 'any') {
        return { key: all, keysecondary: [], selectiveLogic: logic.AND_ANY };
    }
    if (definition.fieldMatch === 'all' && definition.termMatch === 'all') {
        return { key: [all[0]], keysecondary: all.slice(1), selectiveLogic: logic.AND_ALL };
    }
    if (fields.length === 1) {
        return definition.termMatch === 'any'
            ? { key: all, keysecondary: [], selectiveLogic: logic.AND_ANY }
            : { key: [all[0]], keysecondary: all.slice(1), selectiveLogic: logic.AND_ALL };
    }
    if (fields.every(field => field.length === 1)) {
        return definition.fieldMatch === 'any'
            ? { key: all, keysecondary: [], selectiveLogic: logic.AND_ANY }
            : { key: [all[0]], keysecondary: all.slice(1), selectiveLogic: logic.AND_ALL };
    }
    if (definition.fieldMatch === 'all' && definition.termMatch === 'any' && fields.length === 2) {
        return { key: fields[0], keysecondary: fields[1], selectiveLogic: logic.AND_ANY };
    }
    // OR-of-conjunctions and 3+ groups of alternatives need more than the
    // host's primary OR plus one secondary operator. Never flatten these.
    fail('WORLDBOOK_MAPPING_UNSUPPORTED');
}

/**
 * Project one caller-authorized user-table snapshot. No store, I/O or cache.
 * options: { snapshot, contentColumnIds, primaryColumnId?, termSeparator?, limit? }
 * access: { owner: 'user', groupId, columnIds }. This is a trusted read grant,
 * not a user/card-supplied permission claim. Missing/inactive rows are not read.
 * termSeparator is an explicit literal delimiter; absent means ONE cell term.
 * This maps row-derived keyword activation, not exact tuple query semantics.
 */
export function projectIndexWorldbook(table, indexId, options, access) {
    const snapshot = snapshotOf(options?.snapshot);
    if (Object.keys(options).some(key => !['snapshot', 'contentColumnIds', 'primaryColumnId', 'termSeparator', 'limit'].includes(key))) {
        fail('WORLDBOOK_CONFIG_INVALID');
    }
    if (!table || table.owner !== 'user' || access?.owner !== 'user' || !validId(access.groupId)
        || table.groupId !== access.groupId || snapshot.groupId !== access.groupId || !validId(table.id)
        || !columnList(access.columnIds, INDEX_WORLDBOOK_LIMITS.columns)) fail('WORLDBOOK_ACCESS_DENIED');
    if (!Array.isArray(table.columns) || table.columns.length > INDEX_WORLDBOOK_LIMITS.columns
        || !columnList(table.columns.map(column => column?.id), INDEX_WORLDBOOK_LIMITS.columns)) fail('WORLDBOOK_SCHEMA_INVALID');
    const definition = normalizeQueryIndexes(table).find(item => item.id === indexId);
    if (!definition) fail('INDEX_NOT_FOUND');
    if (definition.mode !== 'keywords') fail('WORLDBOOK_MAPPING_UNSUPPORTED');
    if (!columnList(options.contentColumnIds, INDEX_WORLDBOOK_LIMITS.contentColumns)) fail('WORLDBOOK_CONFIG_INVALID');
    const primary = options.primaryColumnId ?? definition.columnIds[0];
    const separator = options.termSeparator ?? null;
    const limit = options.limit ?? INDEX_WORLDBOOK_LIMITS.entries;
    if (!definition.columnIds.includes(primary) || !Number.isInteger(limit) || limit < 1 || limit > INDEX_WORLDBOOK_LIMITS.entries
        || (separator !== null && (typeof separator !== 'string' || !separator.length || separator.length > 16))) fail('WORLDBOOK_CONFIG_INVALID');
    const fieldIds = [primary, ...definition.columnIds.filter(id => id !== primary)];
    const readIds = [...new Set([...fieldIds, ...options.contentColumnIds])];
    const positions = new Map(table.columns.map((column, index) => [column.id, index]));
    if (readIds.some(id => !access.columnIds.includes(id) || !positions.has(id))) fail('WORLDBOOK_ACCESS_DENIED');
    if (!Array.isArray(table.rows) || table.rows.length > INDEX_WORLDBOOK_LIMITS.rows) fail('WORLDBOOK_LIMIT');
    const entries = [];
    const provenance = [];
    const diagnostics = [];
    const seen = new Set();
    let inputChars = 0;
    let outputChars = 0;
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
        if (isInactiveRow(table, rowIndex)) continue;
        const rowId = table.rowMeta?.[rowIndex]?.id;
        if (!validId(rowId) || seen.has(rowId)) fail('WORLDBOOK_IDENTITY_INVALID');
        seen.add(rowId);
        if (entries.length >= limit) fail('WORLDBOOK_LIMIT');
        const cells = new Map(readIds.map(id => {
            const value = table.rows[rowIndex]?.[positions.get(id)];
            if (!(value === null || typeof value === 'string' || typeof value === 'boolean'
                || (typeof value === 'number' && Number.isFinite(value)))) fail('WORLDBOOK_VALUE_INVALID');
            const size = typeof value === 'string' ? value.length : 8;
            inputChars += size;
            if (size > INDEX_WORLDBOOK_LIMITS.cellChars || inputChars > INDEX_WORLDBOOK_LIMITS.inputChars) fail('WORLDBOOK_LIMIT');
            return [id, value];
        }));
        const normalizations = [];
        const fields = fieldIds.map(id => {
            const cell = cells.get(id);
            if (typeof cell !== 'string') fail('WORLDBOOK_VALUE_INVALID');
            const terms = separator === null ? [cell] : cell.split(separator, INDEX_WORLDBOOK_LIMITS.terms + 1);
            if (!terms.length || terms.length > INDEX_WORLDBOOK_LIMITS.terms) fail('WORLDBOOK_LIMIT');
            const normalized = terms.map(value => definition.trim ? value.trim() : value);
            normalizations.push({ columnId: id, original: terms, normalized,
                compared: normalized.map(value => definition.caseSensitive ? value : value.toLowerCase()) });
            return [...new Set(terms.map(value => {
                const term = definition.trim ? value.trim() : value;
                if (!term.trim() || term.length > INDEX_WORLDBOOK_LIMITS.termChars) fail('WORLDBOOK_VALUE_INVALID');
                return literalKey(term, definition.caseSensitive);
            }))];
        });
        const entryKey = JSON.stringify([INDEX_WORLDBOOK_NAMESPACE, snapshot.chatId, access.groupId, table.id, indexId, rowId]);
        const content = JSON.stringify(options.contentColumnIds.map(id => [id, cells.get(id)]));
        // Host substituteParams also runs on content; a literal preview must not
        // silently turn a cell into a macro at publish/injection time.
        if (HOST_SUBSTITUTION.test(content)) fail('WORLDBOOK_CONTENT_UNSUPPORTED');
        const entry = {
            ...mapKeys(fields, definition), content, comment: entryKey,
            constant: false, selective: true, disable: false,
            caseSensitive: definition.caseSensitive, matchWholeWords: false,
            excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 0,
            useProbability: false, probability: 100, sticky: 0, cooldown: 0, delay: 0,
            group: '', groupOverride: false, useGroupScoring: false, vectorized: false,
            ignoreBudget: false, automationId: '', triggers: [],
            matchPersonaDescription: false, matchCharacterDescription: false,
            matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
            matchScenario: false, matchCreatorNotes: false,
        };
        const source = { chatId: snapshot.chatId, epoch: snapshot.epoch, groupId: access.groupId,
            tableId: table.id, rowId, columnIds: [...options.contentColumnIds], stateRevision: snapshot.stateRevision };
        const receipt = { entryKey, indexId, triggerColumnIds: [...fieldIds], source };
        const diagnostic = { rowId, fields: normalizations };
        outputChars += JSON.stringify(entry).length + JSON.stringify(receipt).length + JSON.stringify(diagnostic).length;
        if (outputChars > INDEX_WORLDBOOK_LIMITS.outputChars) fail('WORLDBOOK_LIMIT');
        entries.push(entry);
        provenance.push(receipt);
        diagnostics.push(diagnostic);
    }
    return { version: 1, namespace: INDEX_WORLDBOOK_NAMESPACE, snapshot, tableId: table.id,
        indexId, definition, mapping: { primaryColumnId: primary, termSeparator: separator,
            contentColumnIds: [...options.contentColumnIds] }, entries, provenance, diagnostics,
        complete: true, usage: { scannedRows: table.rows.length, inputChars, outputChars } };
}

/** Local literal sample only; host scan window, budgets and activation are not
 * inferred from this preview. Uses original normalized terms, never user regex. */
export function previewIndexWorldbookMatches(projection, text) {
    if (typeof text !== 'string' || text.length > 16384) fail('WORLDBOOK_PREVIEW_LIMIT');
    const definition = projection.definition;
    const haystack = definition.caseSensitive ? text : text.toLowerCase();
    return projection.diagnostics.map(row => {
        const fields = row.fields.map(field => {
            const terms = field.compared.map(term => ({ term, matched: haystack.includes(term) }));
            const matched = definition.termMatch === 'all' ? terms.every(term => term.matched) : terms.some(term => term.matched);
            return { columnId: field.columnId, matched, reason: matched ? 'matched' : `terms-${definition.termMatch}-not-met`, terms };
        });
        const matched = definition.fieldMatch === 'all' ? fields.every(field => field.matched) : fields.some(field => field.matched);
        return { rowId: row.rowId, matched, reason: matched ? 'matched' : `fields-${definition.fieldMatch}-not-met`, fields };
    });
}

// Revisions must cover deletes/restores, edits, index/mapping changes, grants,
// chat switches and rollbacks. This helper is NOT a publish lock or authority.
export function isIndexWorldbookProjectionCurrent(projection, currentSnapshot) {
    try {
        return projection?.version === 1 && projection.namespace === INDEX_WORLDBOOK_NAMESPACE
            && projection.complete === true && JSON.stringify(snapshotOf(projection.snapshot)) === JSON.stringify(snapshotOf(currentSnapshot));
    } catch { return false; }
}
