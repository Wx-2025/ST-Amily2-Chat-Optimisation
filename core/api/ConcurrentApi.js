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
        maxTokens: settings.plotOpt_concurrentMaxTokens || 8100,
        temperature: settings.plotOpt_concurrentTemperature || 1,
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
    const isGoogleApi = options.apiUrl.includes('googleapis.com');

    const body = {
        chat_completion_source: 'openai',
        messages: messages,
        model: options.model,
        reverse_proxy: options.apiUrl,
        proxy_password: options.apiKey,
        stream: false,
        max_tokens: options.maxTokens || 8100,
        temperature: options.temperature || 1,
        top_p: options.top_p || 1,
    };

    if (!isGoogleApi) {
        Object.assign(body, {
            custom_prompt_post_processing: 'strict',
            enable_web_search: false,
            frequency_penalty: 0,
            group_names: [],
            include_reasoning: false,
            presence_penalty: 0.12,
            reasoning_effort: 'medium',
            request_images: false,
        });
    }

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
    console.log('[Amily2号-Concurrent外交部] 开始API连接测试');
    
    const apiSettings = getConcurrentApiSettings();

    if (!apiSettings.apiUrl || !apiSettings.apiKey || !apiSettings.model) {
        toastr.error('并发API配置不完整，请检查URL、Key和模型', 'Concurrent API连接测试失败');
        return false;
    }

    try {
        toastr.info('正在发送测试消息"你好！"...', 'Concurrent API连接测试');
        
        const userName = window.SillyTavern.getContext?.()?.name1 || '用户';
        const systemPrompt = `接下来用户会使用测试按钮测试api连接是否正常，请回复ta连接是正常的，称呼用户为：“${userName}大人”，并复述群号1060183271，告知ta，本扩展开发者：“诗与酒.”正静待ta的入驻。`;

        const testMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '你好！' }
        ];
        
        const response = await callConcurrentAI(testMessages);
        
        if (response && response.trim()) {
            console.log('[Amily2号-Concurrent外交部] 测试消息响应:', response);
            const formattedResponse = response.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            toastr.success(`连接测试成功！AI回复: "${formattedResponse}"`, 'Concurrent API连接测试成功', { "escapeHtml": false });
            return true;
        } else {
            throw new Error('API未返回有效响应');
        }
        
    } catch (error) {
        console.error('[Amily2号-Concurrent外交部] 连接测试失败:', error);
        toastr.error(`连接测试失败: ${error.message}`, 'Concurrent API连接测试失败');
        return false;
    }
}

export async function fetchConcurrentModels() {
    console.log('[Amily2号-Concurrent外交部] 开始获取模型列表');
    
    const apiSettings = getConcurrentApiSettings();
    
    try {
        if (!apiSettings.apiUrl || !apiSettings.apiKey) {
            throw new Error('API URL或Key未配置');
        }
        
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: {
                ...getRequestHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                reverse_proxy: apiSettings.apiUrl,
                proxy_password: apiSettings.apiKey,
                chat_completion_source: 'openai'
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const rawData = await response.json();
        const models = Array.isArray(rawData) ? rawData : (rawData.data || rawData.models || []);

        if (!Array.isArray(models)) {
            const errorMessage = rawData.error?.message || 'API未返回有效的模型列表数组';
            throw new Error(errorMessage);
        }

        const formattedModels = models
            .map(m => {
                const modelIdRaw = m.name || m.id || m.model || m;
                const modelName = String(modelIdRaw).replace(/^models\//, '');
                return {
                    id: modelName,
                    name: modelName
                };
            })
            .filter(m => m.id)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        console.log('[Amily2号-Concurrent外交部] 全兼容模式获取到模型:', formattedModels);
        return formattedModels;
        
    } catch (error) {
        console.error('[Amily2号-Concurrent外交部] 获取模型列表失败:', error);
        toastr.error(`获取模型列表失败: ${error.message}`, 'Concurrent API');
        throw error;
    }
}
