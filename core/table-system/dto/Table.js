/**
 * @file 表格相关数据形状（DTO）
 * 对应运行时存于 message.extra.amily2_tables_data 的结构。
 */

/**
 * 单元格内容；空值约定为空串而非 null/undefined。
 * @typedef {string} Cell
 */

/**
 * 行状态。'pending-deletion' 表示已标记待删除（延迟删除机制）。
 * @typedef {'normal' | 'pending-deletion'} RowStatus
 */

/**
 * 单张表格。
 * @typedef {Object} Table
 * @property {string} name                      表格名（唯一标识 + UI 显示名）
 * @property {string[]} headers                 列头数组，长度 = 列数
 * @property {Cell[][]} rows                    行数据，二维数组，rows[i].length = headers.length
 * @property {RowStatus[]} [rowStatuses]        行状态数组，与 rows 等长
 * @property {(number|null)[]} [columnWidths]   列宽数组（UI 用），与 headers 等长，null 表示自适应
 * @property {string} [note]                    表格说明
 * @property {string} [rule_add]                添加行规则（自然语言）
 * @property {string} [rule_delete]             删除行规则
 * @property {string} [rule_update]             更新行规则
 * @property {Object<string, number>} [charLimitRules]  多列字符限制：{ "colIndexStr": maxChars }
 * @property {number} [rowLimitRule]            行数上限，0 表示不限
 * @property {number} [simplifyRowThreshold]    历史行简化阈值，0 表示不简化
 */

/**
 * 表格集合 = 全局状态。
 * @typedef {Table[]} TableState
 */

export {};
