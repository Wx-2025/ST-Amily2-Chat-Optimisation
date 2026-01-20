import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { extensionName } from "../../utils/settings.js";
import { amilyHelper } from '../../core/tavern-helper/main.js';

let ChatCompletionService = undefined;
try {
    const module = await import('/scripts/custom-request.js');
    ChatCompletionService = module.ChatCompletionService;
    console.log('[Amily2号-Nccs外交部] 已成功召唤"皇家信使"(ChatCompletionService)。');
} catch (e) {
    console.warn("[Amily2号-Nccs外交部] 未能召唤“皇家信使”，部分高级功能（如Claw代理）将受限。请考虑更新SillyTavern版本。", e);
}

let nccsCtx = null;
// 尝试连接总线
if (window.Amily2Bus) {
    try {
        // 注册 'NccsApi' 身份，获取专属上下文
        nccsCtx = window.Amily2Bus.register('NccsApi');

        // 【联动】暴露 Nccs 的核心调用能力，允许其他插件通过 query('NccsApi') 借用此通道
        nccsCtx.expose({
            call: callNccsAI,
            getSettings: getNccsApiSettings
        });

        nccsCtx.log('Init', 'info', 'NccsApi 已连接至 Amily2Bus，网络通道准备就绪。');
    } catch (e) {
        // 如果是热重载导致重复注册，尝试降级获取（注意：严格锁模式下无法获取旧Context，这里仅做日志提示）
        // 在生产环境中，页面刷新会重置 Bus，不会有问题。
        console.warn('[Amily2-Nccs] Bus 注册警告 (可能是热重载):', e);
    }
} else {
    console.error('[Amily2-Nccs] 严重警告: Amily2Bus 未找到，NccsApi 网络层将无法工作！');
    toastr.error("核心组件 Amily2Bus 丢失，请检查安装。", "Nccs-System");
}

export function getNccsApiSettings() {
    return {
        nccsEnabled: extension_settings[extensionName]?.nccsEnabled || false,
        apiMode: extension_settings[extensionName]?.nccsApiMode || 'openai_test',
        apiUrl: extension_settings[extensionName]?.nccsApiUrl?.trim() || '',
        apiKey: extension_settings[extensionName]?.nccsApiKey?.trim() || '',
        model: extension_settings[extensionName]?.nccsModel || '',
        maxTokens: extension_settings[extensionName]?.nccsMaxTokens || 4000,
        temperature: extension_settings[extensionName]?.nccsTemperature || 0.7,
        tavernProfile: extension_settings[extensionName]?.nccsTavernProfile || '',
        useFakeStream: extension_settings[extensionName]?.nccsFakeStreamEnabled || false
    };
}

// =================================================================================================
// 核心调用入口 (Legacy First Mode)
// =================================================================================================

export async function callNccsAI(messages, options = {}) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-Nccs制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }

    const settings = getNccsApiSettings();
    const finalOptions = {
        ...settings,
        ...options
    };

    // 确保 stream 标志位存在
    finalOptions.stream = finalOptions.useFakeStream ?? false;

    if (finalOptions.apiMode !== 'sillytavern_preset') {
        if (!finalOptions.apiUrl || !finalOptions.model || !finalOptions.apiKey) {
            console.warn("[Amily2-Nccs外交部] API配置不完整，无法调用AI");
            toastr.error("API配置不完整，请检查URL、Key和模型配置。", "Nccs-外交部");
            return null;
        }
    } else {
        // [限制] 预设模式暂不支持流式
        if (finalOptions.stream) {
            console.warn("[Amily2-Nccs] 预设模式目前尚不支持流式处理方案，已自动切换为标准模式。");
            toastr.warning("SillyTavern预设模式目前暂不支持流式处理（假流式），已为您切换为标准请求模式。该功能将在后续版本中支持。", "Nccs-外交部");
            finalOptions.stream = false;
        }
    }

    try {
        let responseContent;
        switch (finalOptions.apiMode) {
            case 'openai_test':
                responseContent = await callNccsOpenAITest(messages, finalOptions);
                break;
            case 'sillytavern_preset':
                responseContent = await callNccsSillyTavernPreset(messages, finalOptions);
                break;
            default:
                console.error(`未支持的 API 模式: ${finalOptions.apiMode}`);
                return null;
        }
        return responseContent;
    } catch (error) {
        console.error(`[Amily2-Nccs] API 调用失败:`, error);
        toastr.error(`调用失败: ${error.message}`, "Nccs API Error");
        return null;
    }
}

async function fetchFakeStream(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`Stream HTTP ${res.status}: ${await res.text()}`);
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (trimmed.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(trimmed.substring(6));
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) fullContent += delta;
                    } catch (e) {
                        console.warn('[NccsApi] SSE Parse Error:', e);
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    
    if (!fullContent && buffer) {
        try { 
            const data = JSON.parse(buffer);
            return data.choices?.[0]?.message?.content || data.content || buffer; 
        } catch { return buffer; }
    }
    return fullContent;
}

// =================================================================================================
// Legacy Implementations
// =================================================================================================

function normalizeApiResponse(responseData) {
    let data = responseData;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return data; }
    }
    if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
    if (data?.content) return data.content.trim();
    return typeof data === 'object' ? JSON.stringify(data) : data;
}

async function callNccsOpenAITest(messages, options) {
    const isGoogleApi = options.apiUrl.includes('googleapis.com');
    const body = {
        chat_completion_source: 'openai',
        messages: messages,
        model: options.model,
        reverse_proxy: options.apiUrl,
        proxy_password: options.apiKey,
        stream: !!options.stream,
        max_tokens: options.maxTokens || 4000,
        temperature: options.temperature || 1,
        top_p: options.top_p || 1,
    };

    if (!isGoogleApi) {
        Object.assign(body, {
            custom_prompt_post_processing: 'strict',
            presence_penalty: 0.12,
        });
    }

    const fetchOpts = {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };

    if (options.stream) {
        return await fetchFakeStream('/api/backends/chat-completions/generate', fetchOpts);
    }

    const response = await fetch('/api/backends/chat-completions/generate', fetchOpts);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return normalizeApiResponse(await response.json());
}

async function callNccsSillyTavernPreset(messages, options) {
    const context = getContext();
    if (!context) throw new Error('SillyTavern context unavailable');

    const profileId = options.tavernProfile;
    if (!profileId) throw new Error('No profile ID configured');

    const originalProfile = await amilyHelper.triggerSlash('/profile');
    const targetProfile = context.extensionSettings?.connectionManager?.profiles?.find(p => p.id === profileId);

    if (!targetProfile) throw new Error(`Profile ${profileId} not found`);

    try {
        if (originalProfile !== targetProfile.name) {
            await amilyHelper.triggerSlash(`/profile await=true "${targetProfile.name.replace(/"/g, '\\"')}"`);
        }

        if (!context.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService unavailable');

        const result = await context.ConnectionManagerRequestService.sendRequest(
            targetProfile.id,
            messages,
            options.maxTokens || 4000
        );

        return normalizeApiResponse(result);

    } finally {
        // Restore profile
        const current = await amilyHelper.triggerSlash('/profile');
        if (originalProfile && originalProfile !== current) {
            await amilyHelper.triggerSlash(`/profile await=true "${originalProfile.replace(/"/g, '\\"')}"`);
        }
    }
}
export async function fetchNccsModels() {
    console.log('[Amily2号-Nccs外交部] 开始获取模型列表');

    const apiSettings = getNccsApiSettings();

    try {
        if (apiSettings.apiMode === 'sillytavern_preset') {
            // SillyTavern预设模式：获取当前预设的模型
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

            console.log('[Amily2号-Nccs外交部] SillyTavern预设模式获取到模型:', models);
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
                const errorMessage = rawData.error?.message || 'API未返回有效的模型列表数组';
                throw new Error(errorMessage);
            }

            const formattedModels = models
                .map(m => {
                    // 从name字段中提取模型名称，去掉"models/"前缀
                    const modelIdRaw = m.name || m.id || m.model || m;
                    const modelName = String(modelIdRaw).replace(/^models\//, '');
                    return {
                        id: modelName,
                        name: modelName
                    };
                })
                .filter(m => m.id)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));

            console.log('[Amily2号-Nccs外交部] 全兼容模式获取到模型:', formattedModels);
            return formattedModels;
        }
    } catch (error) {
        console.error('[Amily2号-Nccs外交部] 获取模型列表失败:', error);
        toastr.error(`获取模型列表失败: ${error.message}`, 'Nccs API');
        throw error;
    }
}

export async function testNccsApiConnection() {
    console.log('[Amily2号-Nccs外交部] 开始API连接测试');

    const apiSettings = getNccsApiSettings();

    if (apiSettings.apiMode === 'sillytavern_preset') {
        if (!apiSettings.tavernProfile) {
            toastr.error('未配置SillyTavern预设ID', 'Nccs API连接测试失败');
            return false;
        }
    } else {
        if (!apiSettings.apiUrl || !apiSettings.apiKey || !apiSettings.model) {
            toastr.error('API配置不完整，请检查URL、Key和模型', 'Nccs API连接测试失败');
            return false;
        }
    }

    try {
        toastr.info('正在发送测试消息"你好！"...', 'Nccs API连接测试');

        const userName = window.SillyTavern.getContext?.()?.name1 || '用户';
        const systemPrompt = `接下来用户会使用测试按钮测试api连接是否正常，请回复ta连接是正常的，称呼用户为：“${userName}大人”，并复述群号1060183271，告知ta，本扩展开发者：“诗与酒.”正静待ta的入驻。`;

        const testMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '你好！' }
        ];

        const response = await callNccsAI(testMessages);

        if (response && response.trim()) {
            console.log('[Amily2号-Nccs外交部] 测试消息响应:', response);
            const formattedResponse = response.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            toastr.success(`连接测试成功！AI回复: "${formattedResponse}"`, 'Nccs API连接测试成功', { "escapeHtml": false });
            return true;
        } else {
            throw new Error('API未返回有效响应');
        }

    } catch (error) {
        console.error('[Amily2号-Nccs外交部] 连接测试失败:', error);
        toastr.error(`连接测试失败: ${error.message}`, 'Nccs API连接测试失败');
        return false;
    }
}

