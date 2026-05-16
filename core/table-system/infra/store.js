/**
 * @file ITableStore 实现 —— 表格运行时状态的唯一所有者。
 *
 * 替代 manager.js 中三个 module-level 可变量：
 *   currentTablesState  → 通过 getState/setState 访问
 *   highlightedCells    → addHighlight/getHighlights/clearHighlights
 *   updatedTables       → markTableUpdated/getUpdatedTables/clearUpdatedTables
 *
 * 本模块只承担"存"，不触发任何副作用（不保存、不渲染、不发事件总线消息）。
 * 副作用编排留给 Service 层 / Action 层。
 *
 * setState 会触发 subscribe 注册的回调，给 UI / SuperMemory 一个钩子，
 * 但不直接 import UI（保持 domain 纯度）。
 *
 * @typedef {import('../dto/Table.js').TableState} TableState
 */

import { log } from '../logger.js';

/** @type {TableState | null} */
let _state = null;

/** @type {Set<string>} 形如 "tableIndex-rowIndex-colIndex" */
const _highlights = new Set();

/** @type {Set<number>} 标记本周期内被改过的表格索引 */
const _updatedTables = new Set();

/** @type {Set<(state: TableState | null) => void>} */
const _listeners = new Set();

// ── 主状态 ────────────────────────────────────────────────────────────────

/**
 * @returns {TableState | null}
 */
export function getState() {
    return _state;
}

/**
 * 直接替换全局状态。注意：不做深拷贝，调用方需自己负责传入的 state 不被外部 mutate。
 * @param {TableState | null} newState
 */
export function setState(newState) {
    _state = newState;
    _notify();
}

/**
 * 订阅 setState 触发的变更通知。返回取消订阅函数。
 * 仅在 setState 被调用时触发；mutate 同一引用不会触发。
 * @param {(state: TableState | null) => void} listener
 * @returns {() => void}
 */
export function subscribe(listener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
}

function _notify() {
    for (const l of _listeners) {
        try {
            l(_state);
        } catch (e) {
            console.error('[TableStore] listener error:', e);
        }
    }
}

// ── 单元格高亮 ─────────────────────────────────────────────────────────────

/**
 * @param {number} tableIndex
 * @param {number} rowIndex
 * @param {number} colIndex
 */
export function addHighlight(tableIndex, rowIndex, colIndex) {
    _highlights.add(`${tableIndex}-${rowIndex}-${colIndex}`);
}

/**
 * @returns {Set<string>}
 */
export function getHighlights() {
    return _highlights;
}

export function clearHighlights() {
    if (_highlights.size > 0) {
        _highlights.clear();
        log('已清除所有单元格高亮标记。', 'info');
    }
}

// ── 更新过的表格标记 ───────────────────────────────────────────────────────

/**
 * @param {number} tableIndex
 */
export function markTableUpdated(tableIndex) {
    _updatedTables.add(tableIndex);
}

/**
 * @returns {Set<number>}
 */
export function getUpdatedTables() {
    return _updatedTables;
}

export function clearUpdatedTables() {
    if (_updatedTables.size > 0) {
        _updatedTables.clear();
        log('已清除所有表格的更新标记。', 'info');
    }
}
