/**
 * ITableEvent — 表格更新事件的显式契约
 *
 * table-system/manager.js（发送端）和 super-memory/manager.js（接收端）
 * 共同从此文件导入，消除隐式字段约定。任何字段变更只需修改此处，
 * 两侧的解构都会在运行时/IDE 中立即可见。
 */

/** 事件名称常量（取代各处硬编码字符串） */
export const TABLE_UPDATED_EVENT = 'AMILY2_TABLE_UPDATED';

/** 表格角色枚举 */
export const TABLE_ROLE = Object.freeze({
    DATABASE: 'database',  // 通用数据库表格（默认）
    ANCHOR:   'anchor',    // 时空 / 世界钟等时间锚点
    LOG:      'log',       // 日志类表格
});

/**
 * 根据表格名称推断角色。
 * @param {string} name
 * @returns {string} TABLE_ROLE 枚举值
 */
export function inferTableRole(name) {
    if (name.includes('时空') || name.includes('世界钟')) return TABLE_ROLE.ANCHOR;
    if (name.includes('日志') || name.includes('Log'))   return TABLE_ROLE.LOG;
    return TABLE_ROLE.DATABASE;
}

/**
 * 构造并返回 AMILY2_TABLE_UPDATED CustomEvent。
 *
 * @param {object}   table
 * @param {string}   table.name
 * @param {Array}    table.rows
 * @param {string[]} table.headers
 * @param {Array}    [table.rowStatuses]
 * @returns {CustomEvent}
 */
export function createTableUpdateEvent(table) {
    return new CustomEvent(TABLE_UPDATED_EVENT, {
        detail: {
            tableName:   table.name,
            data:        table.rows,
            headers:     table.headers,
            rowStatuses: table.rowStatuses ?? [],
            role:        inferTableRole(table.name),
        }
    });
}
