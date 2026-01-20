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
// 核心调用入口 (Hybrid Mode: Bus First -> Fallback Legacy)
// =================================================================================================

export async function callNccsAI(messages, options = {}) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-Nccs制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }

    const settings = getNccsApiSettings();

    // 0. 全局开关检查
    if (settings.nccsEnabled === false) {
        // 暂不阻断，仅作为配置读取，保持兼容性
    }

    // 1. 基础配置确定 (options 覆盖 settings)
    const activeMode = options.apiMode || settings.apiMode;
    const activeUrl = options.apiUrl || settings.apiUrl;
    const activeKey = options.apiKey || settings.apiKey;
    const activeModel = options.model || settings.model;
    const activeProfile = options.tavernProfile || settings.tavernProfile;
    const activeMaxTokens = options.maxTokens ?? settings.maxTokens;
    const activeTemperature = options.temperature ?? settings.temperature;
    const activeFakeStream = options.useFakeStream ?? settings.useFakeStream;

    if (activeMode !== 'sillytavern_preset') {
        if (!activeUrl || !activeModel || !activeKey) {
            console.warn("[Amily2-Nccs外交部] API配置不完整，无法调用AI");
            toastr.error("API配置不完整，请检查URL、Key和模型配置。", "Nccs-外交部");
            return null;
        }
    }

    // [兼容性修复] 自动收集 options 中的额外参数到 params，防止 ModelCaller 丢失 top_p 等参数
    const standardKeys = [
        'apiMode', 'apiUrl', 'apiKey', 'model', 
        'maxTokens', 'temperature', 'tavernProfile', 'useFakeStream', 
        'params'
    ];
    const extraParams = {};
    Object.keys(options).forEach(key => {
        if (!standardKeys.includes(key)) {
            extraParams[key] = options[key];
        }
    });
    // 合并显式的 options.params 和 收集到的 extraParams
    const finalParams = { ...extraParams, ...(options.params || {}) };


    // ============================================================
    // 尝试路径 A: 新版 Amily2Bus ModelCaller (支持 FakeStream)
    // ============================================================
    if (nccsCtx && nccsCtx.model) {
        try {
            nccsCtx.log('Main', 'info', `[v2] 尝试通过 ModelCaller 调用 (${activeFakeStream ? 'FakeStream' : 'Standard'})...`);

            const builder = nccsCtx.model.Options.builder()
                .setFakeStream(activeFakeStream)
                .setMaxTokens(activeMaxTokens)
                .setTemperature(activeTemperature)
                .setParams(finalParams);

            if (activeMode === 'sillytavern_preset') {
                builder.setMode('preset')
                    .setPresetId(activeProfile)
                    .setModel(activeModel);
            } else {
                builder.setMode('direct')
                    .setApiUrl(activeUrl)
                    .setApiKey(activeKey)
                    .setModel(activeModel);
            }

            // 发起请求
            const response = await nccsCtx.model.call(messages, builder.build());

            // 校验结果
            if (response) {
                nccsCtx.log('Main', 'info', `[v2] ModelCaller 调用成功。`);
                return response;
            } else {
                throw new Error("ModelCaller 返回了空响应");
            }

        } catch (busError) {
            const errorMsg = `[v2] ModelCaller 调用失败，准备回退到旧版逻辑。原因: ${busError.message}`;
            // 记录错误但阻断抛出，以便执行下方代码
            if (nccsCtx) nccsCtx.log('Main', 'warn', errorMsg);
            else console.warn(errorMsg);
        }
    } else {
        console.warn("[Amily2-Nccs] Bus 未连接，直接使用旧版逻辑。");
    }

    // ============================================================
    // 尝试路径 B: 旧版 Legacy 方法 (Fallback)
    // ============================================================
    // 构建 Legacy 兼容对象
    const legacyOptions = {
        apiMode: activeMode,
        apiUrl: activeUrl,
        apiKey: activeKey,
        model: activeModel,
        tavernProfile: activeProfile,
        maxTokens: activeMaxTokens,
        temperature: activeTemperature,
        useFakeStream: activeFakeStream,
        ...finalParams // 将额外参数直接展平回 legacyOptions 根目录
    };

    try {
        console.groupCollapsed(`[Amily2-Nccs] 降级使用 Legacy API 调用`);
        console.log("Fallback Mode Active");

        let responseContent;

        switch (activeMode) {
            case 'openai_test':
                responseContent = await callNccsOpenAITest(messages, legacyOptions);
                break;
            case 'sillytavern_preset':
                responseContent = await callNccsSillyTavernPreset(messages, legacyOptions);
                break;
            default:
                console.error(`未支持的 API 模式: ${activeMode}`);
                return null;
        }

        console.log("Legacy Response:", responseContent);
        console.groupEnd();

        return responseContent;

    } catch (legacyError) {
        console.groupEnd();
        console.error(`[Amily2-Nccs] Legacy API 调用也失败了:`, legacyError);

        // 统一错误提示
        const msg = legacyError.message;
        if (msg.includes('401')) toastr.error("API认证失败 (401)", "Nccs API Error");
        else if (msg.includes('403')) toastr.error("权限拒绝 (403)", "Nccs API Error");
        else if (msg.includes('500')) toastr.error("服务器错误 (500)", "Nccs API Error");
        else toastr.error(`调用失败: ${msg}`, "Nccs API Error");

        return null;
    }
}

// =================================================================================================
// Legacy Implementations (保留旧代码以供降级使用)
// =================================================================================================

function normalizeApiResponse(responseData) {
    let data = responseData;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return { error: { message: 'Invalid JSON' } }; }
    }
    if (data?.data?.data) data = data.data; // Unpack nested data
    if (data?.choices?.[0]?.message?.content) return { content: data.choices[0].message.content.trim() };
    if (data?.content) return { content: data.content.trim() };
    if (data?.data) return { data: data.data };
    if (data?.error) return { error: data.error };
    return data;
}

async function callNccsOpenAITest(messages, options) {
    const isGoogleApi = options.apiUrl.includes('googleapis.com');
    const body = {
        chat_completion_source: 'openai',
        messages: messages,
        model: options.model,
        reverse_proxy: options.apiUrl,
        proxy_password: options.apiKey,
        stream: false, // 旧版不支持 FakeStream
        max_tokens: options.maxTokens || 4000,
        temperature: options.temperature || 1,
        top_p: options.top_p || 1,
    };

    if (!isGoogleApi) {
        Object.assign(body, {
            custom_prompt_post_processing: 'strict',
            enable_web_search: false,
            frequency_penalty: 0,
            presence_penalty: 0.12,
            request_images: false,
        });
    }

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`Legacy HTTP ${response.status}: ${await response.text()}`);
    }

    const responseData = await response.json();
    return responseData?.choices?.[0]?.message?.content;
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
            console.log(`[Legacy Switching profile: ${originalProfile} -> ${targetProfile.name}`);
            await amilyHelper.triggerSlash(`/profile await=true "${targetProfile.name.replace(/"/g, '\\"')}"`);
        }

        if (!context.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService unavailable');

        const result = await context.ConnectionManagerRequestService.sendRequest(
            targetProfile.id,
            messages,
            options.maxTokens || 4000
        );

        const normalized = normalizeApiResponse(result);
        if (normalized.error) throw new Error(normalized.error.message);
        return normalized.content;

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

