/**
 * core/progressive-memory/engine.js
 *
 * 渐进记忆（内测）注入引擎。
 *
 * 与超级记忆（写世界书条目）不同，本模块通过 setExtensionPrompt 直接把采样结果
 * 注入到当回合上下文——内容独立、不落世界书、不随聊天/角色卡导出，生命周期天然
 * 跟随会话。数据源为某张追加式表格（默认「总结表」），按时间梯度采样：
 *   最新 X 行全量 + 历史对半拆，较近一半等距取 Y 行、较远一半等距取 Z 行。
 *
 * 权限：开发中功能，plugin_user_type >= 3 方可生效（未来版本对外开放）。
 *
 * 设计为纯数据驱动：所有参数存 extension_settings[extensionName].progressive_memory，
 * 采样逻辑委托 sampler.js（纯函数），后续可平移为 memory-blocks 工作链节点。
 */

import { setExtensionPrompt } from "/script.js";
import { extension_settings, getContext } from "/scripts/extensions.js";
import { extensionName } from "../../utils/settings.js";
import { getMemoryState } from "../table-system/manager.js";
import { sampleProgressive } from "./sampler.js";

const INJECTION_KEY = "AMILY2_PROGRESSIVE_MEMORY";
const PLACEHOLDER = "{{progressive_memory}}";

export const progressiveMemoryDefaults = {
    progressive_memory: {
        enabled: false,
        targetTable: "总结表",
        recentCount: 5,
        midCount: 5,
        farCount: 3,
        // 注入模板：占位符 {{progressive_memory}} 处填入采样后的行文本
        template:
            "##以下是按时间梯度回顾的历史记忆（近期完整、远期摘要，时间从旧到新），作为后续剧情的连续性参考：\n{{progressive_memory}}",
        injection: { position: 1, depth: 0, role: 0 },
    },
};

function getSettings() {
    const root = extension_settings[extensionName] || {};
    return { ...progressiveMemoryDefaults.progressive_memory, ...(root.progressive_memory || {}) };
}

function isAuthorized() {
    return parseInt(localStorage.getItem("plugin_user_type") || "0") >= 3;
}

/** 把单行渲染为 `- 列名: 值` 块，与超级记忆详情条目格式一致，便于 AI 解析。 */
function renderRow(row, headers, tableName) {
    let finalHeaders = headers;
    if (!finalHeaders || finalHeaders.length < row.length) {
        finalHeaders = [];
        for (let i = 0; i < row.length; i++) {
            finalHeaders.push((headers && headers[i]) ? headers[i] : `Col_${i}`);
        }
    }
    let out = `【${tableName} · ${row[0] || "?"}】\n`;
    for (let i = 0; i < row.length; i++) {
        out += `- ${finalHeaders[i] || `Col_${i}`}: ${row[i] ?? ""}\n`;
    }
    return out.trim();
}

/**
 * 构建注入文本。返回 '' 表示无需注入（未启用 / 无权限 / 无数据）。
 */
export function buildProgressiveInjection() {
    if (!isAuthorized()) return "";

    const s = getSettings();
    if (!s.enabled) return "";

    const tables = getMemoryState();
    if (!Array.isArray(tables) || tables.length === 0) return "";

    const table = tables.find(t => t.name === s.targetTable);
    if (!table || !Array.isArray(table.rows) || table.rows.length === 0) return "";

    const headers = table.headers || [];
    const rowStatuses = table.rowStatuses || [];

    // 候选行：有主键、非删除中
    const candidates = [];
    table.rows.forEach((row, index) => {
        if (!row || row.length === 0) return;
        const primary = row[0];
        if (primary === undefined || primary === null || String(primary).trim() === "") return;
        if (rowStatuses[index] === "pending-deletion") return;
        candidates.push(row);
    });

    if (candidates.length === 0) return "";

    const picked = sampleProgressive(candidates.length, {
        recentCount: s.recentCount,
        midCount: s.midCount,
        farCount: s.farCount,
    });
    if (picked.length === 0) return "";

    const body = picked.map(pos => renderRow(candidates[pos], headers, s.targetTable)).join("\n\n");
    const template = s.template || PLACEHOLDER;
    return template.includes(PLACEHOLDER) ? template.replace(PLACEHOLDER, body) : `${template}\n${body}`;
}

/**
 * 执行注入。由统一注入周期（executeAmily2Injection）调用。
 * @param {string} [type] 'quiet' 时跳过（与表格注入器一致）
 */
export function injectProgressiveMemory(type) {
    try {
        if (type === "quiet") return;

        const content = buildProgressiveInjection();
        if (!content) {
            setExtensionPrompt(INJECTION_KEY, "", 0, 0, false, 0);
            return;
        }

        const s = getSettings();
        const inj = s.injection || {};
        setExtensionPrompt(
            INJECTION_KEY,
            content,
            parseInt(inj.position ?? 1, 10),
            parseInt(inj.depth ?? 0, 10),
            false,
            parseInt(inj.role ?? 0, 10),
        );
        console.log(`[Amily2-渐进记忆] 已注入 (position:${inj.position}, depth:${inj.depth}, role:${inj.role})。`);
    } catch (error) {
        console.error("[Amily2-渐进记忆] 注入失败:", error);
    }
}

export function clearProgressiveMemoryInjection() {
    try {
        setExtensionPrompt(INJECTION_KEY, "", 0, 0, false, 0);
    } catch { /* ST 未就绪时静默 */ }
}
