import { extension_settings, getContext } from "/scripts/extensions.js";
import { getRequestHeaders } from "/script.js";
import { extensionName } from "../../utils/settings.js";

function getConcurrentApiSettings() {
    const settings = extension_settings[extensionName] || {};
    return {
        apiProvider: settings.plotOpt_concurrentApiProvider || 'openai',
        apiUrl: settings.plotOpt_concurrentApiUrl?.trim() || '',
        apiKey: settings.plotOpt_concurrentApiKey?.trim() || '',
        model: settings.plotOpt_concurrentModel || '',
        maxTokens: settings.plotOpt_max_tokens || 20000,
        temperature: settings.plotOpt_temperature || 1,
    };
}

export async function callConcurrentAI(messages, options = {}) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-Concurrent制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }

    const apiSettings = getConcurrentApiSettings();

    const finalOptions = {
        ...apiSettings,
        ...options
    };

    if (!finalOptions.apiUrl || !finalOptions.model || !finalOptions.apiKey) {
        console.warn("[Amily2-Concurrent外交部] API配置不完整，无法调用AI");
        toastr.error("并发API配置不完整，请检查URL、Key和模型配置。", "Concurrent-外交部");
        return null;
    }

    console.groupCollapsed(`[Amily2号-Concurrent统一API调用] ${new Date().toLocaleTimeString()}`);
    console.log("【请求参数】:", { 
        provider: finalOptions.apiProvider,
        model: finalOptions.model, 
        maxTokens: finalOptions.maxTokens, 
        temperature: finalOptions.temperature,
        messagesCount: messages.length
    });
    console.log("【消息内容】:", messages);
    console.groupEnd();

    try {
        let responseContent;

        // For now, we only support openai_test like provider.
        // More can be added here following the structure of JqyhApi.js
        switch (finalOptions.apiProvider) {
            case 'openai':
            case 'openai_test':
                responseContent = await callConcurrentOpenAITest(messages, finalOptions);
                break;
            default:
                console.error(`[Amily2-Concurrent外交部] 未支持的API模式: ${finalOptions.apiProvider}`);
                toastr.error(`并发API模式 "${finalOptions.apiProvider}" 不被支持。`, "Concurrent-外交部");
                return null;
        }

        if (!responseContent) {
            console.warn('[Amily2-Concurrent外交部] 未能获取AI响应内容');
            return null;
        }

        console.groupCollapsed("[Amily2号-Concurrent AI回复]");
        console.log(responseContent);
        console.groupEnd();

        return responseContent;

    } catch (error) {
        console.error(`[Amily2-Concurrent外交部] API调用发生错误:`, error);
        toastr.error(`并发API调用失败: ${error.message}`, "Concurrent API调用失败");
        return null;
    }
}

async function callConcurrentOpenAITest(messages, options) {
    const body = {
        chat_completion_source: 'openai',
        messages: messages,
        model: options.model,
        reverse_proxy: options.apiUrl,
        proxy_password: options.apiKey,
        stream: false,
        max_tokens: options.maxTokens || 20000,
        temperature: options.temperature || 0.7,
        top_p: options.top_p || 0.95,
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Concurrent全兼容API请求失败: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();
    return responseData?.choices?.[0]?.message?.content;
}

export async function testConcurrentApiConnection() {
    const apiSettings = getConcurrentApiSettings();
    if (!apiSettings.apiUrl || !apiSettings.apiKey) {
        toastr.error("并发API的URL或API Key未设置。", "测试连接失败");
        return;
    }

    const modelsUrl = new URL('/v1/models', apiSettings.apiUrl).toString();

    try {
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiSettings.apiKey}`,
            },
        });

        if (response.ok) {
            toastr.success("并发API连接成功！", "测试连接");
        } else {
            const errorText = await response.text();
            toastr.error(`连接失败: ${response.status}. ${errorText}`, "测试连接失败");
        }
    } catch (error) {
        console.error("[Amily2-Concurrent] 测试连接时出错:", error);
        toastr.error(`网络错误: ${error.message}`, "测试连接失败");
    }
}

export async function fetchConcurrentModels() {
    const apiSettings = getConcurrentApiSettings();
    if (!apiSettings.apiUrl || !apiSettings.apiKey) {
        throw new Error("并发API的URL或API Key未设置。");
    }

    const modelsUrl = new URL('/v1/models', apiSettings.apiUrl).toString();

    const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiSettings.apiKey}`,
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`获取模型列表失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.data.map(model => ({ id: model.id, name: model.id })); // Return in the same format as other fetchers
}
