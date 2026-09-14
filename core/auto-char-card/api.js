import { extension_settings } from "/scripts/extensions.js";
import { getRequestHeaders, saveSettingsDebounced } from "/script.js";
import { extensionName } from "../../utils/settings.js";
import { acquireProfileRequestPermit, bindSlotProfileRateLimit, getSlotProfile } from '../api/api-resolver.js';
import { apiKeyStore } from '../../utils/config/api-key-store/ApiKeyStore.js';
import { mergeSafeModelCallOptions } from '../api/safe-call-options.js';
import { readOpenAICompatibleResponse } from '../api/streaming-response.js';

const DEFAULT_CONFIG = {
    apiUrl: "",
    apiKey: "",
    model: "",
    maxTokens: 4000,
    temperature: 0.7,
    fakeStream: false,
};

/** 同步读取旧版配置（UI 加载 / 保存用） */
export function getApiConfig(role) {
    const settings = extension_settings[extensionName] || {};
    const configKey = `acc_${role}_config`;
    return { ...DEFAULT_CONFIG, ...(settings[configKey] || {}) };
}

/** 异步读取配置：Profile 优先，fallback 到旧版 */
export async function getResolvedApiConfig(role) {
    const profile = await getSlotProfile('autoCharCard');
    if (profile) {
        return bindSlotProfileRateLimit({
            apiUrl:      profile.apiUrl,
            apiKey:      profile.apiKey ?? '',
            model:       profile.model,
            maxTokens:   profile.maxTokens ?? DEFAULT_CONFIG.maxTokens,
            temperature: profile.temperature ?? DEFAULT_CONFIG.temperature,
            fakeStream:  profile.fakeStream ?? false,
            customParams: profile.customParams ?? {},
        }, profile);
    }
    const legacy = getApiConfig(role);
    const keyId = `legacy_acc_${role}`;
    const storedKey = await apiKeyStore.retrieveById(keyId);
    if (storedKey) return { ...legacy, apiKey: storedKey };

    // One-time lazy migration for existing plaintext nested settings. New
    // writes use ApiKeyStore directly, so this path disappears after first
    // read and never requires the user to re-enter a credential.
    if (legacy.apiKey) {
        await apiKeyStore.storeById(keyId, legacy.apiKey);
        const configKey = `acc_${role}_config`;
        delete extension_settings[extensionName]?.[configKey]?.apiKey;
        saveSettingsDebounced();
    }
    return legacy;
}

export async function setApiConfig(role, config) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const configKey = `acc_${role}_config`;
    const { apiKey, ...nonSensitiveConfig } = config;
    const { apiKey: legacyApiKey, ...currentConfig } = getApiConfig(role);
    extension_settings[extensionName][configKey] = { ...currentConfig, ...nonSensitiveConfig };
    if (apiKey !== undefined) {
        await apiKeyStore.storeById(`legacy_acc_${role}`, apiKey);
    }
}

export async function callAi(role, messages, options = {}, onChunk = null) {
    const master = extension_settings[extensionName] || {};
    if (master.autoCharCardEnabled === false) {
        throw new Error('[自动构建器] 一键生卡总开关已关闭，请先在 API 连接「分配」页或生卡面板开启。');
    }

    const config = mergeSafeModelCallOptions(await getResolvedApiConfig(role), options);
    const roleName = role === 'executor' ? '执行者(模型A)' : '规划者(模型B)';

    if (!config.apiUrl || !config.apiKey || !config.model) {
        throw new Error(`[自动构建器] ${roleName} API 配置不完整，请检查 URL、Key 和模型设置。`);
    }

    const useStream = Boolean(onChunk || config.fakeStream);
    console.log(`[自动构建器] 正在调用 AI (${roleName})...`, {
        model: config.model,
        messagesCount: messages.length,
        stream: useStream,
    });

    const body = {
        ...(config.customParams || {}),
        chat_completion_source: 'openai',
        messages: messages,
        model: config.model,
        reverse_proxy: config.apiUrl,
        proxy_password: config.apiKey,
        stream: useStream,
        max_tokens: config.maxTokens > 0 ? config.maxTokens : undefined,
        temperature: config.temperature,
        top_p: 1,
        custom_prompt_post_processing: 'strict',
        enable_web_search: false,
        frequency_penalty: 0,
        presence_penalty: 0,
    };

    try {
        await acquireProfileRequestPermit(config, config.signal);
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: config.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
        }

        const responseData = await readOpenAICompatibleResponse(response, {
            stream: useStream,
            onTextDelta: typeof onChunk === 'function' ? onChunk : undefined,
        });

        if (!responseData || !responseData.choices || responseData.choices.length === 0) {
            if (responseData?.error) {
                throw new Error(`API 返回错误: ${responseData.error.message || JSON.stringify(responseData.error)}`);
            }
            throw new Error('API 返回了空响应。');
        }

        const content = responseData.choices[0].message?.content;
        if (!content) {
            console.warn(`[自动构建器] AI (${roleName}) 响应内容为空。完整响应:`, responseData);
        }

        console.log(`[自动构建器] AI (${roleName}) 响应接收成功。长度: ${content?.length}`);
        return content;

    } catch (error) {
        console.error(`[自动构建器] AI (${roleName}) 调用失败:`, error);
        throw error;
    }
}

export async function testConnection(role, config = {}) {
    try {
        const response = await callAi(role, [
            { role: 'user', content: 'Say hello' }
        ], { maxTokens: 50, ...config });
        
        if (!response) {
            return { success: false, error: "API 返回了空内容 (可能是被安全过滤或模型无响应)" };
        }

        return { success: true };
    } catch (error) {
        console.error(`[自动构建器] ${role} 连接测试失败:`, error);
        return { success: false, error: error.message };
    }
}

/** Omitted arguments resolve one saved connection; an explicit URL never borrows a saved key. */
export async function fetchModels(apiUrl, apiKey) {
    try {
        if (apiUrl === undefined && apiKey === undefined) {
            const resolved = await getResolvedApiConfig('executor');
            apiUrl = resolved.apiUrl;
            apiKey = resolved.apiKey;
        }
        if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
            throw new Error('获取模型列表需要有效的 API URL。');
        }
        apiUrl = apiUrl.trim();
        if (apiKey === undefined) apiKey = '';
        if (typeof apiKey !== 'string') {
            throw new TypeError('API Key 必须为字符串，无鉴权时可为空。');
        }

        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reverse_proxy: apiUrl,
                proxy_password: apiKey,
                chat_completion_source: 'openai'
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        if (!data || typeof data !== 'object' || data.error) {
            throw new Error('模型接口返回错误或无效数据。');
        }
        const models = Array.isArray(data) ? data : (Object.hasOwn(data, 'data') ? data.data : (data.models ?? []));
        if (!Array.isArray(models)) throw new Error('模型列表必须为数组。');
        const ids = models.map(model => {
            const id = typeof model === 'string' ? model : (model?.id ?? model?.model ?? model?.name);
            if (typeof id !== 'string' || !id.trim()) throw new Error('模型列表包含无效的模型 ID。');
            return id;
        });
        return [...new Set(ids)].sort();

    } catch (error) {
        console.error('[自动构建器] 获取模型列表失败:', error);
        throw error;
    }
}
