import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { world_names } from "/scripts/world-info.js";
import { extensionName } from "../utils/settings.js";
import { extractContentByTag, replaceContentByTag, extractFullTagBlock } from '../utils/tagProcessor.js';
import {
  getCombinedWorldbookContent,
  findLatestSummaryLore,
  DEDICATED_LOREBOOK_NAME,
  getChatIdentifier,
} from "./lore.js";
import { compatibleTriggerSlash } from "./tavernhelper-compatibility.js";

import {
  isGoogleEndpoint,
  convertToGoogleRequest,
  parseGoogleResponse,
  buildGoogleApiUrl
} from '../core/utils/googleAdapter.js';
 
import {
  intelligentPoll,
  createGooglePollingTask,
  progressTracker
} from '../core/utils/pollingManager.js';

import {
  buildGoogleEmbeddingRequest,
  parseGoogleEmbeddingResponse,
  buildGoogleEmbeddingApiUrl
} from './utils/googleAdapter.js';

import { getRequestHeaders } from '/script.js';


let ChatCompletionService = undefined;
try {
    const module = await import('/scripts/custom-request.js');
    ChatCompletionService = module.ChatCompletionService;
    console.log('[Amily2号-外交部] 已成功召唤“皇家信使”(ChatCompletionService)。');
} catch (e) {
    console.warn("[Amily2号-外交部] 未能召唤“皇家信使”，部分高级功能（如Claw代理）将受限。请考虑更新SillyTavern版本。", e);
}
 
const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/Wx-2025/ST-Amily2-Chat-Optimisation/refs/heads/main/amily2_update_info.json";

const MESSAGE_BOARD_URL =
  "https://amilyservice.amily49.cc/amily2_message_board.json";
 
export async function fetchMessageBoardContent() {
    if (!MESSAGE_BOARD_URL) {
        console.log('[Amily2号-内务府] 任务取消：陛下尚未配置留言板URL。');
        return null;
    }
    try {
        const response = await fetch(MESSAGE_BOARD_URL, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`服务器响应异常: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('[Amily2号-内务府] 获取留言板内容失败:', error);
        return null;
    }
}
 
export async function checkForUpdates() {
    if (!UPDATE_CHECK_URL || UPDATE_CHECK_URL.includes('YourUsername')) {
        console.log('[Amily2号-外交部] 任务取消：陛下尚未配置情报来源URL。');
        return null;
    }
 
 
    try {
        console.log('[Amily2号-外交部] 已派遣使者前往云端获取最新情报...');
        const response = await fetch(UPDATE_CHECK_URL, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors'
        });
 
 
 
        if (!response.ok) {
            throw new Error(`远方服务器响应异常，状态: ${response.status}`);
        }
 
        const data = await response.json();
        console.log('[Amily2号-外交部] 情报已成功获取并解析。');
        return data;
 
    } catch (error) {
        console.error('[Amily2号-外交部] 紧急军情：外交任务失败！', error);
        return null;
    }
}
 
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


export async function fetchModels() {
    if (window.AMILY2_LOCK_MODEL_FETCHING) {
        console.warn("[Amily2号-使节团] 上次任务尚未完成，本次任务取消。");
        toastr.info("上次任务尚未完成，请稍后再试。", "任务排队中");
        return [];
    }

    window.AMILY2_LOCK_MODEL_FETCHING = true;

    try {
        const apiProvider = $("#amily2_api_provider").val() || 'openai';
        const apiUrl = $("#amily2_api_url").val().trim();
        const apiKey = $("#amily2_api_key").val().trim();
        const $button = $("#amily2_refresh_models");
        const $selector = $("#amily2_model");

        console.log(`[Amily2号-使节团] 使用 API 提供商: ${apiProvider}`);

        $button.prop("disabled", true).html('<i class="fas fa-spinner fa-spin"></i> 加载中');
        $selector.empty().append($('<option>', { value: '', text: '正在获取模型列表...' }));

        let result = [];

        switch (apiProvider) {
            case 'openai':
                result = await fetchOpenAICompatibleModels(apiUrl, apiKey);
                break;
            case 'openai_test':
                result = await fetchOpenAITestModels(apiUrl, apiKey);
                break;
            case 'google':
                result = await fetchGoogleDirectModels(apiUrl, apiKey);
                break;
            case 'sillytavern_backend':
                result = await fetchSillyTavernBackendModels(apiUrl, apiKey);
                break;
            case 'sillytavern_preset':
                result = await fetchSillyTavernPresetModels();
                break;
            default:
                throw new Error(`未支持的API提供商: ${apiProvider}`);
        }

        if (result.length > 0) {
            toastr.success(`成功获取 ${result.length} 个模型`, "任务成功");
            return result;
        } else {
            toastr.warning("未找到可用模型", "注意");
            return [];
        }

    } catch (error) {
        console.error("[Amily2号-使节团] 获取模型列表失败:", error);
        toastr.error(`获取模型列表失败: ${error.message}`, "任务失败");
        return [];
    } finally {
        window.AMILY2_LOCK_MODEL_FETCHING = false;
        const $button = $("#amily2_refresh_models");
        $button.prop("disabled", false).html('<i class="fas fa-sync-alt"></i> 刷新模型');
    }
}


async function fetchOpenAICompatibleModels(apiUrl, apiKey) {
    if (!apiUrl || !apiKey) {
        throw new Error("OpenAI兼容模式需要API URL和API Key");
    }

    const baseUrl = apiUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    const modelsUrl = `${baseUrl}/v1/models`;

    console.log(`[Amily2号-使节团] OpenAI兼容模式: ${modelsUrl}`);

    const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const models = data.data || data.models || [];
    
    return models
        .map(m => m.id || m.model)
        .filter(Boolean)
        .filter(m => !m.toLowerCase().includes('embed'))
        .sort();
}

async function fetchOpenAITestModels(apiUrl, apiKey) {
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
    const models = Array.isArray(rawData) ? rawData : (rawData.data || rawData.models || []);

    if (!Array.isArray(models)) {
        const errorMessage = 'API未返回有效的模型列表数组';
        throw new Error(errorMessage);
    }

    const formattedModels = models
        .map(m => {
            const modelName = m.name ? m.name.replace('models/', '') : (m.id || m.model || m);
            return {
                id: m.name || m.id || m.model || m,
                name: modelName
            };
        })
        .filter(m => m.id)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    console.log('[Amily2号-使节团] 全兼容(测试)模式获取到模型:', formattedModels);
    return formattedModels.map(m => m.name);
}


async function fetchGoogleDirectModels(apiUrl, apiKey) {
    if (!apiKey) {
        throw new Error("Google直连模式需要API Key");
    }

    const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com';
    
    const fetchGoogleModels = async (version) => {
        const url = `${GOOGLE_API_BASE_URL}/${version}/models?key=${apiKey}`;
        console.log(`[Amily2号-使节团] 正在从 Google API (${version}) 获取模型列表: ${url}`);
        
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`获取 Google API (${version}) 模型列表失败: ${response.status}`);
            return [];
        }
        
        const json = await response.json();
        if (!json.models || !Array.isArray(json.models)) {
            return [];
        }
        
        return json.models
            .filter(model => 
                model.supportedGenerationMethods?.includes('generateContent') ||
                model.supportedGenerationMethods?.includes('streamGenerateContent')
            )
            .map(model => model.name.replace('models/', ''));
    };

    const [v1Models, v1betaModels] = await Promise.all([
        fetchGoogleModels('v1'),
        fetchGoogleModels('v1beta')
    ]);

    const allModels = [...new Set([...v1Models, ...v1betaModels])].sort();
    return allModels;
}

async function fetchSillyTavernBackendModels(apiUrl, apiKey) {
    if (!apiUrl) {
        throw new Error("SillyTavern后端模式需要API URL");
    }

    console.log('[Amily2号-使节团] 通过SillyTavern后端获取模型列表');

    const rawResponse = await $.ajax({
        url: '/api/backends/chat-completions/status',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: apiUrl,
            api_key: apiKey
        })
    });

    const result = normalizeApiResponse(rawResponse);
    const models = result.data || [];

    if (result.error || !Array.isArray(models)) {
        const errorMessage = result.error?.message || 'API未返回有效的模型列表数组';
        throw new Error(errorMessage);
    }

    return models
        .map(model => model.id || model.model)
        .filter(Boolean)
        .sort();
}


async function fetchSillyTavernPresetModels() {
    console.log('[Amily2号-使节团] 使用SillyTavern预设模式');

    try {
        const context = getContext();
        if (!context) {
            throw new Error("无法获取SillyTavern上下文");
        }

        const currentModel = context.chat_completion_source;
        const models = [];

        if (currentModel) {
            models.push(currentModel);
        }

        const defaultModels = [
            'gpt-3.5-turbo',
            'gpt-4',
            'claude-3-sonnet',
            'claude-3-haiku',
            'gemini-pro'
        ];

        const allModels = [...new Set([...models, ...defaultModels])].sort();
        return allModels;

    } catch (error) {
        console.warn('[Amily2号-使节团] 获取SillyTavern预设失败，返回默认模型列表:', error);
        

        return [
            'gpt-3.5-turbo',
            'gpt-4',
            'claude-3-sonnet',
            'claude-3-haiku',
            'gemini-pro'
        ];
    }
}
 

export function getApiSettings() {
    const settings = extension_settings[extensionName] || {};
    const apiProvider = document.getElementById('amily2_api_provider')?.value || 'openai';
    
    let model;
    if (apiProvider === 'sillytavern_preset') {
        const context = getContext();
        const profileId = document.getElementById('amily2_preset_selector')?.value;
        const profile = context.extensionSettings?.connectionManager?.profiles?.find(p => p.id === profileId);
        model = profile?.openai_model || 'Preset Model';
    } else {
        model = document.getElementById('amily2_model')?.value;
    }

    return {
        apiProvider: apiProvider,
        apiUrl: document.getElementById('amily2_api_url')?.value.trim() || '',
        apiKey: document.getElementById('amily2_api_key')?.value.trim() || '',
        model: model,
        maxTokens: settings.maxTokens || 4000,
        temperature: settings.temperature || 0.7,
        tavernProfile: document.getElementById('amily2_preset_selector')?.value || ''
    };
}


export async function testApiConnection() {
    console.log('[Amily2号-外交部] 开始API连接测试');
    const $button = $("#amily2_test_api_connection");
    if (!$button.length) return;

    const originalHtml = $button.html();
    $button.prop("disabled", true).html('<i class="fas fa-spinner fa-spin"></i> 测试中');

    try {
        const apiSettings = getApiSettings();
        
        if (apiSettings.apiProvider === 'sillytavern_preset') {
            if (!apiSettings.tavernProfile) {
                throw new Error("请先在下方选择一个SillyTavern预设");
            }
        } else {
            if (!apiSettings.apiUrl || !apiSettings.apiKey || !apiSettings.model) {
                throw new Error("API配置不完整，请检查URL、Key和模型选择");
            }
        }

        toastr.info('正在发送测试消息"你好！"...', 'API连接测试');
        
        const userName = getContext()?.name1 || '用户';
        const systemPrompt = `接下来用户会使用测试按钮测试api连接是否正常，请回复ta连接是正常的，称呼用户为：“${userName}大人”，并复述群号1060183271，告知ta，本扩展开发者：“诗与酒.”正静待ta的入驻。`;

        const testMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '你好！' }
        ];
        
        const response = await callAI(testMessages, {
            maxTokens: 8192,
            temperature: 0.5
        });
        
        if (response && response.trim()) {
            console.log('[Amily2号-外交部] 测试消息响应:', response);
            toastr.success(`连接测试成功！AI回复: "${response}"`, 'API连接测试成功');
            return true;
        } else {
            throw new Error('API未返回有效响应，请检查您的代理、API URL和密钥是否正确。这通常发生在网络问题或认证失败时。');
        }
        
    } catch (error) {
        console.error('[Amily2号-使节团] API连接测试失败:', error);
        toastr.error(`连接测试失败: ${error.message}`, 'API连接测试失败');
        return false;
    } finally {
        $button.prop("disabled", false).html(originalHtml);
    }
}

export async function callAI(messages, options = {}) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }

    const apiSettings = getApiSettings();

    const finalOptions = {
        maxTokens: apiSettings.maxTokens,
        temperature: apiSettings.temperature,
        model: apiSettings.model,
        apiUrl: apiSettings.apiUrl,
        apiKey: apiSettings.apiKey,
        apiProvider: apiSettings.apiProvider,
        ...options
    };

    if (finalOptions.apiProvider !== 'sillytavern_preset') {
        if (!finalOptions.apiUrl || !finalOptions.model) {
            console.warn("[Amily2-外交部] API URL或模型未配置，无法调用AI");
            toastr.error("API URL或模型未配置，无法调用AI。", "Amily2-外交部");
            return null;
        }
    }

    console.groupCollapsed(`[Amily2号-统一API调用] ${new Date().toLocaleTimeString()}`);
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

        switch (finalOptions.apiProvider) {
            case 'openai':
                responseContent = await callOpenAICompatible(messages, finalOptions);
                break;
            case 'openai_test':
                responseContent = await callOpenAITest(messages, finalOptions);
                break;
            case 'google':
                responseContent = await callGoogleDirect(messages, finalOptions);
                break;
            case 'sillytavern_backend':
                responseContent = await callSillyTavernBackend(messages, finalOptions);
                break;
            case 'sillytavern_preset':
                responseContent = await callSillyTavernPreset(messages, finalOptions);
                break;
            default:
                console.error(`[Amily2-外交部] 未支持的API提供商: ${finalOptions.apiProvider}`);
                return null;
        }

        if (!responseContent) {
            console.warn('[Amily2-外交部] 未能获取AI响应内容，但不视为错误');
            return null;
        }

        console.groupCollapsed("[Amily2号-AI回复]");
        console.log(responseContent);
        console.groupEnd();

        return responseContent;

    } catch (error) {
        console.error(`[Amily2-外交部] API调用发生错误:`, error);

        if (error.message.includes('400')) {
            toastr.error(`API请求格式错误 (400): 请检查消息格式和模型配置`, "API调用失败");
        } else if (error.message.includes('401')) {
            toastr.error(`API认证失败 (401): 请检查API Key配置`, "API调用失败");
        } else if (error.message.includes('403')) {
            toastr.error(`API访问被拒绝 (403): 请检查权限设置`, "API调用失败");
        } else if (error.message.includes('429')) {
            toastr.error(`API调用频率超限 (429): 请稍后重试`, "API调用失败");
        } else if (error.message.includes('500')) {
            toastr.error(`API服务器错误 (500): 请稍后重试`, "API调用失败");
        } else {
            toastr.error(`API调用失败: ${error.message}`, "API调用失败");
        }
        
        return null;
    }
}


async function callOpenAICompatible(messages, options) {
    const baseUrl = options.apiUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    const apiUrl = `${baseUrl}/v1/chat/completions`;

    console.log(`[Amily2号-OpenAI兼容] API地址: ${apiUrl}`);

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: options.model,
            messages: messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
            stream: false
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI兼容API请求失败: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();
    return responseData?.choices?.[0]?.message?.content;
}

async function callOpenAITest(messages, options) {
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
        custom_prompt_post_processing: 'strict',
        enable_web_search: false,
        frequency_penalty: 0,
        group_names: [],
        include_reasoning: false,
        presence_penalty: 0.12,
        reasoning_effort: 'medium',
        request_images: false,
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI兼容(测试)API请求失败: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();
    
    if (!responseData || !responseData.choices || responseData.choices.length === 0) {
        console.error('[Amily2号-OpenAI兼容(测试)] API返回了空的choices数组或错误:', responseData);
        if (responseData.error) {
            throw new Error(`API返回错误: ${responseData.error.message || JSON.stringify(responseData.error)}`);
        }
        return null; 
    }
    
    return responseData?.choices?.[0]?.message?.content;
}


async function callGoogleDirect(messages, options) {
    const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com';

    const apiVersion = options.model.includes('gemini-1.5') ? 'v1beta' : 'v1';
    const finalApiUrl = `${GOOGLE_API_BASE_URL}/${apiVersion}/models/${options.model}:generateContent?key=${options.apiKey}`;
    
    console.log(`[Amily2号-Google直连] API地址: ${finalApiUrl}`);

    const headers = { 
        "Content-Type": "application/json"
    };

    const requestBody = JSON.stringify(convertToGoogleRequest({ 
        model: options.model, 
        messages, 
        max_tokens: options.maxTokens, 
        temperature: options.temperature 
    }));

    const response = await fetch(finalApiUrl, { 
        method: "POST", 
        headers: headers, 
        body: requestBody 
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google API请求失败: ${response.status} - ${errorText}`);
    }

    let responseData = await response.json();

    if (responseData.name && responseData.metadata) {
        console.log("[Amily2号-Google] 收到异步操作ID，启用轮询机制...");
        const operationId = responseData.name;
        const tracker = progressTracker(operationId, 6);
        tracker.start();
        
        try {
            const pollingTask = createGooglePollingTask(operationId, GOOGLE_API_BASE_URL, { "Content-Type": "application/json" });
            const pollingOptions = { 
                maxAttempts: 6, 
                baseDelay: 3000, 
                shouldStop: res => res.done, 
                onAttempt: (attempt, delay) => { tracker.onAttempt(attempt, delay); }, 
                onError: (error, attempt) => { tracker.error(error.message); }
            };
            const pollingResult = await intelligentPoll(pollingTask, pollingOptions);
            tracker.complete();
            
            if (!pollingResult.response) { 
                throw new Error("轮询完成但未获得有效响应"); 
            }
            responseData = pollingResult.response;
        } catch (pollingError) {
            console.error('[Google轮询错误]', pollingError);
            tracker.error(`轮询失败: ${pollingError.message}`);
            throw new Error("Google轮询任务失败: " + pollingError.message);
        }
    }

    return parseGoogleResponse(responseData)?.choices?.[0]?.message?.content;
}

async function callSillyTavernBackend(messages, options) {
    console.log('[Amily2号-ST后端] 通过SillyTavern后端调用API');

    const rawResponse = await $.ajax({
        url: '/api/backends/chat-completions/generate',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: options.apiUrl,
            api_key: options.apiKey,
            model: options.model,
            messages: messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
            stream: false
        })
    });

    const result = normalizeApiResponse(rawResponse);
    if (result.error) {
        throw new Error(result.error.message || 'SillyTavern后端API调用失败');
    }

    return result.content;
}


async function callSillyTavernPreset(messages, options) {
    console.log('[Amily2号-ST预设] 使用SillyTavern预设调用');

    const context = getContext();
    if (!context) {
        throw new Error('无法获取SillyTavern上下文');
    }

    const profileId = options.tavernProfile || extension_settings[extensionName]?.tavernProfile;
    if (!profileId) {
        throw new Error('未配置SillyTavern预设ID');
    }

    let originalProfile = '';
    let responsePromise;

    try {
        originalProfile = await compatibleTriggerSlash('/profile');
        console.log(`[Amily2号-ST预设] 当前配置文件: ${originalProfile}`);

        const targetProfile = context.extensionSettings?.connectionManager?.profiles?.find(p => p.id === profileId);
        if (!targetProfile) {
            throw new Error(`未找到配置文件ID: ${profileId}`);
        }

        const targetProfileName = targetProfile.name;
        console.log(`[Amily2号-ST预设] 目标配置文件: ${targetProfileName}`);

        const currentProfile = await compatibleTriggerSlash('/profile');
        if (currentProfile !== targetProfileName) {
            console.log(`[Amily2号-ST预设] 切换配置文件: ${currentProfile} -> ${targetProfileName}`);
            const escapedProfileName = targetProfileName.replace(/"/g, '\\"');
            await compatibleTriggerSlash(`/profile await=true "${escapedProfileName}"`);
        }

        if (!context.ConnectionManagerRequestService) {
            throw new Error('ConnectionManagerRequestService不可用');
        }

        console.log(`[Amily2号-ST预设] 通过配置文件 ${targetProfileName} 发送请求`);
        responsePromise = context.ConnectionManagerRequestService.sendRequest(
            targetProfile.id,
            messages,
            options.maxTokens || 4000
        );

    } finally {
        try {
            const currentProfileAfterCall = await compatibleTriggerSlash('/profile');
            if (originalProfile && originalProfile !== currentProfileAfterCall) {
                console.log(`[Amily2号-ST预设] 恢复原始配置文件: ${currentProfileAfterCall} -> ${originalProfile}`);
                const escapedOriginalProfile = originalProfile.replace(/"/g, '\\"');
                await compatibleTriggerSlash(`/profile await=true "${escapedOriginalProfile}"`);
            }
        } catch (restoreError) {
            console.error('[Amily2号-ST预设] 恢复配置文件失败:', restoreError);
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

export function generateRandomSeed() {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const randomLetter = () => letters[Math.floor(Math.random() * letters.length)];
    const randomRoll = (max) => Math.floor(Math.random() * max) + 1;

    let seed = '';
    seed += randomLetter();
    seed += randomRoll(1919819);
    seed += randomLetter();
    seed += randomLetter();
    seed += randomRoll(114514);
    seed += randomLetter();
    seed += randomLetter();
    seed += randomRoll(9999);
    seed += randomRoll(9999);
    seed += randomLetter();
    
    return seed;
}


export async function checkAndFixWithAPI(latestMessage, previousMessages) {
    const { processOptimization } = await import('./summarizer.js');
    return await processOptimization(latestMessage, previousMessages);
}
