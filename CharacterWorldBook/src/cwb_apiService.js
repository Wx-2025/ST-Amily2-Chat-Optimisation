import { state } from './cwb_state.js';
import { logError, showToastr, escapeHtml } from './cwb_utils.js';
import { getRequestHeaders } from '/script.js';
import { extensionName } from '../../utils/settings.js';
import { extension_settings, getContext } from "/scripts/extensions.js";

function normalizeApiResponse(responseData) {
    let data = responseData;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (e) {
            console.error(`[${extensionName}] API响应JSON解析失败:`, e);
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


function getCwbApiSettings() {
    return {
        apiMode: extension_settings[extensionName]?.cwb_api_mode || 'openai_test',
        apiUrl: extension_settings[extensionName]?.cwb_api_url?.trim() || '',
        apiKey: extension_settings[extensionName]?.cwb_api_key?.trim() || '',
        model: extension_settings[extensionName]?.cwb_api_model || '',
        tavernProfile: extension_settings[extensionName]?.cwb_tavern_profile || ''
    };
}

async function callCwbSillyTavernPreset(messages, options) {
    console.log('[CWB-ST预设] 使用SillyTavern预设调用');

    if (!window.TavernHelper || !window.TavernHelper.triggerSlash) {
        throw new Error('TavernHelper不可用，无法使用SillyTavern预设模式');
    }

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
        originalProfile = await window.TavernHelper.triggerSlash('/profile');
        console.log(`[CWB-ST预设] 当前配置文件: ${originalProfile}`);

        const targetProfile = context.extensionSettings?.connectionManager?.profiles?.find(p => p.id === profileId);
        if (!targetProfile) {
            throw new Error(`未找到配置文件ID: ${profileId}`);
        }

        const targetProfileName = targetProfile.name;
        console.log(`[CWB-ST预设] 目标配置文件: ${targetProfileName}`);

        const currentProfile = await window.TavernHelper.triggerSlash('/profile');
        if (currentProfile !== targetProfileName) {
            console.log(`[CWB-ST预设] 切换配置文件: ${currentProfile} -> ${targetProfileName}`);
            const escapedProfileName = targetProfileName.replace(/"/g, '\\"');
            await window.TavernHelper.triggerSlash(`/profile await=true "${escapedProfileName}"`);
        }

        if (!context.ConnectionManagerRequestService) {
            throw new Error('ConnectionManagerRequestService不可用');
        }

        console.log(`[CWB-ST预设] 通过配置文件 ${targetProfileName} 发送请求`);
        responsePromise = context.ConnectionManagerRequestService.sendRequest(
            targetProfile.id,
            messages,
            options.maxTokens || 100000
        );

    } finally {
        try {
            const currentProfileAfterCall = await window.TavernHelper.triggerSlash('/profile');
            if (originalProfile && originalProfile !== currentProfileAfterCall) {
                console.log(`[CWB-ST预设] 恢复原始配置文件: ${currentProfileAfterCall} -> ${originalProfile}`);
                const escapedOriginalProfile = originalProfile.replace(/"/g, '\\"');
                await window.TavernHelper.triggerSlash(`/profile await=true "${escapedOriginalProfile}"`);
            }
        } catch (restoreError) {
            console.error('[CWB-ST预设] 恢复配置文件失败:', restoreError);
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

async function callCwbOpenAITest(messages, options) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_completion_source: 'openai',
            custom_prompt_post_processing: 'strict',
            enable_web_search: false,
            frequency_penalty: 0,
            group_names: [],
            include_reasoning: false,
            max_tokens: options.maxTokens || 100000,
            messages: messages,
            model: options.model,
            presence_penalty: 0.12,
            proxy_password: options.apiKey,
            reasoning_effort: 'medium',
            request_images: false,
            reverse_proxy: options.apiUrl,
            stream: false,
            temperature: options.temperature || 1,
            top_p: options.top_p || 1
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`CWB全兼容API请求失败: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();
    return responseData?.choices?.[0]?.message?.content;
}

export async function callCwbAPI(systemPrompt, userPromptContent, options = {}) {
    const apiSettings = getCwbApiSettings();
    
    const finalOptions = {
        maxTokens: 100000,
        temperature: 1,
        model: apiSettings.model,
        apiUrl: apiSettings.apiUrl,
        apiKey: apiSettings.apiKey,
        apiMode: apiSettings.apiMode,
        tavernProfile: apiSettings.tavernProfile,
        ...options
    };

    if (finalOptions.apiMode !== 'sillytavern_preset') {
        if (!finalOptions.apiUrl || !finalOptions.model || !finalOptions.apiKey) {
            throw new Error('API配置不完整，请检查URL、Key和模型配置');
        }
    } else {
        if (!finalOptions.tavernProfile) {
            throw new Error('未配置SillyTavern预设ID');
        }
    }

    const combinedSystemPrompt = `${state.currentBreakArmorPrompt}\n\n${systemPrompt}`;

    const messages = [
        { role: 'system', content: combinedSystemPrompt },
        { role: 'user', content: userPromptContent },
    ];

    console.groupCollapsed(`[CWB] 统一API调用 @ ${new Date().toLocaleTimeString()}`);
    console.log("【请求参数】:", { 
        mode: finalOptions.apiMode,
        model: finalOptions.model, 
        maxTokens: finalOptions.maxTokens, 
        temperature: finalOptions.temperature,
        messagesCount: messages.length
    });
    console.log("【消息内容】:", messages);

    try {
        let responseContent;

        switch (finalOptions.apiMode) {
            case 'openai_test':
                responseContent = await callCwbOpenAITest(messages, finalOptions);
                break;
            case 'sillytavern_preset':
                responseContent = await callCwbSillyTavernPreset(messages, finalOptions);
                break;
            default:
                throw new Error(`未支持的API模式: ${finalOptions.apiMode}`);
        }

        if (!responseContent) {
            throw new Error('未能获取AI响应内容');
        }

        console.log("【AI回复】:", responseContent);
        console.groupEnd();

        return responseContent.trim();

    } catch (error) {
        console.error(`[CWB] API调用发生错误:`, error);
        console.groupEnd();
        throw error;
    }
}

export async function loadModels($panel) {
    const apiSettings = getCwbApiSettings();
    const $modelSelect = $panel.find('#cwb-api-model');
    const $apiStatus = $panel.find('#cwb-api-status');

    $apiStatus.text('状态: 正在加载模型列表...').css('color', '#61afef');
    showToastr('info', '正在加载模型列表...');

    try {
        let models = [];

        if (apiSettings.apiMode === 'sillytavern_preset') {
            const context = getContext();
            if (!context?.extensionSettings?.connectionManager?.profiles) {
                throw new Error('无法获取SillyTavern配置文件列表');
            }
            
            const targetProfile = context.extensionSettings.connectionManager.profiles.find(p => p.id === apiSettings.tavernProfile);
            if (!targetProfile) {
                throw new Error(`未找到配置文件ID: ${apiSettings.tavernProfile}`);
            }
            
            if (targetProfile.openai_model) {
                models.push({ id: targetProfile.openai_model, name: targetProfile.openai_model });
            }
            
            if (models.length === 0) {
                throw new Error('当前预设未配置模型');
            }
            
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
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const rawData = await response.json();
            const result = normalizeApiResponse(rawData);
            const modelList = result.data || [];

            if (result.error || !Array.isArray(modelList)) {
                const errorMessage = result.error?.message || 'API未返回有效的模型列表数组';
                throw new Error(errorMessage);
            }

            models = modelList
                .map(m => ({
                    id: m.id || m.model || m,
                    name: m.id || m.model || m
                }))
                .filter(m => m.id)
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        $modelSelect.empty();
        if (models.length > 0) {
            models.forEach(model => {
                $modelSelect.append(jQuery('<option>', { value: model.id, text: model.name }));
            });
            showToastr('success', `成功加载 ${models.length} 个模型！`);
        } else {
            showToastr('warning', 'API未返回任何可用模型。');
        }

    } catch (error) {
        logError('加载模型列表时出错:', error);
        showToastr('error', `加载模型列表失败: ${error.message}`);
    } finally {
        updateApiStatusDisplay($panel);
    }
}

export async function fetchModelsAndConnect($panel) {
    const apiSettings = getCwbApiSettings();
    const $modelSelect = $panel.find('#cwb-api-model');
    const $apiStatus = $panel.find('#cwb-api-status');

    if (apiSettings.apiMode === 'sillytavern_preset') {
        if (!apiSettings.tavernProfile) {
            showToastr('warning', '请先选择SillyTavern预设。');
            $apiStatus.text('状态: 请先选择SillyTavern预设').css('color', 'orange');
            return;
        }

        $apiStatus.text('状态: 正在从预设获取模型...').css('color', '#61afef');
        showToastr('info', '正在从预设获取模型...');

        try {
            const context = getContext();
            if (!context?.extensionSettings?.connectionManager?.profiles) {
                throw new Error('无法获取SillyTavern配置文件列表');
            }
            
            const targetProfile = context.extensionSettings.connectionManager.profiles.find(p => p.id === apiSettings.tavernProfile);
            if (!targetProfile) {
                throw new Error(`未找到配置文件ID: ${apiSettings.tavernProfile}`);
            }
            
            $modelSelect.empty();
            if (targetProfile.openai_model) {
                $modelSelect.append(jQuery('<option>', { value: targetProfile.openai_model, text: targetProfile.openai_model }));
                showToastr('success', `从预设获取模型: ${targetProfile.openai_model}`);
            } else {
                throw new Error('当前预设未配置模型');
            }
            
        } catch (error) {
            logError('从预设获取模型时出错:', error);
            showToastr('error', `从预设获取模型失败: ${error.message}`);
        } finally {
            updateApiStatusDisplay($panel);
        }
    } else {
        const apiUrl = $panel.find('#cwb-api-url').val().trim();
        const apiKey = $panel.find('#cwb-api-key').val();

        if (!apiUrl) {
            showToastr('warning', '请输入API基础URL。');
            $apiStatus.text('状态:请输入API基础URL').css('color', 'orange');
            return;
        }

        $apiStatus.text('状态: 正在加载模型列表...').css('color', '#61afef');
        showToastr('info', '正在加载模型列表...');

        try {
            const response = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reverse_proxy: apiUrl,
                    proxy_password: apiKey,
                    chat_completion_source: 'openai'
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const rawData = await response.json();
            const result = normalizeApiResponse(rawData);
            const models = result.data || [];

            if (result.error || !Array.isArray(models)) {
                const errorMessage = result.error?.message || 'API未返回有效的模型列表数组';
                throw new Error(errorMessage);
            }
            
            const modelIds = models
                .map(m => m.id || m.model)
                .filter(Boolean)
                .sort();

            $modelSelect.empty();
            if (modelIds.length > 0) {
                modelIds.forEach(modelId => {
                    $modelSelect.append(jQuery('<option>', { value: modelId, text: modelId }));
                });
                showToastr('success', `成功加载 ${modelIds.length} 个模型！`);
            } else {
                showToastr('warning', 'API未返回任何可用模型。');
            }

        } catch (error) {
            logError('加载模型列表时出错:', error);
            showToastr('error', `加载模型列表失败: ${error.message}`);
        } finally {
            updateApiStatusDisplay($panel);
        }
    }
}


export function updateApiStatusDisplay($panel) {
    if (!$panel) return;
    const $apiStatus = $panel.find('#cwb-api-status');
    const apiSettings = getCwbApiSettings();
    
    if (apiSettings.apiMode === 'sillytavern_preset') {
        if (apiSettings.tavernProfile) {
            $apiStatus.html(
                `模式: <span style="color:lightgreen;">SillyTavern预设</span><br>预设ID: <span style="color:lightgreen;">${escapeHtml(apiSettings.tavernProfile)}</span>`
            );
        } else {
            $apiStatus.html(
                `模式: SillyTavern预设 - <span style="color:orange;">请选择预设</span>`
            );
        }
    } else {
        if (apiSettings.apiUrl && apiSettings.model) {
            $apiStatus.html(
                `模式: <span style="color:lightgreen;">全兼容</span><br>URL: <span style="color:lightgreen;word-break:break-all;">${escapeHtml(apiSettings.apiUrl)}</span><br>模型: <span style="color:lightgreen;">${escapeHtml(apiSettings.model)}</span>`
            );
        } else if (apiSettings.apiUrl) {
            $apiStatus.html(
                `模式: 全兼容<br>URL: ${escapeHtml(apiSettings.apiUrl)} - <span style="color:orange;">请加载并选择模型</span>`
            );
        } else {
            $apiStatus.html(
                `模式: 全兼容 - <span style="color:#ffcc80;">请配置API URL</span>`
            );
        }
    }
}

export async function callCustomOpenAI(systemPrompt, userPromptContent) {
    const apiSettings = getCwbApiSettings();

    if (apiSettings.apiMode === 'sillytavern_preset') {
        const combinedSystemPrompt = `${state.currentBreakArmorPrompt}\n\n${systemPrompt}`;
        const messages = [
            { role: 'system', content: combinedSystemPrompt },
            { role: 'user', content: userPromptContent },
        ];
        return await callCwbSillyTavernPreset(messages, { tavernProfile: apiSettings.tavernProfile, maxTokens: 100000 });
    } else {
        if (!state.customApiConfig.url || !state.customApiConfig.model) {
            throw new Error('API URL/Model未配置。');
        }

        const combinedSystemPrompt = `${state.currentBreakArmorPrompt}\n\n${systemPrompt}`;

        const requestBody = {
            messages: [
                { role: 'system', content: combinedSystemPrompt },
                { role: 'user', content: userPromptContent },
            ],
            model: state.customApiConfig.model,
            temperature: 1,
            frequency_penalty: 0,
            presence_penalty: 0.12,
            top_p: 1,
            max_tokens: 100000,
            stream: false,
            chat_completion_source: 'openai',
            group_names: [],
            include_reasoning: false,
            reasoning_effort: 'medium',
            enable_web_search: false,
            request_images: false,
            custom_prompt_post_processing: 'strict',
            reverse_proxy: state.customApiConfig.url,
            proxy_password: state.customApiConfig.apiKey,
        };

        const fullApiUrl = '/api/backends/chat-completions/generate';
        const headers = { ...getRequestHeaders(), 'Content-Type': 'application/json' };
        const body = JSON.stringify(requestBody);

        console.groupCollapsed(`[CWB] API Call @ ${new Date().toLocaleTimeString()}`);
        console.log('Request URL:', fullApiUrl);
        console.log('Request Headers:', headers);
        console.log('Request Body:', requestBody);

        try {
            const response = await fetch(fullApiUrl, {
                method: 'POST',
                headers: headers,
                body: body,
            });

            if (!response.ok) {
                const errTxt = await response.text();
                console.error('API Error Response:', errTxt);
                throw new Error(`API请求失败: ${response.status} ${errTxt}`);
            }
            const data = await response.json();
            console.log('API Full Response:', data);
            
            if (data.choices && data.choices[0]?.message?.content) {
                console.log('Extracted Content:', data.choices[0].message.content.trim());
                console.groupEnd();
                return data.choices[0].message.content.trim();
            }
            
            throw new Error('API响应格式不正确。');

        } catch (error) {
            console.error('API Call Failed:', error);
            throw error;
        } finally {
            if (console.groupEnd) { 
                 console.groupEnd();
            }
        }
    }
}
export class CWBApiService {
    static async callAPI(systemPrompt, userPromptContent, options = {}) {
        return await callCwbAPI(systemPrompt, userPromptContent, options);
    }

    static getSettings() {
        return getCwbApiSettings();
    }

    static async loadModels($panel) {
        return await loadModels($panel);
    }
}
