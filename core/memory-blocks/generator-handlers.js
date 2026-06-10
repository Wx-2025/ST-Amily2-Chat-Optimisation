/**
 * core/memory-blocks/generator-handlers.js
 *
 * type → handler 函数 的注册表。BlockDefinition.generator.type 在这里查表后执行。
 *
 * Handler 签名：async (block, ctx) => string | null
 *   - block: BlockDefinition
 *   - ctx:   ExecuteContext  { settings, signal, context, extras }
 *   - 返回 string：替换值；返回 null/undefined：视为"无内容，保留占位符"
 *
 * 当前内置 'static'；'ai_call'/'plugin' 在后续 Phase 注册（保留接口）。
 */

const handlers = new Map();

export function registerHandler(type, fn) {
    if (!type || typeof fn !== 'function') {
        throw new Error('[MemoryBlocks] registerHandler 需要 type 字符串 + 函数 fn。');
    }
    handlers.set(type, fn);
}

export function unregisterHandler(type) {
    handlers.delete(type);
}

export function getHandler(type) {
    return handlers.get(type) ?? null;
}

export function listHandlerTypes() {
    return [...handlers.keys()];
}

// ── 内置 handler：static ──────────────────────────────────────────────────────
registerHandler('static', async (block, ctx) => {
    const gen = block.generator || {};
    // 优先级：硬编码 value > settings[valueKey] > defaultValue > ''
    if (gen.value !== undefined) return String(gen.value);
    if (gen.valueKey != null) {
        const v = ctx?.settings?.[gen.valueKey];
        if (v !== undefined && v !== null && v !== '') return String(v);
    }
    if (gen.defaultValue !== undefined) return String(gen.defaultValue);
    return '';
});
