/**
 * LLM 输出的统一动作格式。无论 formatter 是 legacy / json / toolcall，
 * 解析完都吐 Operation[]，下游 applyOperations 不关心来源。
 *
 * data 字段的 key 是列索引的字符串形式（'0', '1', ...），与 executor.js 历史行为对齐。
 *
 * @typedef {Object} InsertRowOperation
 * @property {'insertRow'} op
 * @property {number} tableIndex
 * @property {Object<string, string>} data { [colIndex]: cellValue }
 *
 * @typedef {Object} UpdateRowOperation
 * @property {'updateRow'} op
 * @property {number} tableIndex
 * @property {number} rowIndex
 * @property {Object<string, string>} data
 *
 * @typedef {Object} DeleteRowOperation
 * @property {'deleteRow'} op
 * @property {number} tableIndex
 * @property {number} rowIndex
 *
 * @typedef {InsertRowOperation | UpdateRowOperation | DeleteRowOperation} Operation
 */

export {};
