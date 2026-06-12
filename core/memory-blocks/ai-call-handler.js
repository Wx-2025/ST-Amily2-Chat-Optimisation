/**
 * core/memory-blocks/ai-call-handler.js — 'ai_call' generator handler（Phase 2）
 *
 * 执行一次独立 AI 调用，把回复（或其中指定标签的内容）作为块的替换值。
 *
 * 与 generator-handlers.js 分离的原因：本 handler 依赖 core/api.js（牵涉
 * DOM / ST 运行时），注册表本身保持零依赖，便于单测与 JSON 工具复用。
 *
 * generator 字段（AiCallGenerator，契约见 types.js）：
 *   apiSlot        - callAI 的功能槽（'main' / 'plotOpt' / 'nccs' ...），缺省 'main'
 *   promptTemplate - 作为 user 消息发送的提示词（必填，空则块跳过）
 *   systemPrompt   - 可选，附加在前面的 system 消息
 *   extractTag     - 可选，只取回复中最后一个 <tag>...</tag> 的内容；
 *                    标签缺失时回退为完整回复（宽容处理，模型偶发不包
 *                    标签时块仍有产出，而不是静默保留占位符）
 *
 * 失败语义（与 executor 约定一致）：
 *   - callAI 内部捕获的 API 错误返回 null → 块产出 null → 占位符保留
 *   - AbortError 由 callAI 原样上抛 → executor 整体中断（signal 贯穿 fetch）
 */

import { callAI } from '../api.js';
import { extractContentByTag } from '../../utils/tagProcessor.js';
import { registerHandler } from './generator-handlers.js';

registerHandler('ai_call', async (block, ctx) => {
    const gen = block.generator || {};
    const prompt = typeof gen.promptTemplate === 'string' ? gen.promptTemplate.trim() : '';
    if (!prompt) {
        console.warn(`[MemoryBlocks] ai_call 块 ${block.id} 缺少 promptTemplate，已跳过。`);
        return null;
    }

    const messages = [];
    if (typeof gen.systemPrompt === 'string' && gen.systemPrompt.trim()) {
        messages.push({ role: 'system', content: gen.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await callAI(messages, {
        slot: gen.apiSlot || 'main',
        signal: ctx?.signal,
    });
    if (!response || !response.trim()) return null;

    if (gen.extractTag) {
        const extracted = extractContentByTag(response, gen.extractTag);
        if (extracted !== null && extracted.trim()) return extracted.trim();
        console.warn(`[MemoryBlocks] ai_call 块 ${block.id} 回复中未找到 <${gen.extractTag}> 标签，回退为完整回复。`);
    }
    return response.trim();
});

export {};
