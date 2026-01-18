import Options from './Options.js';

/**
 * RequestBody (DTO)
 * 严格约束发送给 LLM/ST 后端的请求体结构
 * 类似于 Java 中的 RequestBean
 */
export class RequestBody {
    /**
     * @param {Array} messages 
     * @param {Options} options 
     */
    constructor(messages, options) {
        if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
        if (!(options instanceof Options)) throw new TypeError('options must be an instance of Options');

        this.messages = messages;
        this.options = options;
    }

    /**
     * 构建标准 OpenAI 兼容的 Payload
     * @returns {Object} 纯净的 JSON 对象
     */
    toPayload() {
        const { apiUrl, apiKey, model, maxTokens, temperature, params } = this.options;
        const isGoogle = apiUrl && apiUrl.includes('googleapis.com');

        // 基础字段 (Base Fields)
        const payload = {
            chat_completion_source: 'openai',
            messages: this.messages,
            model: model,
            reverse_proxy: apiUrl,
            proxy_password: apiKey,
            stream: false, // 这里的 stream 是指 ST 后端行为，始终为 false
            max_tokens: maxTokens,
            temperature: temperature,
            // 允许 Options 中的 params 覆盖上述字段
            ...params
        };

        // 平台特定字段处理 (Platform Specific Logic)
        if (!isGoogle) {
            Object.assign(payload, {
                custom_prompt_post_processing: 'strict',
                presence_penalty: 0.12,
                include_reasoning: false,
                reasoning_effort: 'medium'
            });
        }

        return payload;
    }

    /**
     * 仅获取消息体的 Payload (用于 Preset 模式)
     */
    toMinimalPayload() {
        return {
            messages: this.messages,
            max_tokens: this.options.maxTokens,
            ...this.options.params
        };
    }
}

export default RequestBody;