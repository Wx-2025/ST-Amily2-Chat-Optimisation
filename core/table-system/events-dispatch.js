/**
 * @file events-dispatch.js —— SuperMemory 事件分发（Phase 0.4 自 manager.js 抽出）
 *
 * 把单表 / 全表的最新状态推送给 SuperMemory（优先 Bus 直调，降级 CustomEvent）。
 * 独立成模块的原因：manager.js 与 actions/ui-mutations.js 都需要调用，
 * 放在任何一方都会制造新的循环依赖；本模块只依赖 store / events-schema / logger，零环。
 */

import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../../utils/settings.js';
import { log } from './logger.js';
import { getState } from './infra/store.js';
import { createTableUpdateEvent, inferTableRole } from './events-schema.js';

/**
 * 把单个表格的最新状态推送给 SuperMemory（优先 Bus 直调，降级 CustomEvent）。
 * @param {number} tableIndex
 */
export function dispatchTableUpdate(tableIndex) {
    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) return;

    const state = getState();
    if (!state || !state[tableIndex]) return;
    const table = state[tableIndex];
    const role = inferTableRole(table.name);

    const smBus = window.Amily2Bus?.query('SuperMemory');
    if (smBus?.pushUpdate) {
        smBus.pushUpdate({
            tableName: table.name,
            data: table.rows,
            headers: table.headers,
            rowStatuses: table.rowStatuses ?? [],
            role,
        });
    } else {
        document.dispatchEvent(createTableUpdateEvent(table));
    }
    log(`[SuperMemory] Dispatched update for ${table.name} (role: ${role})`, 'info');
}

/**
 * 触发所有表格的全量同步（Pipeline 变更后调用）。
 */
export function dispatchAllTablesUpdate() {
    const state = getState();
    if (!state) return;
    log('[SuperMemory] Dispatching update events for ALL tables...', 'info');
    state.forEach((_, index) => dispatchTableUpdate(index));
}
