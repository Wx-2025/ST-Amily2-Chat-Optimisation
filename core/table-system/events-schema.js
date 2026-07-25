/** Shared table-update role contract. */

export const TABLE_ROLE = Object.freeze({
    DATABASE: 'database',
    ANCHOR: 'anchor',
    LOG: 'log',
});

/**
 * Infer the downstream synchronization role from a table name.
 * @param {string} name
 * @returns {string}
 */
export function inferTableRole(name) {
    if (name.includes('时空') || name.includes('世界钟')) return TABLE_ROLE.ANCHOR;
    if (name.includes('日志') || name.includes('Log')) return TABLE_ROLE.LOG;
    return TABLE_ROLE.DATABASE;
}
