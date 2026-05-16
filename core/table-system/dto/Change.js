/**
 * applyOperations 推演完成后吐出的变更记录。供高亮、SuperMemory 同步、UI 刷新使用。
 *
 * 注意 type 只有 'update' 和 'delete' 两种 —— insertRow 在 executor.js 历史实现里
 * 也吐 type='update'（每个被填的单元格一条），不要发明 'insert' type。
 *
 * @typedef {Object} UpdateChange
 * @property {'update'} type
 * @property {number} tableIndex
 * @property {number} rowIndex
 * @property {number} colIndex
 *
 * @typedef {Object} DeleteChange
 * @property {'delete'} type
 * @property {number} tableIndex
 * @property {number} rowIndex
 *
 * @typedef {UpdateChange | DeleteChange} Change
 */

export {};
