import { getRequestHeaders } from "/script.js";
import { getContext } from "/scripts/extensions.js";
import { amilyHelper } from '../../../core/tavern-helper/main.js';
import Options from './Options.js';
import RequestBody from './RequestBody.js';

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
                result = await this._callPreset(callerName, requestBody, options);
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
            body: JSON.stringify(payload)
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
            // 2. 根据流式需求分流处理
            if (options.fakeStream) {
                // 【流式预设请求】
                // 难点：ST 的 ConnectionManagerRequestService 不暴露流。
                // 策略：切换 Profile 后，手动向生成接口发送请求。
                const url = '/api/backends/chat-completions/generate';
                
                // [修复]: 手动合并 Profile 中的关键参数，否则后端不会自动应用预设配置
                // 提取逻辑已封装至 _buildProfilePayload
                const profilePayload = this._buildProfilePayload(targetProfile);

                // 合并顺序：基础Payload(msg) < Profile预设 < 显式Params覆盖
                // toMinimalPayload 包含: messages, stream, max_tokens, ...params
                const minimal = requestBody.toMinimalPayload();
                
                const finalPayload = {
                    ...profilePayload,
                    ...minimal, 
                    ...options.params 
                };

                const fetchOpts = {
                    method: 'POST',
                    headers: { ...getRequestHeaders(), ...this.defaultHeaders },
                    body: JSON.stringify(finalPayload)
                };
                return await this._fetchFakeStream(url, fetchOpts);
            } else {
                // 【非流式预设请求】
                // 直接使用 ST 原生服务，最稳妥
                if (!context.ConnectionManagerRequestService) throw new Error('ST Request Service unavailable');
                return await context.ConnectionManagerRequestService.sendRequest(
                    targetProfile.id,
                    requestBody.messages,
                    options.maxTokens
                );
            }

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
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = ""; // 用于存储最终拼接的纯文本
        let buffer = ""; // 用于存储未处理完的数据片段
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // 1. 解码当前数据包
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // 2. 处理 SSE 格式 (data: {...})
                // 以双换行符分割每一条 SSE 消息
                const lines = buffer.split('\n');

                // 保留最后一个可能不完整的片段在 buffer 中
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;

                    if (trimmed.startsWith('data: ')) {
                        try {
                            const jsonStr = trimmed.substring(6); // 去掉 'data: '
                            const json = JSON.parse(jsonStr);

                            // 提取 delta content
                            const delta = json.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullContent += delta;
                            }
                        } catch (e) {
                            // 忽略解析错误的行，防止因为个别丢包导致整个请求失败
                            console.warn('[ModelCaller] SSE Parse Error:', e);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        // 如果 fullContent 是空的，说明可能服务端根本没返回 SSE 格式，而是直接返回了纯文本或 JSON
        // 这种情况下尝试降级处理
        if (!fullContent && buffer) {
            try {
                const json = JSON.parse(buffer);
                return json; // 是标准 JSON
            } catch {
                return buffer; // 是纯文本
            }
        }

        return fullContent;
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
     * 用于在手动构造请求时模拟 ST 后端行为
     */
    _buildProfilePayload(targetProfile) {
        return {
            // 基础模型参数
            model: targetProfile.openai_model || targetProfile.model,
            temperature: targetProfile.temperature,
            frequency_penalty: targetProfile.frequency_penalty,
            presence_penalty: targetProfile.presence_penalty,
            top_p: targetProfile.top_p,
            top_k: targetProfile.top_k,
            min_p: targetProfile.min_p,
            repetition_penalty: targetProfile.repetition_penalty,
            
            // 关键：OpenAI 源标记
            chat_completion_source: targetProfile.chat_completion_source || 'openai',
            
            // 代理设置 (如果预设里有)
            reverse_proxy: targetProfile.reverse_proxy,
            proxy_password: targetProfile.proxy_password,
            
            // 其他可能影响生成的参数
            custom_prompt_post_processing: targetProfile.custom_prompt_post_processing ?? 'strict',
            include_reasoning: targetProfile.include_reasoning ?? false,
        };
    }
}

