import { extension_settings, getContext } from '/scripts/extensions.js';
import { 
    saveSettingsDebounced,
    eventSource,
    event_types,
    saveChatConditional,
    reloadCurrentChat
} from '/script.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';

let availableModels = [];
let isFetchingModels = false; 
// 插件名称
const extensionName = 'ST-Amily2-Chat-Optimisation';
const extensionFolderPath = `scripts/extensions/third-party/ST-Amily2-Chat-Optimisation`;

// === 动态密码生成器 ===
function generateDynamicPassword(date = new Date()) {
    // 种子值
    const seed = {
        a: 1103515245,
        c: 12345,
        m: 2147483647,
    };
    
    // 核心哈希算法
    function customHash(input) {
        let hash = 0;
        for(let i = 0; i < input.length; i++) {
            hash = ((hash << 5) - hash) + input.charCodeAt(i);
            hash |= 0; // 转为32位整型
        }
        return hash >>> 0; // 确保为正整数
    }
    
    // 使用传入的日期作为基准
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear();
    const baseInput = `${month}-${day}-AMILY_${year}`;
    
    // 生成伪随机种子
    const str1 = `SD${customHash(baseInput)}`;
    const str2 = `V${customHash(str1)}`;
    
    // 使用线性同余算法生成密码
    function lcgRandom(params) {
        return function() {
            params.seed = (params.a * params.seed + params.c) % params.m;
            return params.seed;
        };
    }
    
    const combinedSeed = customHash(str2) % seed.m;
    const randFunc = lcgRandom({
        a: seed.a,
        c: seed.c,
        m: seed.m,
        seed: combinedSeed
    });
    
    // 密码字符集（移除易混淆字符）
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    
    // 生成密码段
    const segments = [];
    for (let segIdx = 0; segIdx < 3; segIdx++) {
        let segment = '';
        for (let i = 0; i < 4; i++) {
            const randValue = Math.abs(randFunc());
            segment += chars.charAt(randValue % chars.length);
        }
        segments.push(segment);
    }
    
    return segments.join('-');
}

// === 开发者使用的密码工具 ===
function getPasswordForDate(date = new Date()) {
    return generateDynamicPassword(date);
}

// 密码有效期设置（默认为7天）
const PASSWORD_VALIDITY_DAYS = 7;

// 开发者提示 - 在控制台显示今日密码
console.warn("[Amily2号] 开发者提示：今日密码 - ", getPasswordForDate());
console.log(`[Amily2号] 密码有效期为: ${PASSWORD_VALIDITY_DAYS}天`);

// ================ 实际使用的授权配置 ================
const AUTH_CONFIG = {
    expiryDate: new Date('2024-12-31'),
    validityDays: PASSWORD_VALIDITY_DAYS
};

// 默认设置
const defaultSettings = {
    enabled: true,
    activated: false,
    apiUrl: 'http://localhost:5001/v1',
    apiKey: '',
    model: 'deepseek-r1-250528',
    maxTokens: 12000,
    temperature: 1.2,
    contextMessages: 2,
    systemPrompt: '',
    mainPrompt: '',
    showOptimizationToast: true,
    suppressToast: false,
};

// 授权状态变量
window.pluginAuthStatus = {
    authorized: false,
    expired: false
};

// ============= 新增函数: 获取模型列表 =============
async function fetchSupportedModels() {
    const settings = extension_settings[extensionName];
    
    if (!settings.apiUrl) {
        toastr.error('请先配置API URL', '获取模型失败');
        return [];
    }
    
    if (isFetchingModels) {
        toastr.info('正在获取模型列表，请稍候...', '获取模型');
        return;
    }
    
    isFetchingModels = true;
    try {
        const originalButtonText = $('#amily2_refresh_models').html();
        
        $('#amily2_refresh_models')
            .prop('disabled', true)
            .html('<i class="fas fa-spinner fa-spin"></i> 加载中');
        
        let modelListUrl = settings.apiUrl;
        if (!modelListUrl.endsWith('/v1/models')) {
            if (modelListUrl.endsWith('/')) {
                modelListUrl += 'v1/models';
            } else {
                modelListUrl += '/v1/models';
            }
        }
        
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (settings.apiKey) {
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }
        
        console.log('发送模型列表请求到:', modelListUrl);
        
        const response = await fetch(modelListUrl, {
            method: 'GET',
            headers: headers
        });
        
        if (!response.ok) {
            throw new Error(`API返回错误: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        let models = [];
        
        if (Array.isArray(data)) {
            models = data.map(m => m.id || m);
        } else if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => m.id);
        } else if (data.models && Array.isArray(data.models)) {
            models = data.models;
        } else {
            throw new Error('未知的模型列表格式');
        }
        
        availableModels = models.filter(m => 
            !m.includes('embed') && 
            !m.includes('search') && 
            !m.includes('similarity') && 
            !m.includes('audio')
        );
        
        availableModels.sort();
        
        console.log(`获取模型列表成功 (${availableModels.length}个):`, availableModels);
        toastr.success(`成功获取 ${availableModels.length} 个可用模型`, '模型加载完成');
        
        return availableModels;
    } catch (error) {
        console.error('获取模型列表失败:', error);
        toastr.error(`获取模型失败: ${error.message}`, '错误');
        return [];
    } finally {
        isFetchingModels = false;
        
        $('#amily2_refresh_models')
            .prop('disabled', false)
            .html('<i class="fas fa-sync-alt"></i> 刷新模型');
    }
}

// ============= 新增函数: 填充模型下拉菜单 =============
function populateModelDropdown() {
    const modelSelect = $('#amily2_model');
    const modelNotes = $('#amily2_model_notes');
    
    modelSelect.empty();
    
    const currentModel = extension_settings[extensionName].model || '';
    
    if (availableModels.length === 0) {
        modelSelect.append('<option value="">无可用模型，请刷新</option>');
        modelNotes.html('<span style="color: #ff9800;">请检查API配置后点击"刷新模型"按钮</span>');
        return;
    }
    
    const defaultOption = $('<option></option>')
        .val('')
        .text('-- 选择模型 --');
    modelSelect.append(defaultOption);
    
    availableModels.forEach(model => {
        const option = $('<option></option>')
            .val(model)
            .text(model);
            
        if (model === currentModel) {
            option.attr('selected', 'selected');
        }
        
        modelSelect.append(option);
    });
    
    if (currentModel && modelSelect.val() === currentModel) {
        modelNotes.html(`已选择: <strong>${currentModel}</strong>`);
    } else {
        modelNotes.html(`已加载 ${availableModels.length} 个可用模型`);
    }
}

// 加载设置
async function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {}; 
    }
    
    // ===== 授权过期检查 =====
    const now = new Date();
    window.pluginAuthStatus.expired = now > AUTH_CONFIG.expiryDate;
    
    if (window.pluginAuthStatus.expired) {
        localStorage.removeItem('plugin_activated');
        localStorage.removeItem('plugin_auth_code');
        localStorage.removeItem('plugin_valid_until');
        console.log('[Amily2号] 检测到授权过期，已清理本地存储');
    }
    
    // 合并默认设置
    extension_settings[extensionName] = {
        ...defaultSettings,
        ...extension_settings[extensionName]
    };
    
    // 检查授权状态
    window.pluginAuthStatus.authorized = await checkAuthorization();
    
    // 更新UI
    updateUI();
    
    // 自动加载模型
    if (window.pluginAuthStatus.authorized && extension_settings[extensionName].apiUrl) {
        const cachedModels = localStorage.getItem('amily2_cached_models');
        if (cachedModels) {
            availableModels = JSON.parse(cachedModels);
            console.log('从缓存加载模型列表:', availableModels.length);
            populateModelDropdown();
        }
        
        setTimeout(() => {
            if (availableModels.length === 0) {
                toastr.info('正在自动加载模型列表...', '模型初始化');
                $('#amily2_refresh_models').click();
            }
        }, 1500);
    }
    
    $('#amily2_api_url').on('input', function() {
        localStorage.removeItem('amily2_cached_models');
        availableModels = [];
        populateModelDropdown();
    });
}

// 检查授权状态（无UI更新）
function checkAuthorization() {
    const now = new Date();
    window.pluginAuthStatus.expired = now > AUTH_CONFIG.expiryDate;
    
    const activated = localStorage.getItem('plugin_activated') === 'true';
    const savedAuthCode = localStorage.getItem('plugin_auth_code');
    const validUntil = localStorage.getItem('plugin_valid_until');
    
    let withinValidityPeriod = false;
    
    if (validUntil) {
        const validUntilDate = new Date(validUntil);
        withinValidityPeriod = now <= validUntilDate;
        console.log(`[Amily2号] 授权有效期检查: 
            当前时间: ${now.toISOString()}
            授权有效期至: ${validUntilDate.toISOString()}
            是否在有效期内: ${withinValidityPeriod}`);
    }
    
    let passwordMatches = false;
    if (savedAuthCode) {
        const today = new Date();
        for (let i = 0; i < AUTH_CONFIG.validityDays; i++) {
            const checkDate = new Date();
            checkDate.setDate(today.getDate() - i);
            const passwordForDay = getPasswordForDate(checkDate);
            
            if (savedAuthCode === passwordForDay) {
                passwordMatches = true;
                console.log(`[Amily2号] 密码匹配: ${savedAuthCode} 对应第${i+1}天前`);
                break;
            }
        }
    }
    
    window.pluginAuthStatus.authorized = activated && 
        !window.pluginAuthStatus.expired && 
        passwordMatches && 
        withinValidityPeriod;
    
    return window.pluginAuthStatus.authorized;
}

// 激活授权
async function activatePluginAuthorization(authCode) {
    let isValidCode = false;
    const today = new Date();
    
    for (let i = 0; i < AUTH_CONFIG.validityDays; i++) {
        const checkDate = new Date();
        checkDate.setDate(today.getDate() - i);
        const passwordForDay = getPasswordForDate(checkDate);
        
        if (authCode === passwordForDay) {
            isValidCode = true;
            console.log(`[Amily2号] 输入的密码匹配第${i+1}天前的有效密码`);
            break;
        }
    }
    
    if (!isValidCode) {
        toastr.error('授权码无效', '激活失败');
        return false;
    }
    
    const now = new Date();
    if (now > AUTH_CONFIG.expiryDate) {
        toastr.error('授权已过期', '激活失败');
        return false;
    }
    
    const validUntil = new Date();
    validUntil.setDate(now.getDate() + AUTH_CONFIG.validityDays);
    
    localStorage.setItem('plugin_valid_until', validUntil.toISOString());
    localStorage.setItem('plugin_auth_code', authCode);
    localStorage.setItem('plugin_activated', 'true');
    
    toastr.success(`授权激活成功，有效期至 ${validUntil.toLocaleDateString()}`, 'Amily2号启用');
    window.pluginAuthStatus.authorized = true;
    
    $('#auth_panel').hide();
    $('.plugin-features').show();
    
    extension_settings[extensionName].enabled = true;
    saveSettings();
    
    return true;
}

// 显示过期信息
function displayExpiryInfo() {
    const now = new Date();
    const daysLeft = Math.ceil((AUTH_CONFIG.expiryDate - now) / (1000 * 60 * 60 * 24));
    const validUntil = localStorage.getItem('plugin_valid_until');
    
    if (window.pluginAuthStatus.expired) {
        return '<div class="auth-status expired"><i class="fas fa-exclamation-triangle"></i> 授权已过期</div>';
    } else {
        let validUntilHtml = '';
        if (validUntil) {
            const validUntilDate = new Date(validUntil);
            validUntilHtml = `<small>当前授权有效期至: ${validUntilDate.toLocaleDateString()}</small>`;
        }
        
        return `
            <div class="auth-status valid">
                <i class="fas fa-lock-open"></i> 授权有效期: ${daysLeft}天
                <small>有效期至: ${AUTH_CONFIG.expiryDate.toLocaleDateString()}</small>
                ${validUntilHtml}
            </div>
        `;
    }
}

// ============= 配置验证函数 =============
function validateSettings() {
    const settings = extension_settings[extensionName] || {};
    const errors = [];
    
    if (!settings.apiUrl) {
        errors.push('API URL未配置');
    } else if (!/^https?:\/\//.test(settings.apiUrl)) {
        errors.push('API URL必须以http://或https://开头');
    }
    
    if (settings.apiKey) {
        if (settings.apiKey.length < 8) {
            errors.push('API密钥太短（至少8位）');
        }
        if (/(key|secret|password)/i.test(settings.apiKey)) {
            toastr.warning('请注意：API Key包含敏感关键词("key", "secret", "password")', '安全提醒', { timeOut: 5000 });
        }
    }
    
    if (!settings.model) {
        errors.push('未选择模型');
    }
    
    if (settings.maxTokens < 100 || settings.maxTokens > 20000) {
        errors.push(`Token数超限 (${settings.maxTokens}) - 必须在100-20000之间`);
    }
    
    return errors.length ? errors : null;
}

// ============= 统一的设置项事件处理 =============
function saveSettings() {
    if (!window.pluginAuthStatus.authorized) return false; // 确保在未授权时不保存

    const validationErrors = validateSettings();
    
    if (validationErrors) {
        const errorHtml = validationErrors.map(err => `<div>❌ ${err}</div>`).join('');
        toastr.error(`配置存在错误：${errorHtml}`, '设置未保存', { 
            timeOut: 8000,
            extendedTimeOut: 0,
            preventDuplicates: true
        });
        return false;
    }
    
    saveSettingsDebounced();
    return true;
}

// 统一处理所有设置项变更
$('[id^="amily2_"]').on('change', function() {
    if (!window.pluginAuthStatus.authorized) return;
    
    // 获取设置名称（从ID转换）
    const settingName = this.id.replace('amily2_', '');
    
    // 根据控件类型获取值
    let value;
    if ($(this).is(':checkbox')) {
        value = $(this).prop('checked');
    } 
    else if (settingName === 'max_tokens' || settingName === 'context_messages') {
        value = parseInt($(this).val());
    }
    else if (settingName === 'temperature') {
        value = parseFloat($(this).val());
    }
    else {
        value = $(this).val();
    }
    
    // 更新设置
    extension_settings[extensionName][settingName] = value;
    
    // 更新显示值（如果适用）
    if (settingName === 'enabled') {
        extension_settings[extensionName].enabled = value;
    }
    else if (settingName === 'max_tokens') {
        $('#amily2_max_tokens_value').text(value);
    }
    else if (settingName === 'temperature') {
        $('#amily2_temperature_value').text(value);
    }
    else if (settingName === 'context_messages') {
        $('#amily2_context_messages_value').text(value);
    }
    else if (settingName === 'show_toast') {
        extension_settings[extensionName].suppressToast = false;
    }
    
    console.log(`[Amily2设置] ${settingName} 更新为:`, value);
    
    // 尝试保存，保存失败则恢复原值
    if (!saveSettings()) {
        // 恢复原始值
        const originalValue = defaultSettings[settingName];
        
        if ($(this).is(':checkbox')) {
            $(this).prop('checked', originalValue);
        } 
        else {
            $(this).val(originalValue);
        }
        
        // 特殊控件恢复
        if (settingName === 'max_tokens') {
            $('#amily2_max_tokens_value').text(originalValue);
        } 
        else if (settingName === 'temperature') {
            $('#amily2_temperature_value').text(originalValue);
        } 
        else if (settingName === 'context_messages') {
            $('#amily2_context_messages_value').text(originalValue);
        }
    }
});

// ============= 更新UI =============
function updateUI() {
    const authStatus = window.pluginAuthStatus;
    
    if (!authStatus.authorized) {
        $('#amily2_enabled').prop('checked', false);
        $('#amily2_enabled').prop('disabled', true);
        $('[id^="amily2_"]').not('#auth_input, #auth_submit').prop('disabled', true);
        toastr.warning('插件未授权，功能已禁用', 'Amily2号');
    } else {
        const settings = extension_settings[extensionName];
        $('#amily2_enabled').prop('disabled', false);
        $('[id^="amily2_"]').prop('disabled', false);
        
        $('#amily2_enabled').prop('checked', settings.enabled);
        $('#amily2_api_url').val(settings.apiUrl);
        $('#amily2_api_key').val(settings.apiKey);
        
        populateModelDropdown();
        
        $('#amily2_max_tokens').val(settings.maxTokens);
        $('#amily2_max_tokens_value').text(settings.maxTokens);
        $('#amily2_temperature').val(settings.temperature);
        $('#amily2_temperature_value').text(settings.temperature);
        $('#amily2_context_messages').val(settings.contextMessages);
        $('#amily2_context_messages_value').text(settings.contextMessages); 
        $('#amily2_main_prompt').val(settings.mainPrompt);
        $('#amily2_system_prompt').val(settings.systemPrompt);
        
        if ($('#amily2_show_toast').length) {
            $('#amily2_show_toast').prop('checked', settings.showOptimizationToast);
            extension_settings[extensionName].suppressToast = settings.suppressToast;
        }
    }
}

// 检查最新消息
async function checkLatestMessage() {
    const context = getContext();
    const chat = context.chat || [];
    
    if (!chat || chat.length === 0) {
        console.log('[聊天回复检查器] 没有聊天记录');
        return { message: null, previousMessages: [] };
    }
    
    const latestMessage = chat[chat.length - 1];
    
    console.log('[聊天回复检查器] 检查消息:', {
        isUser: latestMessage.is_user,
        messageLength: latestMessage.mes?.length,
        messagePreview: latestMessage.mes?.substring(0, 50) + '...'
    });
    
    if (latestMessage.is_user) {
        console.log('[聊天回复检查器] 跳过用户消息');
        return { message: latestMessage, previousMessages: [] };
    }
    
    // 获取上下文消息（根据用户设置）
    const settings = extension_settings[extensionName];
    const contextCount = settings.contextMessages || 2;
    const startIndex = Math.max(0, chat.length - contextCount - 1);
    const previousMessages = chat.slice(startIndex, chat.length - 1);
    
    console.log('[聊天回复检查器] 上下文设置:', {
        contextMessages: settings.contextMessages,
        contextCount: contextCount,
        chatLength: chat.length,
        startIndex: startIndex,
        previousMessagesCount: previousMessages.length
    });
    
    console.log('[聊天回复检查器] 获取上下文消息:', {
        previousMessages: previousMessages.length,
        startIndex: startIndex
    });
    
    return { message: latestMessage, previousMessages };
}

// 使用API检查和修复消息（添加防止无限重试）
async function checkAndFixWithAPI(latestMessage, previousMessages, isRetry = false, retryCount = 0) {
    const settings = extension_settings[extensionName];
    
    if (!settings.apiUrl) {
        console.error('[聊天回复检查器] 未配置API URL');
        return null;
    }
    
    // 优先使用主要提示词，如果为空则使用系统提示词
    const usePrompt = settings.mainPrompt || settings.systemPrompt;
    
    if (!usePrompt) {
        console.error('[聊天回复检查器] 未配置主要或系统提示词');
        toastr.error('请配置主要提示词或系统提示词', '聊天回复检查器');
        return null;
    }
    
    // 构建检查内容
    let checkContent = `请检查并优化以下文本：\n\n"${latestMessage.mes}"\n\n`;
    
    // 始终提供上下文参考（让AI自主判断是否需要考虑）
    if (previousMessages.length > 0) {
        checkContent += '上下文参考：\n';
        const recentMessages = previousMessages.slice(-2);
        recentMessages.forEach((msg, index) => {
            const speaker = msg.is_user ? '用户' : 'AI';
            checkContent += `${speaker}: "${msg.mes}"\n`;
        });
        checkContent += '\n';
    }
    
    checkContent += '请按照系统提示的格式分析并回复。';
    
    // 构建请求消息（使用优先的提示词）
    const messages = [
        {
            role: 'system',
            content: usePrompt
        },
        {
            role: 'user',
            content: checkContent
        }
    ];
    
    try {
        // 确保URL格式正确
        let apiUrl = settings.apiUrl;
        // 针对不同API提供商处理URL
        if (apiUrl.includes('ark.cn-beijing.volces.com')) {
            // 火山引擎 ARK API
            if (!apiUrl.endsWith('/completion')) {
                apiUrl = apiUrl.replace(/\/completion$/, '');
                if (apiUrl.endsWith('/')) {
                    apiUrl += 'completion';
                } else {
                    apiUrl += '/completion';
                }
            }
        } else if (!apiUrl.endsWith('/chat/completions')) {
            // 标准 OpenAI 格式
            if (apiUrl.endsWith('/v1')) {
                apiUrl = apiUrl + '/chat/completions';
            } else if (apiUrl.endsWith('/')) {
                apiUrl = apiUrl + 'v1/chat/completions';
            } else {
                apiUrl = apiUrl + '/v1/chat/completions';
            }
        }
        
        const requestBody = {
            model: settings.model,
            messages: messages,
            max_tokens: settings.maxTokens,
            temperature: settings.temperature,
            stream: false
        };
        
        console.log('[聊天回复检查器] API请求:', {
            url: apiUrl,
            model: settings.model,
            messagesCount: messages.length,
            isRetry: isRetry,
            retryCount: retryCount
        });
        
        const headers = {
            'Content-Type': 'application/json'
        };
        
        // 只有在有API Key时才添加Authorization头
        if (settings.apiKey) {
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[聊天回复检查器] API请求失败详情:', {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                errorBody: errorText
            });
            throw new Error(`API请求失败: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const data = await response.json();
        const apiResponse = data.choices?.[0]?.message?.content;
        
        if (!apiResponse) {
            console.error('[聊天回复检查器] API响应格式错误:', data);
            throw new Error('API返回的消息为空');
        }
        
        console.log('[聊天回复检查器] API返回内容:', apiResponse);
        
        // 检查API是否返回错误信息
        if (apiResponse.includes('无法生成回复') || 
            apiResponse.includes('请尝试修改') ||
            apiResponse.includes('内容过滤') ||
            apiResponse.includes('违反政策')) {
            console.log('[聊天回复检查器] API返回错误信息', apiResponse);
            
            // 添加重试限制：最多4次
            if (!isRetry && retryCount < 4) {
                const nextRetryCount = retryCount + 1;
                console.log(`[聊天回复检查器] API错误，开始第${nextRetryCount}次重试...`);
                toastr.info(`API优化失败，正在重试 (${nextRetryCount}/4)`, '聊天回复检查器');
                // 增加延迟（随重试次数增加）
                await new Promise(resolve => setTimeout(resolve, 1000 * nextRetryCount));
                return await checkAndFixWithAPI(latestMessage, previousMessages, true, nextRetryCount);
            } else {
                console.log('[聊天回复检查器] API重试次数已达上限，放弃优化');
                toastr.warning('API优化失败已达到最大重试次数', '聊天回复检查器');
                return null;
            }
        }
        
        const hasThinkTag = apiResponse.includes('think');
        const hasContentTag = apiResponse.includes('content');
        
        if (has888Tag && has666Tag) {
            // 匹配think标签
            const thinkMatch = apiResponse.match(/<think>([\s\S]*?)<\/think>/);
            // 匹配content标签
            const contentMatch = apiResponse.match(/<content>([\s\S]*?)<\/content>/);
            
            if (!thinkMatch) {
                console.log('[聊天回复检查器] API响应格式错误，未找到888标签');
                return null;
            }
            
            const thinkContent = thinkMatch[1].trim();
            const fixedContent = contentMatch ? contentMatch[1].trim() : '';
            
            console.log('[聊天回复检查器] 分析结果:', thinkContent);
            console.log('[聊天回复检查器] 修复内容:', fixedContent);
            
            // 在界面显示分析结果（带"不再显示"选项）
            const settings = extension_settings[extensionName];
            if (thinkContent && settings.showOptimizationToast && !settings.suppressToast) {
                // 构建弹窗内容
                const toastContent = `
                    <div>${thinkContent.substring(0, 100)}${thinkContent.length > 100 ? "..." : ""}</div>
                    <div style="margin-top: 8px">
                        <label style="cursor: pointer">
                            <input type="checkbox" id="amily2_dont_show_again">
                            不再显示此提示
                        </label>
                    </div>
                `;
                
                // 显示带选项的弹窗
                const toast = toastr.info(toastContent, 'AI优化分析', {
                    timeOut: 0, // 不会自动关闭
                    extendedTimeOut: 0,
                    preventDuplicates: true,
                    closeButton: true,
                    tapToDismiss: false,
                    onclick: null,
                    onShown: function() {
                        // 绑定"不再显示"复选框的事件
                        $('#amily2_dont_show_again').on('change', function() {
                            if (this.checked) {
                                // 更新设置
                                extension_settings[extensionName].suppressToast = true;
                                saveSettings();
                                toastr.remove(toast);
                                toastr.success('已隐藏优化通知', '设置更新');
                            }
                        });
                    }
                });
            }
            
            // 如果修复内容为空，则不需要修复
            if (!fixedContent) {
                console.log('[聊天回复检查器] API判定：不需要优化');
                return null;
            }
            
            console.log('[聊天回复检查器] API判定：需要优化');
            // 返回完整的API响应，包含标签
            return apiResponse;
        } else {
            // 如果没有标签格式
            console.log('[聊天回复检查器] API返回普通文本格式');
            
            // 如果返回"无需改进"类似内容，则不修复
            if (apiResponse.includes('无需改进') || 
                apiResponse.includes('不需要改进') ||
                apiResponse.includes('质量良好') ||
                apiResponse.includes('没有问题')) {
                console.log('[聊天回复检查器] API判定：不需要优化');
                return null;
            }
            
            console.log('[聊天回复检查器] API判定：需要优化');
            return apiResponse;
        }
    } catch (error) {
        console.error('[聊天回复检查器] API调用出错:', error);
        toastr.error(`API调用失败: ${error.message}`, '聊天回复检查器', {timeOut: 8000});
        
        return null;
    }
}

// 存储已处理的消息，防止循环修复
const processedMessages = new Set();

// 处理消息接收事件（在渲染前拦截）
async function onMessageReceived(data) {
    console.log('[聊天回复检查器] 消息接收事件触发:', { data, eventType: 'onMessageReceived' });
    
    const settings = extension_settings[extensionName];
    
    console.log('[聊天回复检查器] 当前设置:', {
        enabled: settings.enabled,
        hasApiUrl: !!settings.apiUrl,
        apiUrl: settings.apiUrl
    });
    
    if (!settings.enabled) {
        console.log('[聊天回复检查器] 插件未启用，跳过检查');
        return;
    }
    
    if (!settings.apiUrl) {
        console.log('[聊天回复检查器] 未配置API URL，跳过检查');
        return;
    }
    
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length === 0) {
        console.log('[聊天回复检查器] 没有聊天记录');
        return;
    }
    
    const latestMessage = chat[chat.length - 1];
    
    // 只处理AI的回复
    if (latestMessage.is_user) {
        console.log('[聊天回复检查器] 跳过用户消息');
        return;
    }
    
    // 跳过第一条消息（通常是系统消息或角色介绍）
    if (chat.length <= 1) {
        console.log('[聊天回复检查器] 跳过第一条消息');
        return;
    }
    
    // 跳过过短的消息（可能是系统消息）
    if (latestMessage.mes.length < 10) {
        console.log('[聊天回复检查器] 跳过过短的消息');
        return;
    }
    
    // 防循环检查：为消息生成唯一标识
    const messageKey = `${chat.length}-${latestMessage.mes.substring(0, 50)}`;
    
    if (processedMessages.has(messageKey)) {
        console.log('[聊天回复检查器] 消息已处理过，跳过检查避免循环');
        return;
    }
    
    // 标记消息为已处理
    processedMessages.add(messageKey);
    
    // 清理过期的标记（保留最近10条）
    if (processedMessages.size > 50) {
     const entries = Array.from(processedMessages);
     processedMessages.clear();
     entries.slice(-50).forEach(id => processedMessages.add(id));
}
    
    // 获取上下文消息
    const contextCount = settings.contextMessages || 2;
    const startIndex = Math.max(0, chat.length - 1 - contextCount);
    const previousMessages = chat.slice(startIndex, chat.length - 1);
    
    console.log('[聊天回复检查器] 开始检查生成的回复...');
    
    // 使用API检查和修复（添加初始重试次数0）
    const fixedMessage = await checkAndFixWithAPI(latestMessage, previousMessages, false, 0);
    
    if (fixedMessage && fixedMessage !== latestMessage.mes) {
        console.log('[聊天回复检查器] 内容已优化，显示优化版本');
        
        // 直接修改消息内容，不需要重新加载
        latestMessage.mes = fixedMessage;
        
        console.log('[聊天回复检查器] 回复已在显示前优化');
    } else {
        console.log('[聊天回复检查器] 内容无需优化，正常显示');
    }
}

// 手动检查命令（使用API检查）
async function checkCommand() {
    const settings = extension_settings[extensionName];
    if (!settings.apiUrl) {
        toastr.error('请先配置API URL', '聊天回复检查器');
        return '';
    }
    
    const checkResult = await checkLatestMessage();
    
    if (!checkResult.message) {
        toastr.info('没有可检查的消息', '聊天回复检查器');
        return '';
    }
    
    if (checkResult.message.is_user) {
        toastr.info('最新消息是用户消息，无需检查', '聊天回复检查器');
        return '';
    }
    
    toastr.info('正在使用API检查回复...', '聊天回复检查器');
    
    // 添加重试初始参数
    const fixedMessage = await checkAndFixWithAPI(checkResult.message, checkResult.previousMessages, false, 0);
    if (fixedMessage && fixedMessage !== checkResult.message.mes) {
        toastr.warning('检测到问题，建议使用修复功能', '聊天回复检查器');
    } else {
        toastr.success('未检测到问题', '聊天回复检查器');
    }
    
    return '';
}

// 手动修复命令
async function fixCommand() {
    const settings = extension_settings[extensionName];
    if (!settings.apiUrl) {
        toastr.error('请先配置API URL', '聊天回复检查器');
        return '';
    }
    
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length === 0) {
        toastr.info('没有可修复的消息', '聊天回复检查器');
        return '';
    }
    
    const latestMessage = chat[chat.length - 1];
    
    if (latestMessage.is_user) {
        toastr.info('最新消息是用户消息，无需修复', '聊天回复检查器');
        return '';
    }
    
    // 获取上下文消息
    const contextCount = settings.contextMessages || 2;
    const startIndex = Math.max(0, chat.length - 1 - contextCount);
    const previousMessages = chat.slice(startIndex, chat.length - 1);
    
    toastr.info('正在检查并修复回复...', '聊天回复检查器');
    
    // 添加重试初始参数
    const fixedMessage = await checkAndFixWithAPI(latestMessage, previousMessages, false, 0);
    
    if (fixedMessage && fixedMessage !== latestMessage.mes) {
        latestMessage.mes = fixedMessage; 
        await saveChatConditional();
        await reloadCurrentChat();
        toastr.success('回复已修复', '聊天回复检查器');
    } else {
        toastr.info('未检测到需要修复的问题', '聊天回复检查器');
    }
    
    return '';
}

// 测试命令（使用API测试）
async function testReplyChecker() {
    const settings = extension_settings[extensionName];
    if (!settings.apiUrl) {
        toastr.error('请先配置API URL', '聊天回复检查器');
        return '';
    }
    
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length < 2) {
        toastr.warning('需要至少2条消息才能测试', '聊天回复检查器');
        return '';
    }
    // 获取倒数第二条AI消息
    let testMessage = null;
    for (let i = chat.length - 2; i >= 0; i--) {
        if (!chat[i].is_user) {
            testMessage = chat[i].mes;
            break;
        }
    }
    
    if (!testMessage) {
        toastr.warning('没有找到可用于测试的AI消息', '聊天回复检查器');
        return '';
    }
    
    const lastMessage = chat[chat.length - 1];
    
    if (lastMessage.is_user) {
        toastr.warning('最后一条消息是用户消息，无法测试', '聊天回复检查器');
        return '';
    }
    
    // 临时修改最后一条消息来模拟重复
    const originalMessage = lastMessage.mes;
    lastMessage.mes = testMessage + '\n\n' + testMessage;
    
    toastr.info('正在使用API测试检测功能...', '聊天回复检查器');
    
    // 获取上下文消息
    const contextCount = settings.contextMessages || 2;
    const startIndex = Math.max(0, chat.length - contextCount - 1);
    const previousMessages = chat.slice(startIndex, chat.length - 1);
    
    // 使用API检查（添加重试初始参数）
    const fixedMessage = await checkAndFixWithAPI(lastMessage, previousMessages, false, 0);
    
    // 恢复原始消息
    lastMessage.mes = originalMessage;
    if (fixedMessage && fixedMessage !== (testMessage + '\n\n' + testMessage)) {
        toastr.success('测试成功！API检测到重复内容并提供了修复建议', '聊天回复检查器');
    } else {
        toastr.warning('测试结果：API未检测到问题，请检查API配置或提示词', '聊天回复检查器');
    }
    
    return '';
}

jQuery(async () => {
    // 加载设置
    await loadSettings();
    
    // 添加设置面板HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);
    $('#expiry_info').html(displayExpiryInfo());
    
    // 添加华丽的CSS样式
    addAuthStyles();
    
    // 注册激活按钮事件
    $('#auth_submit').on('click', async function() {
        const authCode = $('#auth_input').val().trim();
        if (!authCode) {
            toastr.error('请输入授权码', '验证失败');
            return;
        }
        
        const success = await activatePluginAuthorization(authCode);
        if (success) {
            // 隐藏授权面板，显示功能面板
            $('#auth_panel').slideUp(400);
            setTimeout(() => {
                $('.plugin-features').slideDown(400);
            }, 400);
        }
    });
    
    // ============= 模型下拉菜单事件 =============
    // 在API URL输入框的change事件中添加
    $('#amily2_api_url').on('change', function() {
        const url = $(this).val();
        if (url && !/^https?:\/\//.test(url)) {
            $(this).css('border', '2px solid #ff5252');
            toastr.error('API URL必须以http://或https://开头');
        } else {
            $(this).css('border', '');
        }
    });
    // 在Token输入框的change事件中添加
    $('#amily2_max_tokens').on('change', function() {
        const tokens = parseInt($(this).val());
        if (tokens < 100 || tokens > 20000) {
            $(this).siblings('label').css('color', '#ff5252');
        } else {
            $(this).siblings('label').css('color', '');
        }
    });
    $('#amily2_model').on('change', function() {
        const selectedModel = $(this).val();
        extension_settings[extensionName].model = selectedModel;
        saveSettings();
        
        // 更新状态信息
        if (selectedModel && selectedModel.length > 0) {
            $('#amily2_model_notes').html(`已选择模型: <strong>${selectedModel}</strong>`);
        } else {
            $('#amily2_model_notes').html('请选择一个模型');
        }
    });
    
    // ============= 刷新模型按钮事件 =============
    $('#amily2_refresh_models').on('click', async function() {
        // 添加视觉反馈 - 按钮动画
        $(this).addClass('pulse');
        setTimeout(() => $(this).removeClass('pulse'), 500);
        
        // 获取模型列表
        await fetchSupportedModels();
        
        // 填充下拉菜单
        populateModelDropdown();
        
        // 缓存模型列表
        if (availableModels.length > 0) {
            localStorage.setItem('amily2_cached_models', JSON.stringify(availableModels));
        }
    });
    
    // 绑定设置事件（所有其他设置项）
    $('#amily2_enabled').on('change', function() {
        if (!window.pluginAuthStatus.authorized) return;
        
        extension_settings[extensionName].enabled = $(this).prop('checked');
        saveSettings();
    });
    
    $('#amily2_api_url').on('input', function() {
        extension_settings[extensionName].apiUrl = String($(this).val());
        saveSettings();
    });
    
    $('#amily2_api_key').on('input', function() {
        extension_settings[extensionName].apiKey = String($(this).val());
        saveSettings();
    });
    
    $('#amily2_max_tokens').on('input', function() {
        extension_settings[extensionName].maxTokens = parseInt(String($(this).val()));
        $('#amily2_max_tokens_value').text(extension_settings[extensionName].maxTokens);
        saveSettings();
    });
    
    $('#amily2_temperature').on('input', function() {
        extension_settings[extensionName].temperature = parseFloat(String($(this).val()));
        $('#amily2_temperature_value').text(extension_settings[extensionName].temperature);
        saveSettings();
    });
    
    $('#amily2_context_messages').on('input', function() {
        const newValue = parseInt(String($(this).val()), 10);
        extension_settings[extensionName].contextMessages = newValue;
        $('#amily2_context_messages_value').text(newValue);
        console.log('[聊天回复检查器] 上下文消息数量已更新为:', newValue);
        saveSettings();
    });
    
    // 新增主要提示词事件绑定
    $('#amily2_main_prompt').on('input', function() {
        extension_settings[extensionName].mainPrompt = $(this).val();
        saveSettings();
    });
    
    // 系统提示词事件绑定
    $('#amily2_system_prompt').on('input', function() {
        extension_settings[extensionName].systemPrompt = $(this).val();
        saveSettings();
    });
    
    // 新增开关状态更新
    $('#amily2_show_toast').on('change', function() {
        extension_settings[extensionName].showOptimizationToast = $(this).prop('checked');
        saveSettings();
        
        // 如果重新开启通知，清除抑制状态
        if ($(this).prop('checked')) {
            extension_settings[extensionName].suppressToast = false;
            saveSettings();
        }
    });
    
    // 新增重置开关
    $('#amily2_reset_toast').on('click', function() {
        extension_settings[extensionName].showOptimizationToast = true;
        extension_settings[extensionName].suppressToast = false;
        saveSettings();
        toastr.success('通知设置已重置', 'Amily2号');
        $('#amily2_show_toast').prop('checked', true);
    });
    
    // 绑定测试按钮
    $('#amily2_test').on('click', checkCommand);
    $('#amily2_fix_now').on('click', fixCommand);
    
    // 监听消息生成完成但未渲染的事件
    if (!window.amily2EventsRegistered) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.IMPERSONATE_READY, onMessageReceived);
        window.amily2EventsRegistered = true;
        console.log('Amily2消息事件监听已注册');
    }
    
    // 注册斜杆命令
    SlashCommand.registerCommand(SlashCommand.fromProps({
        name: 'check-reply',
        callback: checkCommand,
        helpString: '检查最新的AI回复是否有问题',
    }));
    
    SlashCommand.registerCommand(SlashCommand.fromProps({
        name: 'fix-reply',
        callback: fixCommand,
        helpString: '修复最新的AI回复中的问题',
    }));
    
    SlashCommand.registerCommand(SlashCommand.fromProps({
        name: 'test-reply-checker',
        callback: testReplyChecker,
        helpString: '测试聊天回复检查器功能',
    }));
    
    // 更新UI
    updateUI();
    console.log('Amily2号优化助手已加载');
});

// ============= 添加华丽CSS样式 =============
function addAuthStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .flex-container {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            align-items: center;
        }
        
        #amily2_model {
            flex: 1;
            height: 42px;
            padding: 0 15px;
            background: rgba(50, 50, 75, 0.5);
            border: 1px solid rgba(255,255,255,0.15);
            color: white;
            border-radius: 8px;
            font-size: 0.95rem;
            appearance: auto;
            outline: none;
            transition: all 0.3s;
        }
        
        #amily2_model:focus {
            border-color: #4CAF50;
            box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.3);
        }
        
        #amily2_refresh_models {
            height: 42px;
            padding: 0 15px;
            display: flex;
            align-items: center;
            background: linear-gradient(to right, #4CAF50, #8BC34A);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            font-size: 14px;
            transition: all 0.3s;
            justify-content: center;
        }
        
        #amily2_refresh_models:hover {
            background: linear-gradient(to right, #43A047, #7CB342);
        }
        
        #amily2_refresh_models:disabled {
            background: #9E9E9E;
            cursor: not-allowed;
            opacity: 0.7;
        }
        
        /* 按钮脉冲动画 */
        .pulse {
            animation: pulseAnimation 0.6s ease;
        }
        
        @keyframes pulseAnimation {
            0% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(76, 175, 80, 0); }
            100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0); }
        }
        
        /* 旋转动画 */
        .fa-spinner {
            animation: spin 1.5s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        #amily2_model_notes {
            margin-top: 8px;
            font-size: 0.85em;
            color: #aaa;
            min-height: 1.2em;
        }
        
        #auth_panel {
            background: linear-gradient(135deg, #1a237e, #4a148c);
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            color: #ffffff;
            position: relative;
            overflow: hidden;
            transform: perspective(1000px) rotateX(5deg);
            transition: all 0.5s ease;
        }
        
        #auth_panel:before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle at center, rgba(255,255,255,0.1) 0%, transparent 70%);
            animation: rotate 20s linear infinite;
        }
        
        .auth-header {
            position: relative;
            z-index: 2;
            text-align: center;
            margin-bottom: 20px;
        }
        .auth-title {
            font-size: 1.8rem;
            font-weight: 700;
            margin-bottom: 5px;
            background: linear-gradient(to right, #ff9800, #ff5722);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            text-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
        .auth-subtitle {
            font-size: 1rem;
            color: #e0e0e0;
            margin-bottom: 15px;
        }
        .auth-code-input {
            position: relative;
            z-index: 2;
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
        }
        #auth_input {
            flex: 1;
            padding: 15px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.15);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: white;
            font-size: 1.1rem;
            backdrop-filter: blur(5px);
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            transition: all 0.3s ease;
        }
        
        #auth_input:focus {
            background: rgba(255, 255, 255, 0.25);
            border-color: #ff9800;
            outline: none;
            box-shadow: 0 4px 15px rgba(255,152,0,0.3);
        }
        #auth_submit {
            background: linear-gradient(to right, #ff9800, #ff5722);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 0 25px;
            cursor: pointer;
            font-weight: 600;
            box-shadow: 0 4px 10px rgba(255,152,0,0.4);
            transition: all 0.3s ease;
        }
        
        #auth_submit:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 15px rgba(255,152,0,0.5);
        }
        
        .auth-footer {
            position: relative;
            z-index: 2;
            text-align: center;
            margin-top: 15px;
            font-size: 0.9rem;
            color: #bdbdbd;
        }
        
        .auth-status {
            background: rgba(0, 0, 0, 0.3);
            padding: 8px 15px;
            border-radius: 6px;
            font-weight: 500;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .valid {
            color: #76ff03;
            border-left: 3px solid #76ff03;
        }
        
        .expired {
            color: #ff5252;
            border-left: 3px solid #ff5252;
        }
        
        .plugin-features {
            display: none;
            background: rgba(30,30,46,0.8);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            margin-bottom: 20px;
        }
        
        @keyframes rotate {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
}
