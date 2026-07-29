import { getRequestHeaders } from "/script.js";
import { getContext, extension_settings } from "/scripts/extensions.js";
import { amilyHelper } from '../../../core/tavern-helper/main.js';
import { runWithSillyTavernProfileLock } from '../../../core/api/api-resolver.js';
import { sanitizeCustomModelParams } from '../../../core/api/safe-call-options.js';
import {
    readOpenAICompatibleResponse,
    readSillyTavernPresetResponse,
} from '../../../core/api/streaming-response.js';
import Options from './Options.js';
import RequestBody from './RequestBody.js';

// 带 tools 的请求失败时统一追加的提示：很多中转站偷懒直接禁用了工具调用，
// 收到 tools 参数即拒。这没法靠 URL 预判，只能在失败时把原因讲清楚，少一批截图提问。
const TOOL_REJECT_HINT = '（带工具调用的请求失败——部分中转站禁用了 tools 参数；请更换支持 function calling 的接口，或关闭工具调用模式）';

/**
 * ModelCaller Service
 * 负责执行 API 调用逻辑，旨在替换 NccsApi 及其他散乱的请求逻辑。
 * 支持：标准直连、ST预设调用、伪流式聚合(防超时)、数据归一化。
 */
export default class ModelCaller {
    /**
     * 构造函数注入 Logger 依赖
     * @param {Object} loggerDelegate - { log: (level, msg, origin, plugin) => void }
     */
    constructor(loggerDelegate) {
        /** @type {Object} */
        this.logger = loggerDelegate;
        this.defaultHeaders = {
            'Content-Type': 'application/json'
        };
    }

    /**
     * 统一调用入口
     * @param {string} callerName - 调用者名称（日志用）
     * @param {Array} messages - 聊天消息历史
     * @param {Options} options - 配置对象实例
     * @returns {Promise<string>} - 返回归一化后的文本内容
     */
    async call(callerName, messages, options) {
        // 1. 强制类型检查
        if (!(options instanceof Options)) {
            const errorMsg = `[ModelCaller] Options must be instance of Options class.`;
            throw new TypeError(errorMsg);
        }

        // 2. 逻辑中直接使用 options 属性
        // 记录一下当前的流模式，方便调试
        this._log('info', `API Request [${options.mode}] StreamMode: ${options.fakeStream}`, callerName);

        try {
            // 统一构建请求体 DTO
            const requestBody = new RequestBody(messages, options);
            let result;

            if (options.mode === 'preset') {
                result = await runWithSillyTavernProfileLock(
                    () => this._callPreset(callerName, requestBody, options),
                    options.signal,
                );
            } else {
                result = await this._callDirect(callerName, requestBody, options);
            }

            // 如果是流式返回，result 已经是拼接好的字符串，不需要 normalize 的部分逻辑
            // 但为了统一，我们还是传进去检查一下
            return this._normalize(result, options.fakeStream);
        } catch (error) {
            this._log('error', `Request Failed: ${error.message}`, callerName);
            throw error;
        }
    }

    // 内部日志封装
    _log(level, msg, plugin) {
        if (this.logger?.log) {
            this.logger.log(level, msg, 'ModelCaller', plugin);
        }
    }

    /**
     * 从原始响应中取出完整的 assistant message（含 tool_calls），而非只取 content 文本。
     * @returns {Object|null} { role, content, tool_calls? }
     */
    _extractMessage(data) {
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { return { role: 'assistant', content: data }; }
        }
        return data?.choices?.[0]?.message ?? null;
    }

    /**
     * 带工具的 agent loop（Phase A + A.5 双运输）。
     *
     * 与 call() 不同：call() 经 _normalize 只返字符串、丢弃 tool_calls；本方法保留完整 raw message，
     * 流式时先重组 tool_calls，再串行 dispatch 回 handler 并回喂后续轮，直到模型不再调用工具或触顶 maxSteps。
     *
     * 双运输（A.5）：
     *   - 'tools'：原生 OpenAI function calling（省输出 token，首选）
     *   - 'json' ：工具 schema 渲染进 prompt，模型吐协议 JSON（兼容禁 tools 的中转站）
     *   - 'auto' ：先 tools，请求被拒/响应异常时自动降级 json 续跑（默认）
     *
     * @param {string} callerName 插件名（日志用）
     * @param {Array} messages 初始消息（不被原地修改，内部克隆）
     * @param {Options} options 连接配置（apiUrl/apiKey/model/fakeStream/...）；工具循环固定使用 direct 运输
     * @param {Object} loop
     * @param {() => Object[]} loop.getToolDefs 返回本插件已 define 的工具 schema 数组
     * @param {(name: string, args: Object) => Promise<any>} loop.dispatch 派发 tool_call 到 handler
     * @param {number} [loop.maxSteps=8] 最多模型轮次，防死循环
     * @param {'feedback'|'throw'} [loop.onToolError='feedback'] handler 抛错时：回喂错误让模型自纠 / 直接抛出
     * @param {'auto'|'tools'|'json'} [loop.transport='auto'] 运输方式（见上）
     * @param {Object[]} [loop.tools] 额外工具（与 getToolDefs 合并，按 function.name 去重）
     * @param {Object|string} [loop.toolChoice='auto']
     * @returns {Promise<{ content: string, steps: number, finishReason: 'stop'|'maxSteps', messages: Array, toolCalls: Array, transport: 'tools'|'json' }>}
     */
    async callWithTools(callerName, messages, options, loop = {}) {
        if (!(options instanceof Options)) {
            throw new TypeError('[ModelCaller] callWithTools: options must be instance of Options class.');
        }
        const {
            getToolDefs = () => [],
            dispatch,
            maxSteps = 8,
            onToolError = 'feedback',
            transport = 'auto',
            tools: extraTools = [],
            toolChoice = 'auto',
        } = loop;
        if (typeof dispatch !== 'function') {
            throw new TypeError('[ModelCaller] callWithTools: loop.dispatch is required.');
        }
        // preset 模式走 ConnectionManagerRequestService，无法携带 tools 也拿不到 raw message；
        // 显式拒绝，避免静默强转 direct 后拿空 apiUrl 撞出莫名错误
        if (options.mode === 'preset') {
            throw new Error('[ModelCaller] callWithTools 暂不支持 ST 预设模式（preset），请使用 direct 连接配置。');
        }

        // 合并工具（显式传入 + 注册表），按 function.name 去重
        const byName = new Map();
        for (const def of [...(extraTools || []), ...(getToolDefs() || [])]) {
            const name = def?.function?.name;
            if (name && !byName.has(name)) byName.set(name, def);
        }
        const toolDefs = Array.from(byName.values());
        if (toolDefs.length === 0) {
            throw new Error('[ModelCaller] callWithTools: no tools supplied by the internal task scope.');
        }

        const convo = Array.isArray(messages) ? [...messages] : [];
        const allToolCalls = [];

        let activeTransport = transport === 'json' ? 'json' : 'tools';
        let jsonPromptInjected = false;

        // 进入 json 运输时把工具说明注入对话开头（只注一次）
        const enterJsonMode = () => {
            activeTransport = 'json';
            if (!jsonPromptInjected) {
                convo.unshift({ role: 'system', content: buildJsonToolPrompt(toolDefs) });
                jsonPromptInjected = true;
            }
        };
        if (activeTransport === 'json') enterJsonMode();

        // dispatch 封装：错误按 onToolError 语义处理（两种运输共用）
        const runHandler = async (name, args) => {
            try {
                return await dispatch(name, args);
            } catch (err) {
                if (onToolError === 'throw') throw err;
                this._log('warn', `tool "${name}" 出错，回喂模型自纠: ${err.message}`, callerName);
                return { error: String(err.message || err) };
            }
        };

        for (let step = 1; step <= maxSteps; step++) {
            this._log('info', `callWithTools step ${step}/${maxSteps} [${activeTransport}] (tools:${toolDefs.length})`, callerName);

            // ── tools 运输 ────────────────────────────────────────────────
            if (activeTransport === 'tools') {
                let message = null;
                try {
                    // 仅请求/响应校验在 try 内：dispatch 失败是业务错误，不触发运输降级
                    message = await this._requestToolsMessage(callerName, convo, options, toolDefs, toolChoice);
                } catch (reqErr) {
                    if (transport !== 'auto') {
                        throw new Error(`${reqErr.message} ${TOOL_REJECT_HINT}`);
                    }
                    // auto：大概率中转拒收 tools → 降级 JSON 续跑（本步在下方用 json 重试）
                    this._log('warn', `tools 运输失败，自动降级 JSON 模式: ${reqErr.message}`, callerName);
                    enterJsonMode();
                }

                if (message) {
                    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

                    // 无工具调用 → 终态
                    if (toolCalls.length === 0) {
                        return {
                            content: (message.content || '').trim(),
                            steps: step,
                            finishReason: 'stop',
                            messages: convo,
                            toolCalls: allToolCalls,
                            transport: 'tools',
                        };
                    }

                    // assistant 原样压回（保留 content=null 等合规形态，避免严格 provider 拒收）
                    convo.push(message);

                    for (const tc of toolCalls) {
                        const name = tc?.function?.name;
                        let args = {};
                        let result;
                        try {
                            args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                            result = await runHandler(name, args);
                        } catch (parseErr) {
                            if (onToolError === 'throw') throw parseErr;
                            result = { error: `arguments JSON 解析失败: ${parseErr.message}` };
                        }
                        allToolCalls.push({ name, args, result });
                        convo.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            name,
                            content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
                        });
                    }
                    continue;
                }
                // message 为空 = 已降级，落到下方 json 路径重试本步
            }

            // ── json 运输 ────────────────────────────────────────────────
            const stepOptions = new Options({
                mode: 'direct',
                fakeStream: options.fakeStream,
                apiUrl: options.apiUrl,
                apiKey: options.apiKey,
                model: options.model,
                maxTokens: options.maxTokens,
                temperature: options.temperature,
                params: options.params,
                signal: options.signal,
            });
            const raw = await this._callDirect(callerName, new RequestBody(convo, stepOptions), stepOptions);
            if (raw && raw.error) {
                const msg = raw.error?.message || (typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error));
                throw new Error(`接口拒绝了请求: ${msg}`);
            }
            const jsonMessage = this._extractMessage(raw);
            const text = (jsonMessage?.content || '').trim();
            if (!text) {
                throw new Error('callWithTools(json): 未取到有效响应文本');
            }

            const parsed = parseJsonToolResponse(text);

            if (parsed.type === 'final') {
                return {
                    content: parsed.content,
                    steps: step,
                    finishReason: 'stop',
                    messages: convo,
                    toolCalls: allToolCalls,
                    transport: 'json',
                };
            }

            convo.push({ role: 'assistant', content: text });

            if (parsed.type === 'invalid') {
                // 协议不合规：纠错回喂，消耗一步（maxSteps 天然防无限纠错）
                this._log('warn', `JSON 协议解析失败(${parsed.reason})，回喂纠错`, callerName);
                convo.push(buildJsonRetryMessage(parsed.reason));
                continue;
            }

            // tool_call
            const result = await runHandler(parsed.name, parsed.arguments);
            allToolCalls.push({ name: parsed.name, args: parsed.arguments, result });
            convo.push(buildJsonToolResultMessage(parsed.name, result));
        }

        // 触顶 maxSteps 仍未收尾：返回最后状态
        this._log('warn', `callWithTools 触顶 maxSteps(${maxSteps})，强制结束`, callerName);
        return {
            content: '',
            steps: maxSteps,
            finishReason: 'maxSteps',
            messages: convo,
            toolCalls: allToolCalls,
            transport: activeTransport,
        };
    }

    /**
     * tools 运输的单步请求：带 tools 发一轮，校验错误体，抽出完整 assistant message。
     * 三个失败点统一抛错，由调用方决定"报错(强制 tools)"还是"降级(auto)"。
     */
    async _requestToolsMessage(callerName, convo, options, toolDefs, toolChoice) {
        // 共享聚合器会完整重建 tool_calls，因此工具运输也可以启用防超时。
        const stepOptions = new Options({
            mode: 'direct',
            fakeStream: options.fakeStream,
            apiUrl: options.apiUrl,
            apiKey: options.apiKey,
            model: options.model,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            params: options.params,
            tools: toolDefs,
            toolChoice,
            signal: options.signal,
        });
        const raw = await this._callDirect(callerName, new RequestBody(convo, stepOptions), stepOptions);
        // 部分中转返回 HTTP 200 但 body 带 error（如"工具调用未启用"）
        if (raw && raw.error) {
            const msg = raw.error?.message || (typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error));
            throw new Error(`接口拒绝了请求: ${msg}`);
        }
        const message = this._extractMessage(raw);
        if (!message) {
            throw new Error('未取到有效响应消息');
        }
        return message;
    }

    // ========================================================================
    // 模式一：Direct (标准直连)
    // 对应 NccsApi 中的 callNccsOpenAITest
    // ========================================================================
    async _callDirect(callerName, requestBody, options) {
        // 构建标准 OpenAI 兼容 Body
        // 目标通常是 ST 的后端代理接口
        const url = '/api/backends/chat-completions/generate';
        const payload = requestBody.toPayload(); // 使用 DTO 生成数据

        const fetchOpts = {
            method: 'POST',
            headers: { ...getRequestHeaders(), ...this.defaultHeaders },
            body: JSON.stringify(payload),
            signal: options.signal,
        };

        return options.fakeStream
            ? this._fetchFakeStream(url, fetchOpts)
            : this._fetchStandard(url, fetchOpts);
    }

    // ========================================================================
    // 模式二：Preset (ST预设调用)
    // 对应 NccsApi 中的 callNccsSillyTavernPreset
    // ========================================================================
    async _callPreset(callerName, requestBody, options) {
        const context = getContext();

        // 1. 记录并切换 Profile
        const originalProfile = await amilyHelper.triggerSlash('/profile');
        const targetProfile = context.extensionSettings?.connectionManager?.profiles?.find(p => p.id === options.presetId);

        if (!targetProfile) throw new Error(`Preset ID ${options.presetId} not found`);

        if (originalProfile !== targetProfile.name) {
            this._log('info', `Switching profile: ${originalProfile} -> ${targetProfile.name}`, callerName);
            const escapedName = targetProfile.name.replace(/"/g, '\\"');
            await amilyHelper.triggerSlash(`/profile await=true "${escapedName}"`);
        }

        try {
            if (!context.ConnectionManagerRequestService) {
                throw new Error('ST Request Service unavailable');
            }
            const useStream = options.fakeStream === true;
            const overridePayload = sanitizeCustomModelParams(options.params);
            if (Array.isArray(options.tools) && options.tools.length > 0) {
                overridePayload.tools = options.tools;
                if (options.toolChoice) overridePayload.tool_choice = options.toolChoice;
            }
            return await readSillyTavernPresetResponse(
                context.ConnectionManagerRequestService.sendRequest(
                    targetProfile.id,
                    requestBody.messages,
                    options.maxTokens,
                    { stream: useStream, signal: options.signal },
                    overridePayload,
                ),
                { stream: useStream },
            );

        } finally {
            // 3. 恢复 Profile
            if (originalProfile) {
                try {
                    const current = await amilyHelper.triggerSlash('/profile');
                    if (originalProfile !== current) {
                        const escapedOriginal = originalProfile.replace(/"/g, '\\"');
                        await amilyHelper.triggerSlash(`/profile await=true "${escapedOriginal}"`);
                    }
                } catch (e) {
                    this._log('warn', `Failed to restore profile: ${e.message}`, callerName);
                }
            }
        }
    }

    // ========================================================================
    // 网络层核心
    // ========================================================================

    async _fetchStandard(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }

    // 【核心升级】：支持 SSE 解析的伪流式聚合，防 CloudFlare 超时
    async _fetchFakeStream(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`Stream HTTP ${res.status}`);
        return readOpenAICompatibleResponse(res, { stream: true });
    }

    // ========================================================================
    // 数据归一化
    // ========================================================================

    _normalize(data, isFromStream = false) {
        // 如果是从流式聚合来的，它已经是一个纯字符串了，直接返回
        if (isFromStream && typeof data === 'string') {
            return data;
        }

        // 如果是 JSON 字符串则解析
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { return data; }
        }

        // 处理 OpenAI 格式
        if (data?.choices?.[0]?.message?.content) {
            return data.choices[0].message.content.trim();
        }

        // 处理常规 content 格式
        if (data?.content) {
            return data.content.trim();
        }

        // Fallback
        return typeof data === 'object' ? JSON.stringify(data) : data;
    }

    /**
     * 辅助方法：从 Profile 对象中提取标准生成参数
     * 严格复刻 SillyTavern 原始 Payload 逻辑
     */
    _buildProfilePayload(targetProfile) {
        const context = getContext();
        
        // 1. 基础克隆
        const payload = { ...targetProfile };

        // 2. 注入运行时元数据 (这是旧版能通的关键，包含用户/角色名等)
        payload.user_name = context.name1 || 'User';
        payload.char_name = context.name2 || 'AI';
        payload.group_names = []; // 暂不处理群组
        payload.use_sysprompt = true;
        payload.type = 'quiet';
        payload.custom_prompt_post_processing = payload.custom_prompt_post_processing || 'strict';

        // 3. 规范化模型字段
        if (!payload.model) {
            payload.model = payload.openai_model || payload.claude_model || payload.mistral_model || '';
        }

        // 4. 精准对齐 URL 映射 (解决 403/400 错误的核心)
        const rawUrl = payload['api-url'] || payload['api_url'] || payload.custom_url || payload.url;
        if (rawUrl) {
            // 如果 Source 是 custom，严格遵循旧版：custom_url 有值，reverse_proxy 为空
            if (payload.chat_completion_source === 'custom') {
                payload.custom_url = rawUrl;
                payload.reverse_proxy = payload.reverse_proxy || ''; 
            } else {
                // 如果是 openai，则填充 reverse_proxy
                payload.reverse_proxy = rawUrl;
                payload.custom_url = rawUrl;
            }
            // 兼容性修补
            payload.zai_endpoint = rawUrl;
            payload.vertexai_region = rawUrl;
        }

        // 5. 补全采样参数 (严格对齐 UI 当前状态)
        const globalGenSettings = extension_settings.text_generation || {};
        const fields = ['temperature', 'max_tokens', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'];
        fields.forEach(field => {
            if (payload[field] === undefined) {
                payload[field] = globalGenSettings[field] ?? (field === 'temperature' ? 1 : 0);
            }
        });

        // 6. 确保 Source 存在且不被错误覆盖
        if (!payload.chat_completion_source) {
            payload.chat_completion_source = 'openai';
        }

        return payload;
    }
}

