import { deepClone, normalizeTableDatabaseState } from './infra/database-state.js';

export const TABLE_PROFILE_FORMAT = 'amily2.table-profile';
export const TABLE_PROFILE_SCHEMA_VERSION = 1;

/**
 * Creates a portable structure-only profile. Runtime rows never leave the chat.
 */
export function createTableProfile(tables, options = {}) {
    const normalizedTables = normalizeTableDatabaseState(deepClone(tables || [])).map(stripRuntimeRows);
    return {
        format: TABLE_PROFILE_FORMAT,
        schemaVersion: TABLE_PROFILE_SCHEMA_VERSION,
        id: String(options.id || 'default-table-profile'),
        name: String(options.name || '表格档案'),
        description: String(options.description || ''),
        tables: normalizedTables,
        views: Array.isArray(options.views) ? deepClone(options.views) : [],
        templates: deepClone(options.templates || {}),
        meta: deepClone(options.meta || {}),
    };
}

export function normalizeTableProfile(profile) {
    if (!profile || typeof profile !== 'object' || profile.format !== TABLE_PROFILE_FORMAT) return null;
    if (profile.schemaVersion !== TABLE_PROFILE_SCHEMA_VERSION || !Array.isArray(profile.tables)) return null;

    return createTableProfile(profile.tables, {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        views: profile.views,
        templates: profile.templates,
        meta: profile.meta,
    });
}

export function createTableStateFromProfile(profile) {
    const normalized = normalizeTableProfile(profile);
    if (!normalized) return null;
    const tables = deepClone(normalized.tables).map(table => ({
        ...table,
        rows: [],
        rowMeta: [],
        rowStatuses: [],
    }));
    return normalizeTableDatabaseState(tables);
}

function stripRuntimeRows(table) {
    return {
        ...table,
        rows: [],
        rowMeta: [],
        rowStatuses: [],
    };
}
