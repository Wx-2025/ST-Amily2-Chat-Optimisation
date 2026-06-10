/**
 * core/memory-blocks/executor.js
 *
 * 工作流执行器：拉 context 下的全部块 → Promise.all 并发执行 generator
 * → 把每个块的结果按 placeholder 替换回模板。
 *
 * 核心 API：
 *   applyToTemplate(template, opts)      单模板进，字符串出
 *   applyToTemplates(templates, opts)    多模板进（数组或对象），结构同形出；
 *                                        块只执行一次，对每个模板复用结果
 *   generateBlockMap(opts)               不替换，返回 { id → value } 给调用方自己玩
 *
 * 中断行为：opts.signal 由调用方控制，传给每个 handler；任一 handler 抛
 * AbortError 时，executor 也抛 AbortError 向上传递（与现有 callAI 体系一致）。
 */

import { getHandler } from './generator-handlers.js';
import { listByContext } from './registry.js';

function escapeForRegex(s) {
    return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

async function runBlock(block, ctx) {
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

function substituteOne(template, results) {
    if (typeof template !== 'string' || !template) return template ?? '';
    let out = template;
    for (const r of results) {
        if (!r) continue;
        const re = new RegExp(escapeForRegex(r.block.placeholder), 'g');
        out = out.replace(re, r.value);
    }
    return out;
}

/**
 * 执行 context 下的所有块，返回 [ {block, value} | null, ... ]。
 * 内部使用，applyToTemplate(s) 复用。
 */
async function executeBlocks({ context, settings, signal, extras } = {}) {
    const blocks = listByContext(context);
    if (blocks.length === 0) return [];
    const ctx = { settings: settings ?? {}, signal, context, extras };
    return await Promise.all(blocks.map(b => runBlock(b, ctx)));
}

export async function applyToTemplate(template, opts = {}) {
    if (typeof template !== 'string' || !template) return template ?? '';
    const results = await executeBlocks(opts);
    return substituteOne(template, results);
}

/**
 * 多模板批处理。templates 可以是：
 *   - 字符串数组 → 返回字符串数组
 *   - 对象 { key: template } → 返回对象 { key: replaced }
 *   - 字符串 → 退化为 applyToTemplate
 */
export async function applyToTemplates(templates, opts = {}) {
    const results = await executeBlocks(opts);

    if (typeof templates === 'string') return substituteOne(templates, results);
    if (Array.isArray(templates)) return templates.map(t => substituteOne(t, results));
    if (templates && typeof templates === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(templates)) out[k] = substituteOne(v, results);
        return out;
    }
    return templates;
}

/**
 * 不替换，只把块结果汇成 Map<id, value>，调用方拿去自由组合。
 */
export async function generateBlockMap(opts = {}) {
    const results = await executeBlocks(opts);
    const map = new Map();
    for (const r of results) {
        if (r) map.set(r.block.id, r.value);
    }
    return map;
}
