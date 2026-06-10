/**
 * core/memory-blocks/registry.js
 *
 * BlockDefinition 的注册中心。所有块共享同一个全局 Map。
 *
 * 调用方：
 *   - 内置块：builtin-blocks.js 在 bootstrap 时注册
 *   - 用户块：未来 UI / JSON 导入注册
 *   - 插件块：战斗系统等外部模块注册
 *
 * 字段校验只做最小必填检查，避免后续扩展时频繁报错。
 */

const blocks = new Map();

function validate(def) {
    if (!def || typeof def !== 'object') throw new Error('[MemoryBlocks] BlockDefinition 必须是对象。');
    if (!def.id) throw new Error('[MemoryBlocks] BlockDefinition.id 必填。');
    if (!def.placeholder) throw new Error(`[MemoryBlocks] BlockDefinition[${def.id}].placeholder 必填。`);
    if (!def.context) throw new Error(`[MemoryBlocks] BlockDefinition[${def.id}].context 必填。`);
    if (!def.generator?.type) throw new Error(`[MemoryBlocks] BlockDefinition[${def.id}].generator.type 必填。`);
}

export function register(def) {
    validate(def);
    blocks.set(def.id, { enabled: true, ...def });
}

export function unregister(id) {
    return blocks.delete(id);
}

export function getById(id) {
    return blocks.get(id) ?? null;
}

export function listByContext(context) {
    const out = [];
    for (const b of blocks.values()) {
        if (b.context === context && b.enabled !== false) out.push(b);
    }
    out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return out;
}

export function listAll() {
    return [...blocks.values()];
}

export function clear() {
    blocks.clear();
}

/** 批量替换（用于 JSON 导入时整体覆盖某 context 下的块） */
export function replaceContextBlocks(context, defs) {
    for (const [id, b] of blocks) {
        if (b.context === context) blocks.delete(id);
    }
    for (const d of defs) {
        if (d.context !== context) continue; // 防止越界注册
        register(d);
    }
}
