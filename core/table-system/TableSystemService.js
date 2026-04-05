/**
 * TableSystemService
 * 表格系统 Bus 服务 — 统一对外入口
 *
 * 职责：
 *   1. 将原 events.js::handleTableUpdate 的消息处理编排逻辑收归此处
 *   2. 通过 Amily2Bus 暴露稳定接口，解耦外部模块的直接依赖
 *   3. 向后兼容：保留具名导出，现有直接 import 无需立即修改
 *
 * Bus 注册名：'TableSystem'
 *
 * 公开接口（query('TableSystem')）：
 *   processMessageUpdate(messageId)  — 处理 AI 消息的表格更新流程
 *   fillWithSecondaryApi(msg)        — 二次 API 填表
 *   injectTableData(...)             — 向提示词注入表格数据
 *   generateTableContent()           — 生成表格注入内容字符串
 *   getMemoryState()                 — 读取当前表格内存状态
 *   renderTables()                   — 强制重渲染表格 UI
 */

import { getContext, extension_settings } from "/scripts/extensions.js";
import { saveChatConditional } from "/script.js";
import { extensionName } from "../../utils/settings.js";

// ── table-system 内部模块 ─────────────────────────────────────────────────
import * as TableManager from './manager.js';
import { triggerSync } from './manager.js';
import { executeCommands } from './executor.js';
import { log } from './logger.js';

// 可修改子模块
import { generateTableContent, injectTableData } from './injector.js';
import { fillWithSecondaryApi } from './secondary-filler.js';

// UI 层
import { renderTables } from '../../ui/table-bindings.js';

// ── 核心逻辑 ─────────────────────────────────────────────────────────────

/**
 * 处理单条 AI 消息的表格更新流程。
 * 原 events.js::handleTableUpdate 的完整逻辑迁移至此。
 *
 * @param {number} messageId - 消息在 context.chat 中的索引
 */
async function processMessageUpdate(messageId) {
    TableManager.clearHighlights();

    const settings = extension_settings[extensionName];
    const tableSystemEnabled = settings.table_system_enabled !== false;
    if (!tableSystemEnabled) {
        log('【表格服务】表格系统总开关已关闭，跳过所有表格处理。', 'info');
        return;
    }

    const fillingMode = settings.filling_mode || 'main-api';
    if (fillingMode === 'secondary-api' || fillingMode === 'optimized') {
        log('【表格服务】检测到"分步填表"或"优化中填表"模式，主API填表已自动禁用。', 'info');
        return;
    }

    log(`【表格服务】开始处理消息 ID: ${messageId}`, 'warn');
    const context = getContext();
    const message = context.chat[messageId];

    if (!message) {
        log(`【表格服务】错误：未找到消息 ID: ${messageId}，流程中止。`, 'error');
        return;
    }
    if (message.is_user) {
        log(`【表格服务】消息 ID: ${messageId} 是用户消息，跳过。`, 'info');
        return;
    }

    log(`【表格服务】处理内容: "${message.mes.substring(0, 50)}..."`, 'info');
    const initialState = TableManager.loadTables(messageId);
    log('【表格服务-步骤1】基准状态已加载。', 'info', initialState);

    const { finalState, hasChanges, changes } = executeCommands(message.mes, initialState);
    log(`【表格服务-步骤2】推演完毕。是否有变化: ${hasChanges}`, 'info', finalState);

    if (hasChanges) {
        changes.forEach(change => {
            TableManager.addHighlight(change.tableIndex, change.rowIndex, change.colIndex);
        });
        TableManager.saveStateToMessage(finalState, message);
        TableManager.setMemoryState(finalState);
        await saveChatConditional();
        log('【表格服务-步骤3】状态已写入并保存。', 'success');
        // 变更完成后主动触发同步，确保 SuperMemory 拿到最新状态（而非 loadTables 时的旧状态）
        triggerSync();
        renderTables();
    } else {
        log('【表格服务-步骤3】未检测到有效指令或变化，无需写入。', 'info');
    }
}

// ── Bus 注册 ──────────────────────────────────────────────────────────────
// 使用 setTimeout 延迟到同步模块初始化完成后再注册，
// 确保 window.Amily2Bus 已由 SL/bus/Amily2Bus.js 完成挂载。
setTimeout(() => {
    try {
        const _ctx = window.Amily2Bus?.register('TableSystem');
        if (!_ctx) {
            console.warn('[TableSystem] Amily2Bus 尚未就绪，服务注册跳过。');
            return;
        }
        _ctx.expose({
            processMessageUpdate,
            fillWithSecondaryApi,
            injectTableData,
            generateTableContent,
            getMemoryState: () => TableManager.getMemoryState(),
            renderTables,
        });
        _ctx.log('TableSystemService', 'info', 'TableSystem 服务已注册到 Bus。');
    } catch (e) {
        console.error('[TableSystem] Bus 注册失败:', e);
    }
}, 0);

// ── 向后兼容具名导出 ──────────────────────────────────────────────────────
// 过渡期保留，现有 import { ... } from '...TableSystemService.js' 无需修改。
export { processMessageUpdate, fillWithSecondaryApi, generateTableContent, injectTableData };
