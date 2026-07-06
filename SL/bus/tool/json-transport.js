/**
 * SL/bus/tool/json-transport.js — 工具调用的 JSON 降级运输层（Phase A.5）
 *
 * 背景：部分中转站不支持/直接拒绝带 tools 字段的请求。本模块把同一份工具
 * schema 渲染进 prompt，让模型以纯 JSON 文本"模拟" tool_calls——插件作者
 * 无感知：define 一次工具 + 一个 handler，运输方式由 callWithTools 切换。
 *
 * 协议（可靠性优先）：
 *   - 每轮模型只能输出【一个】JSON 对象，二选一：
 *       调用工具:  {"tool_call": {"name": "工具名", "arguments": {...}}}
 *       结束回答:  {"final_answer": "最终答复文本"}
 *   - 单调用/轮：多调用数组在高温下极易错位，单调用多跑一两轮换稳定，值。
 *   - 工具结果以 user 消息回喂（带 [TOOL_RESULT] 标记），不用 tool role——
 *     JSON 模式的意义就是兼容不认识 tool role 的接口。
 *
 * 本文件只做 prompt 渲染与响应解析（纯函数，可离线测试），loop 在 ModelCaller。
 */

/**
 * 把工具 schema 数组渲染成注入 system prompt 的工具使用说明。
 * @param {Object[]} toolDefs 标准 OpenAI tool def 数组（{type:'function', function:{name,description,parameters}}）
 * @returns {string}
 */
export function buildJsonToolPrompt(toolDefs) {
    const lines = [
        '## 工具调用规则（重要）',
        '你可以调用以下工具完成任务。本轮回复必须是【一个 JSON 对象】，不要输出任何其他文字、解释或 markdown 围栏。',
        '',
        '可用工具：',
    ];
    for (const def of toolDefs) {
        const fn = def?.function ?? {};
        lines.push(`- ${fn.name}: ${fn.description || '(无描述)'}`);
        lines.push(`  参数 JSONSchema: ${JSON.stringify(fn.parameters ?? { type: 'object', properties: {} })}`);
    }
    lines.push(
        '',
        '输出格式（严格二选一）：',
        '1. 需要调用工具时（每轮只能调用一个）：',
        '   {"tool_call": {"name": "工具名", "arguments": { 按该工具的参数 schema 填写 }}}',
        '2. 任务完成、给出最终答复时：',
        '   {"final_answer": "你的最终答复文本"}',
        '',
        '工具执行结果会以 [TOOL_RESULT] 开头的消息回传给你，请根据结果决定下一步（继续调用工具或给出 final_answer）。',
    );
    return lines.join('\n');
}

/**
 * 把一次工具执行结果包装成回喂消息（user role，兼容不认识 tool role 的接口）。
 * @param {string} name 工具名
 * @param {any} result handler 返回值（或 {error} 对象）
 * @returns {{role:'user', content:string}}
 */
export function buildJsonToolResultMessage(name, result) {
    const body = typeof result === 'string' ? result : JSON.stringify(result ?? null);
    return {
        role: 'user',
        content: `[TOOL_RESULT] 工具 ${name} 的执行结果：\n${body}\n\n请根据结果继续：调用下一个工具，或输出 {"final_answer": "..."} 结束。`,
    };
}

/**
 * 从模型的文本回复中解析协议 JSON。
 * 容错：剥 ```json 围栏、截取首个 { 到末个 } 的片段再试。
 *
 * @param {string} text 模型原始回复
 * @returns {{ type:'tool_call', name:string, arguments:Object }
 *         | { type:'final', content:string }
 *         | { type:'invalid', reason:string }}
 */
export function parseJsonToolResponse(text) {
    if (!text || typeof text !== 'string') {
        return { type: 'invalid', reason: '回复为空' };
    }

    // 依次尝试：原文 → 剥围栏 → 首{到末}片段
    const candidates = [];
    const trimmed = text.trim();
    candidates.push(trimmed);
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidates.push(fenced[1].trim());
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

    let parsed = null;
    for (const c of candidates) {
        try { parsed = JSON.parse(c); break; } catch { /* 试下一个 */ }
    }
    if (!parsed || typeof parsed !== 'object') {
        return { type: 'invalid', reason: '未能从回复中解析出合法 JSON 对象' };
    }

    if (parsed.tool_call && typeof parsed.tool_call === 'object') {
        const { name, arguments: args } = parsed.tool_call;
        if (!name || typeof name !== 'string') {
            return { type: 'invalid', reason: 'tool_call.name 缺失或非字符串' };
        }
        return {
            type: 'tool_call',
            name,
            arguments: (args && typeof args === 'object') ? args : {},
        };
    }

    if (typeof parsed.final_answer === 'string') {
        return { type: 'final', content: parsed.final_answer };
    }

    return { type: 'invalid', reason: 'JSON 既无 tool_call 也无 final_answer' };
}

/**
 * 构造"格式错误，请重发"的纠错回喂消息。
 * @param {string} reason 解析失败原因
 * @returns {{role:'user', content:string}}
 */
export function buildJsonRetryMessage(reason) {
    return {
        role: 'user',
        content: `[FORMAT_ERROR] 你上一条回复不符合协议（${reason}）。`
            + '请重新输出：必须是单个 JSON 对象，{"tool_call": {"name": "...", "arguments": {...}}} 或 {"final_answer": "..."}，不要包含任何其他文字。',
    };
}
