/**
 * Versioned table-database state kept in SillyTavern chatMetadata.
 * The legacy message.extra snapshot remains available for history and rollback.
 */

export const TABLE_STATE_METADATA_KEY = 'amily2_table_state';
export const TABLE_STATE_FORMAT = 'amily2.table-state';
export const TABLE_STATE_FORMAT_VERSION = 2;

export function normalizeTableDatabaseState(tables) {
    if (!Array.isArray(tables)) return [];
    tables.forEach((table, tableIndex) => normalizeTableIdentity(table, tableIndex));
    return tables;
}

export function normalizeTableIdentity(table, tableIndex = 0) {
    if (!table || typeof table !== 'object') return table;

    table.headers = Array.isArray(table.headers) ? table.headers : [];
    table.rows = Array.isArray(table.rows) ? table.rows : [];
    table.id = validId(table.id) ? table.id : legacyId('table', `${tableIndex}:${table.name || ''}:${table.headers.join('|')}`);
    table.owner = validId(table.owner) ? table.owner : 'user';
    table.schemaVersion = positiveInteger(table.schemaVersion, 1);

    normalizeColumns(table);
    normalizeRows(table);
    return table;
}

export function createTableStateEnvelope(tables, profile = null) {
    const normalizedTables = normalizeTableDatabaseState(deepClone(tables));
    return {
        format: TABLE_STATE_FORMAT,
        formatVersion: TABLE_STATE_FORMAT_VERSION,
        profile: profile ? deepClone(profile) : null,
        tables: normalizedTables,
    };
}

export function readChatTableState(context) {
    const raw = context?.chatMetadata?.[TABLE_STATE_METADATA_KEY];
    if (!raw || raw.format !== TABLE_STATE_FORMAT || raw.formatVersion < TABLE_STATE_FORMAT_VERSION || !Array.isArray(raw.tables)) {
        return null;
    }
    return createTableStateEnvelope(raw.tables, raw.profile || null);
}

/**
 * Persists the current normalized state without replacing a previously bound profile.
 * Callers intentionally do not await this helper because legacy table actions are synchronous.
 */
export function persistChatTableState(context, tables, profile = undefined) {
    if (!writeChatTableState(context, tables, profile)) return false;
    Promise.resolve(context.saveMetadata()).catch(error => {
        console.error('[TableDatabase] Failed to persist chat metadata:', error);
    });
    return true;
}

export async function persistChatTableStateAsync(context, tables, profile = undefined) {
    if (!writeChatTableState(context, tables, profile)) return false;
    await context.saveMetadata();
    return true;
}

function writeChatTableState(context, tables, profile) {
    if (!context?.chatMetadata || typeof context.saveMetadata !== 'function') return false;

    const existing = context.chatMetadata[TABLE_STATE_METADATA_KEY];
    const resolvedProfile = profile === undefined ? existing?.profile || null : profile;
    context.chatMetadata[TABLE_STATE_METADATA_KEY] = createTableStateEnvelope(tables, resolvedProfile);
    return true;
}

export function createRecordMetadata(table, row, rowIndex) {
    return {
        id: createRuntimeId('record', `${table.id}:${rowIndex}:${JSON.stringify(row)}`),
    };
}

export function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeColumns(table) {
    const existing = Array.isArray(table.columns) ? table.columns : [];
    const usedIds = new Set();
    table.columns = table.headers.map((header, index) => {
        const candidate = existing[index] && typeof existing[index] === 'object' ? existing[index] : {};
        let id = validId(candidate.id) ? candidate.id : legacyId('column', `${table.id}:${index}:${header}`);
        if (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        return {
            ...candidate,
            id,
            label: String(header ?? ''),
            type: candidate.type || 'string',
        };
    });
}

function normalizeRows(table) {
    const existing = Array.isArray(table.rowMeta) ? table.rowMeta : [];
    const usedIds = new Set();
    table.rowMeta = table.rows.map((row, index) => {
        const candidate = existing[index] && typeof existing[index] === 'object' ? existing[index] : {};
        let id = validId(candidate.id) ? candidate.id : legacyId('record', `${table.id}:${index}:${JSON.stringify(row)}`);
        if (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        return { ...candidate, id };
    });
}

function createRuntimeId(prefix, fallbackSeed) {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${legacyId('runtime', `${fallbackSeed}:${Date.now()}:${Math.random()}`)}`;
}

function legacyId(prefix, value) {
    let hash = 2166136261;
    const source = String(value);
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function validId(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
