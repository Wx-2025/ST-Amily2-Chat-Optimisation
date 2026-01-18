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
        this._log('info', `API Request [${options.mode}] Stream: ${options.fakeStream}`, callerName);

        try {
            // 统一构建请求体 DTO
            const requestBody = new RequestBody(messages, options);
            let result;

            if (options.mode === 'preset') {
                result = await this._callPreset(callerName, requestBody, options);
            } else {
                result = await this._callDirect(callerName, requestBody, options);
            }

            return this._normalize(result);
        } catch (error) {
            this._log('error', `Request Failed: ${error.message}`, callerName);
            throw error;
        }
    }

    // 内部日志封装
    _log(level, msg, plugin) {
        if (this.logger && typeof this.logger.log === 'function') {
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
                // Preset 模式下只需要最小载荷
                const payload = requestBody.toMinimalPayload();

                const fetchOpts = {
                    method: 'POST',
                    headers: { ...getRequestHeaders(), ...this.defaultHeaders },
                    body: JSON.stringify(payload)
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

    async _fetchStandard(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
            // const text = await response.text();
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    }

    // 伪流式聚合：防 CloudFlare 超时
    async _fetchFakeStream(url, options) {
        const response = await fetch(url, options);

        if (!response.ok) {
            throw new Error(`Stream HTTP ${response.status}`);
        }

        if (!response.body) {
            return await response.json();
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let aggregated = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // 持续读取保持连接活跃
                aggregated += decoder.decode(value, { stream: true });
            }
            aggregated += decoder.decode();

            try {
                return JSON.parse(aggregated);
            } catch (e) {
                // 如果是 SSE 格式或其他非 JSON 格式，暂且返回文本
                return aggregated;
            }
        } finally {
            reader.releaseLock();
        }
    }

    // ========================================================================
    // 数据归一化
    // ========================================================================

    _normalize(data) {
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
}

