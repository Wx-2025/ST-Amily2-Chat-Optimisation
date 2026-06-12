/**
 * core/memory-blocks/runner.js
 *
 * 块执行的底层原语，被 executor.js（模板替换）和 chain.js（顺序拼接）共用。
 *
 * runBlock(block, ctx) → { block, value } | null
 *   单块执行；handler 抛 AbortError 时向上传递，其余异常吞掉并返回 null
 *   handler 返回 null/undefined 时同样返回 null（视为"无内容"）
 *
 * executeContext({ context, settings, signal, extras }) → Array<{block,value}|null>
 *   按 context 拉块 → Promise.all 并发执行 → 返回结果数组（保留 null 占位以便上层
 *   按 order 排序时不丢失映射关系，调用方过滤 null 即可）
 */

import { getHandler } from './generator-handlers.js';
import { listByContext } from './registry.js';

export async function runBlock(block, ctx) {
    const handler = getHandler(block.generator?.type);
    if (!handler) {
        console.warn(`[MemoryBlocks] 未注册的 generator 类型 "${block.generator?.type}"，块 ${block.id} 已跳过。`);
        return null;
    }
    try {
        const value = await handler(block, ctx);
        if (value === null || value === undefined) return null;
        return { block, value: String(value) };
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error(`[MemoryBlocks] 块 ${block.id} 生成失败:`, error);
        return null;
    }
}

export async function executeContext({ context, settings, signal, extras } = {}) {
    const blocks = listByContext(context);
    if (blocks.length === 0) return [];
    const ctx = { settings: settings ?? {}, signal, context, extras };
    return await Promise.all(blocks.map(b => runBlock(b, ctx)));
}
