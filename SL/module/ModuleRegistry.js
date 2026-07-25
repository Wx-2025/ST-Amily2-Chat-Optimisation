/**
 * ModuleRegistry — 模块注册中心
 *
 * 职责：
 *   1. 收集所有 Module 子类的注册信息（name → factory）
 *   2. 统一执行 init → mount 生命周期
 *   3. 通过 registry.query() 提供显式的模块内查询
 *   4. 提供 dispose 方法用于整体卸载
 *
 * 用法：
 *   import { registry } from 'SL/module/ModuleRegistry.js';
 *   registry.register('Hanlinyuan', () => new HanlinyuanModule());
 *   await registry.mountAll(ctx);          // ctx = { baseUrl, root, ... }
 *   registry.query('Hanlinyuan');          // 获取该模块 expose() 的公开 API
 */

const _modules = new Map();   // name → Module instance (mounted)
const _factories = new Map(); // name → () => Module

/**
 * 注册一个模块工厂。
 * @param {string} name  唯一模块名
 * @param {Function} factory  无参函数，返回 Module 实例
 */
export function register(name, factory) {
    if (_factories.has(name)) {
        console.warn(`[ModuleRegistry] 模块 "${name}" 已注册，将覆盖。`);
    }
    _factories.set(name, factory);
}

/**
 * 初始化并挂载所有已注册模块。
 * @param {Object} ctx  传给 module.init(ctx) 的上下文
 *   ctx.baseUrl  — 插件根 URL（用于 view 路径解析）
 *   ctx.root     — 挂载目标 DOM 元素
 */
export async function mountAll(ctx = {}) {
    for (const [name, factory] of _factories) {
        if (_modules.has(name)) {
            console.warn(`[ModuleRegistry] 模块 "${name}" 已挂载，跳过。`);
            continue;
        }
        try {
            const mod = factory();
            await mod.init(ctx);
            await mod.mount();
            _modules.set(name, mod);

            console.log(`[ModuleRegistry] ✔ ${name}`);
        } catch (e) {
            console.error(`[ModuleRegistry] ✘ ${name} 挂载失败:`, e);
        }
    }
}

/**
 * 按名称挂载单个模块（延迟挂载场景）。
 */
export async function mountOne(name, ctx = {}) {
    const factory = _factories.get(name);
    if (!factory) {
        console.warn(`[ModuleRegistry] 模块 "${name}" 未注册。`);
        return null;
    }
    if (_modules.has(name)) return _modules.get(name);

    const mod = factory();
    await mod.init(ctx);
    await mod.mount();
    _modules.set(name, mod);
    return mod;
}

/**
 * 查询已挂载模块的公开 API。
 */
export function query(name) {
    const mod = _modules.get(name);
    return mod ? mod.expose() : null;
}

/**
 * 获取已挂载的模块实例（内部使用）。
 */
export function getInstance(name) {
    return _modules.get(name) || null;
}

/**
 * 卸载所有模块。
 */
export function disposeAll() {
    for (const [name, mod] of _modules) {
        try {
            mod.dispose();
        } catch (e) {
            console.error(`[ModuleRegistry] ${name} dispose 失败:`, e);
        }
    }
    _modules.clear();
}

/**
 * 已注册的模块名列表。
 */
export function names() {
    return [..._factories.keys()];
}

export const registry = {
    register,
    mountAll,
    mountOne,
    query,
    getInstance,
    disposeAll,
    names,
};

export default registry;
