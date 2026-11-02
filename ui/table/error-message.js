const DISPLAY_CODES = new Set([
    'RELATION_BACKUP_INVALID', 'RELATION_BACKUP_LIMIT',
    'TABLE_STALE', 'TABLE_PERSIST_FAILED', 'TABLE_BUSY', 'TABLE_ACCESS_DENIED', 'TABLE_LOAD_FAILED',
    'RELATION_RESTRICTED', 'RELATION_ACCESS_DENIED', 'RELATION_SCOPE_DENIED',
    'RELATION_REQUIRED', 'RELATION_CARDINALITY', 'RELATION_DUPLICATE',
    'RELATION_COLUMN_MISSING', 'RELATION_TARGET_MISSING', 'RELATION_SOURCE_MISSING',
    'RELATION_SOURCE_INACTIVE', 'RELATION_TARGET_ARCHIVED', 'RELATION_TARGET_DELETED',
    'RELATION_TARGET_PENDING_DELETION', 'RELATION_SCHEMA_INVALID', 'RELATION_CELL_INVALID',
    'RELATION_INTEGRITY_UNKNOWN', 'RELATION_EXPLICIT_MIGRATION_REQUIRED',
    'INDEX_CONFIG_INVALID', 'INDEX_QUERY_INVALID', 'INDEX_ACCESS_DENIED',
    'INDEX_DEPENDENCY_ACTIVE', 'INDEX_DEPENDENCIES_STALE', 'INDEX_DEPENDENCIES_UNAVAILABLE',
    'INDEX_NOT_FOUND', 'INDEX_VALUE_INVALID', 'INDEX_IDENTITY_INVALID', 'INDEX_LIMIT',
    'UNIQUE_CONSTRAINT_VIOLATION',
]);

/** Display only: translate receives an errors.CODE key; diagnostics stay verbatim. */
export function formatTableError(error, translate, fallback) {
    const code = typeof error === 'string' ? error : error?.code;
    const message = typeof error?.message === 'string' ? error.message : '';
    const raw = fallback ?? (message && message !== code
        ? (code ? `${code}: ${message}` : message)
        : code || String(error ?? ''));
    if (!DISPLAY_CODES.has(code)) return raw;
    const key = `errors.${code}`;
    const description = translate?.(key);
    if (typeof description !== 'string' || !description || description === key
        || description === `tableRuntimeUi.${key}`) return raw;
    return `${description} (${code})${message && message !== code ? `\n${message}` : ''}`;
}
