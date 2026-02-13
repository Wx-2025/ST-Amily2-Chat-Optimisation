import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { extensionName } from "../../utils/settings.js";
import { amilyHelper } from '../../core/tavern-helper/main.js';

let ChatCompletionService = undefined;
try {
    const module = await import('/scripts/custom-request.js');
    ChatCompletionService = module.ChatCompletionService;
    console.log('[Amily2号-Jqyh外交部] 已成功召唤"皇家信使"(ChatCompletionService)。');
} catch (e) {
    console.warn("[Amily2号-Jqyh外交部] 未能召唤“皇家信使”，部分高级功能（如Claw代理）将受限。请考虑更新SillyTavern版本。", e);
}

function normalizeApiResponse(responseData) {
    let data = responseData;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (e) {
            console.error(`[${extensionName}] Jqyh API响应JSON解析失败:`, e);
            return { error: { message: 'Invalid JSON response' } };
        }
    }
    if (data && typeof data.data === 'object' && data.data !== null && !Array.isArray(data.data)) {
        if (Object.hasOwn(data.data, 'data')) {
            data = data.data;
        }
    }
    if (data && data.choices && data.choices[0]) {
        return { content: data.choices[0].message?.content?.trim() };
    }
    if (data && data.content) {
        return { content: data.content.trim() };
    }
    if (data && data.data) { 
        return { data: data.data };
    }
    if (data && data.error) {
        return { error: data.error };
    }
    return data;
}

export function getJqyhApiSettings() {
    return {
        apiMode: extension_settings[extensionName]?.jqyhApiMode || 'openai_test',
        apiUrl: extension_settings[extensionName]?.jqyhApiUrl?.trim() || '',
        apiKey: extension_settings[extensionName]?.jqyhApiKey?.trim() || '',
        model: extension_settings[extensionName]?.jqyhModel || '',
        maxTokens: extension_settings[extensionName]?.jqyhMaxTokens || 4000,
        temperature: extension_settings[extensionName]?.jqyhTemperature || 0.7,
        tavernProfile: extension_settings[extensionName]?.jqyhTavernProfile || ''
    };
}

export async function callJqyhAI(messages, options = {}) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-Jqyh制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }

    const apiSettings = getJqyhApiSettings();

    const finalOptions = {
        maxTokens: apiSettings.maxTokens,
        temperature: apiSettings.temperature,
        model: apiSettings.model,
        apiUrl: apiSettings.apiUrl,
        apiKey: apiSettings.apiKey,
        apiMode: apiSettings.apiMode,
        tavernProfile: apiSettings.tavernProfile,
        ...options
    };

    if (finalOptions.apiMode !== 'sillytavern_preset') {
        if (!finalOptions.apiUrl || !finalOptions.model || !finalOptions.apiKey) {
            console.warn("[Amily2-Jqyh外交部] API配置不完整，无法调用AI");
            toastr.error("API配置不完整，请检查URL、Key和模型配置。", "Jqyh-外交部");
            return null;
        }
    }

    console.groupCollapsed(`[Amily2号-Jqyh统一API调用] ${new Date().toLocaleTimeString()}`);
    console.log("【请求参数】:", { 
        mode: finalOptions.apiMode,
        model: finalOptions.model, 
        maxTokens: finalOptions.maxTokens, 
        temperature: finalOptions.temperature,
        messagesCount: messages.length
    });
    console.log("【消息内容】:", messages);
    console.groupEnd();

    try {
        let responseContent;

        switch (finalOptions.apiMode) {
            case 'openai_test':
                responseContent = await callJqyhOpenAITest(messages, finalOptions);
                break;
            case 'sillytavern_preset':
                responseContent = await callJqyhSillyTavernPreset(messages, finalOptions);
                break;
            default:
                console.error(`[Amily2-Jqyh外交部] 未支持的API模式: ${finalOptions.apiMode}`);
                return null;
        }

        if (!responseContent) {
            console.warn('[Amily2-Jqyh外交部] 未能获取AI响应内容');
            return null;
        }

        console.groupCollapsed("[Amily2号-Jqyh AI回复]");
        console.log(responseContent);
        console.groupEnd();

        return responseContent;

    } catch (error) {
        console.error(`[Amily2-Jqyh外交部] API调用发生错误:`, error);

        if (error.message.includes('400')) {
            toastr.error(`API请求格式错误 (400): 请检查消息格式和模型配置`, "Jqyh API调用失败");
        } else if (error.message.includes('401')) {
            toastr.error(`API认证失败 (401): 请检查API Key配置`, "Jqyh API调用失败");
        } else if (error.message.includes('403')) {
            toastr.error(`API访问被拒绝 (403): 请检查权限设置`, "Jqyh API调用失败");
        } else if (error.message.includes('429')) {
            toastr.error(`API调用频率超限 (429): 请稍后重试`, "Jqyh API调用失败");
        } else if (error.message.includes('500')) {
            toastr.error(`API服务器错误 (500): 请稍后重试`, "Jqyh API调用失败");
        } else {
            toastr.error(`API调用失败: ${error.message}`, "Jqyh API调用失败");
        }
        
        return null;
    }
}

async function callJqyhOpenAITest(messages, options) {
    const isGoogleApi = options.apiUrl.includes('googleapis.com');

    const body = {
        chat_completion_source: 'openai',
        messages: messages,
        model: options.model,
        reverse_proxy: options.apiUrl,
        proxy_password: options.apiKey,
        stream: false,
        max_tokens: options.maxTokens || 30000,
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
        throw new Error(`Jqyh全兼容API请求失败: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();
    return responseData?.choices?.[0]?.message?.content;
}

async function callJqyhSillyTavernPreset(messages, options) {
    console.log('[Amily2号-JqyhST预设] 使用SillyTavern预设调用');

    const context = getContext();
    if (!context) {
        throw new Error('无法获取SillyTavern上下文');
    }

    const profileId = options.tavernProfile;
    if (!profileId) {
        throw new Error('未配置SillyTavern预设ID');
    }

    let originalProfile = '';
    let responsePromise;

    try {
        originalProfile = await amilyHelper.triggerSlash('/profile');
        console.log(`[Amily2号-JqyhST预设] 当前配置文件: ${originalProfile}`);

        const targetProfile = context.extensionSettings?.connectionManager?.profiles?.find(p => p.id === profileId);
        if (!targetProfile) {
            throw new Error(`未找到配置文件ID: ${profileId}`);
        }

        const targetProfileName = targetProfile.name;
        console.log(`[Amily2号-JqyhST预设] 目标配置文件: ${targetProfileName}`);

        const currentProfile = await amilyHelper.triggerSlash('/profile');
        if (currentProfile !== targetProfileName) {
            console.log(`[Amily2号-JqyhST预设] 切换配置文件: ${currentProfile} -> ${targetProfileName}`);
            const escapedProfileName = targetProfileName.replace(/"/g, '\\"');
            await amilyHelper.triggerSlash(`/profile await=true "${escapedProfileName}"`);
        }

        if (!context.ConnectionManagerRequestService) {
            throw new Error('ConnectionManagerRequestService不可用');
        }

        console.log(`[Amily2号-JqyhST预设] 通过配置文件 ${targetProfileName} 发送请求`);
        responsePromise = context.ConnectionManagerRequestService.sendRequest(
            targetProfile.id,
            messages,
            options.maxTokens || 4000
        );

    } finally {
        try {
            const currentProfileAfterCall = await amilyHelper.triggerSlash('/profile');
            if (originalProfile && originalProfile !== currentProfileAfterCall) {
                console.log(`[Amily2号-JqyhST预设] 恢复原始配置文件: ${currentProfileAfterCall} -> ${originalProfile}`);
                const escapedOriginalProfile = originalProfile.replace(/"/g, '\\"');
                await amilyHelper.triggerSlash(`/profile await=true "${escapedOriginalProfile}"`);
            }
        } catch (restoreError) {
            console.error('[Amily2号-JqyhST预设] 恢复配置文件失败:', restoreError);
        }
    }

    const result = await responsePromise;

    if (!result) {
        throw new Error('未收到API响应');
    }

    const normalizedResult = normalizeApiResponse(result);
    if (normalizedResult.error) {
        throw new Error(normalizedResult.error.message || 'SillyTavern预设API调用失败');
    }

    return normalizedResult.content;
}

export async function fetchJqyhModels() {
    console.log('[Amily2号-Jqyh外交部] 开始获取模型列表');
    
    const apiSettings = getJqyhApiSettings();
    
    try {
        if (apiSettings.apiMode === 'sillytavern_preset') {
            const context = getContext();
            if (!context?.extensionSettings?.connectionManager?.profiles) {
                throw new Error('无法获取SillyTavern配置文件列表');
            }
            
            const targetProfile = context.extensionSettings.connectionManager.profiles.find(p => p.id === apiSettings.tavernProfile);
            if (!targetProfile) {
                throw new Error(`未找到配置文件ID: ${apiSettings.tavernProfile}`);
            }
            
            const models = [];
            if (targetProfile.openai_model) {
                models.push({ id: targetProfile.openai_model, name: targetProfile.openai_model });
            }
            
            if (models.length === 0) {
                throw new Error('当前预设未配置模型');
            }
            
            console.log('[Amily2号-Jqyh外交部] SillyTavern预设模式获取到模型:', models);
            return models;
            
        } else {
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
                const errorMessage = result.error?.message || 'API未返回有效的模型列表数组';
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

            console.log('[Amily2号-Jqyh外交部] 全兼容模式获取到模型:', formattedModels);
            return formattedModels;
        }
    } catch (error) {
        console.error('[Amily2号-Jqyh外交部] 获取模型列表失败:', error);
        toastr.error(`获取模型列表失败: ${error.message}`, 'Jqyh API');
        throw error;
    }
}

export async function testJqyhApiConnection() {
    console.log('[Amily2号-Jqyh外交部] 开始API连接测试');
    
    const apiSettings = getJqyhApiSettings();

    if (apiSettings.apiMode === 'sillytavern_preset') {
        if (!apiSettings.tavernProfile) {
            toastr.error('未配置SillyTavern预设ID', 'Jqyh API连接测试失败');
            return false;
        }
    } else {
        if (!apiSettings.apiUrl || !apiSettings.apiKey || !apiSettings.model) {
            toastr.error('API配置不完整，请检查URL、Key和模型', 'Jqyh API连接测试失败');
            return false;
        }
    }

    try {
        toastr.info('正在发送测试消息"你好！"...', 'Jqyh API连接测试');
        
        const userName = window.SillyTavern.getContext?.()?.name1 || '用户';
        const systemPrompt = `接下来用户会使用测试按钮测试api连接是否正常，请回复ta连接是正常的，称呼用户为：“${userName}大人”，并复述群号1060183271，告知ta，本扩展开发者：“诗与酒.”正静待ta的入驻。`;

        const testMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '你好！' }
        ];
        
        const response = await callJqyhAI(testMessages);
        
        if (response && response.trim()) {
            console.log('[Amily2号-Jqyh外交部] 测试消息响应:', response);
            const formattedResponse = response.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            toastr.success(`连接测试成功！AI回复: "${formattedResponse}"`, 'Jqyh API连接测试成功', { "escapeHtml": false });
            return true;
        } else {
            throw new Error('API未返回有效响应');
        }
        
    } catch (error) {
        console.error('[Amily2号-Jqyh外交部] 连接测试失败:', error);
        toastr.error(`连接测试失败: ${error.message}`, 'Jqyh API连接测试失败');
        return false;
    }
}
