/**
 * core/memory-blocks/executor.js
 *
 * 模板替换式工作流：用块结果 substitute 到模板的 placeholder 处。
 * 与 chain.js（顺序拼接式）并列两种组合方式，共用 runner.js 的底层执行原语。
 *
 * 适用场景：sulv1-4 这种"prompt 里已挖好占位符，块负责填料"。
 *
 * 核心 API：
 *   applyToTemplate(template, opts)      单模板进，字符串出
 *   applyToTemplates(templates, opts)    多模板进（数组或对象），结构同形出；
 *                                        块只执行一次，对每个模板复用结果
 *   generateBlockMap(opts)               不替换，返回 { id → value } 给调用方自由组合
 *
 * 中断行为：opts.signal 由调用方控制，传给每个 handler；任一 handler 抛
 * AbortError 时整体抛出向上传递（与现有 callAI 体系一致）。
 */

import { executeContext } from './runner.js';

function escapeForRegex(s) {
    return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
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

export async function applyToTemplate(template, opts = {}) {
    if (typeof template !== 'string' || !template) return template ?? '';
    const results = await executeContext(opts);
    return substituteOne(template, results);
}

/**
 * 多模板批处理。templates 可以是：
 *   - 字符串数组 → 返回字符串数组
 *   - 对象 { key: template } → 返回对象 { key: replaced }
 *   - 字符串 → 退化为 applyToTemplate
 */
export async function applyToTemplates(templates, opts = {}) {
    const results = await executeContext(opts);

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
    const results = await executeContext(opts);
    const map = new Map();
    for (const r of results) {
        if (r) map.set(r.block.id, r.value);
    }
    return map;
}
