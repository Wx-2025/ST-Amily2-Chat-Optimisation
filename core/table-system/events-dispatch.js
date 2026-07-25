/**
 * @file events-dispatch.js —— SuperMemory 事件分发（Phase 0.4 自 manager.js 抽出）
 *
 * 把单表 / 全表的最新状态通过内部事件推送给 SuperMemory。
 * 独立成模块的原因：manager.js 与 actions/ui-mutations.js 都需要调用，
 * 放在任何一方都会制造新的循环依赖；本模块只负责兼容调用与日志。
 */

import { log } from './logger.js';
import { getState } from './infra/store.js';
import { dispatchCanonicalTableUpdate } from '../internal/table-update-channel.js';

/**
 * 把单个表格的最新状态推送给 SuperMemory。
 * @param {number} tableIndex
 */
export function dispatchTableUpdate(tableIndex) {
    try {
        const result = dispatchCanonicalTableUpdate(tableIndex);
        if (!result) return;
        log(`[TableUpdateChannel] Dispatched update for ${result.tableName} (role: ${result.role})`, 'info');
    } catch (error) {
        log(`[TableUpdateChannel] Rejected invalid canonical table at index ${tableIndex}: ${error.message}`, 'error');
    }
}

/**
 * 触发所有表格的全量同步（Pipeline 变更后调用）。
 */
export function dispatchAllTablesUpdate() {
    const state = getState();
    if (!state) return;
    log('[TableUpdateChannel] Dispatching update events for ALL tables...', 'info');
    state.forEach((_, index) => dispatchTableUpdate(index));
}
