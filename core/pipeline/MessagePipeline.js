/**
 * MessagePipeline — 消息接收后的顺序处理流水线
 *
 * 用 Chain（Koa 风格中间件）替代 events.js 中的手动 if/await 拼接，
 * 并消除 AMILY2_TABLE_UPDATED fire-and-forget 反模式。
 *
 * 执行顺序：
 *   Stage 1: AutoHide        — 自动隐藏旧消息
 *   Stage 2: TextOptimize    — 正文优化（AI 改写）
 *   Stage 3: TableUpdate     — 表格解析与填写
 *   Stage 4: SuperMemorySync — 等待超级记忆世界书写入完成
 *   Stage 5: AutoSummary     — 大史官自动总结（在 next() 之后运行，作为收尾）
 *
 * ctx 结构：
 *   messageId          {number}       当前消息在 chat 中的索引
 *   latestMessage      {Object}       chat[messageId]
 *   chat               {Array}        context.chat 引用
 *   settings           {Object}       extension_settings[extensionName]
 *   optimizationResult {Object|null}  由 TextOptimize 阶段写入
 */

import { Chain } from '../../SL/bus/chain/Chain.js';
import { autoHideStage } from './stages/auto-hide.js';
import { textOptimizeStage } from './stages/text-optimize.js';
import { tableUpdateStage } from './stages/table-update.js';
import { superMemorySyncStage } from './stages/super-memory-sync.js';
import { autoSummaryStage } from './stages/auto-summary.js';

const pipeline = new Chain();

pipeline
    .use(autoHideStage)
    .use(textOptimizeStage)
    .use(tableUpdateStage)
    .use(superMemorySyncStage)
    .use(autoSummaryStage);

export { pipeline as messagePipeline };

// ── Bus 注册 ──────────────────────────────────────────────────────────────
setTimeout(() => {
    try {
        const _ctx = window.Amily2Bus?.register('MessagePipeline');
        if (!_ctx) {
            console.warn('[MessagePipeline] Amily2Bus 尚未就绪，服务注册跳过。');
            return;
        }
        _ctx.expose({
            execute: (pipelineCtx) => pipeline.execute(pipelineCtx),
        });
        _ctx.log('MessagePipeline', 'info', 'MessagePipeline 服务已注册到 Bus。');
    } catch (e) {
        console.error('[MessagePipeline] Bus 注册失败:', e);
    }
}, 0);
