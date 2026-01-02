import { extensionName } from "../../utils/settings.js";
import { AgentManager } from "./agent-manager.js";
import { characters, this_chid, saveSettingsDebounced, getCharacters } from "/script.js";
import { world_names } from "/scripts/world-info.js";
import { getApiConfig, setApiConfig, testConnection, fetchModels } from "./api.js";
import { tools } from "./tools.js";

const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

let isInitialized = false;
let agentManager = null;
let previousCharData = {};
let previousWorldData = {};
let isWaitingForApproval = false;
let openedFiles = new Map(); 
let activeFileId = null;
let promptLogContent = "=== Prompt Log ===\n\n";

export async function openAutoCharCardWindow() {
    if ($('#acc-window').length > 0) {
        $('#acc-window').show();
        return;
    }

    if (!$('#acc-style').length) {
        $('<link>')
            .attr('id', 'acc-style')
            .attr('rel', 'stylesheet')
            .attr('type', 'text/css')
            .attr('href', `${extensionFolderPath}/assets/auto-char-card/style.css`)
            .appendTo('head');
    }

    try {
        const htmlContent = await $.get(`${extensionFolderPath}/assets/auto-char-card/index.html`);
        $('body').append(htmlContent);
        
        bindEvents();
        
        agentManager = new AgentManager();
        
        try {
            populateDropdowns();
            loadApiSettings();
        } catch (dataError) {
            console.error('[Amily2 AutoCharCard] Failed to load data:', dataError);
            toastr.warning('数据加载部分失败，请检查控制台。');
        }
        
        isInitialized = true;
        console.log('[Amily2 AutoCharCard] Window initialized.');
    } catch (error) {
        console.error('[Amily2 AutoCharCard] Failed to initialize window:', error);
        toastr.error(`无法加载自动构建器界面: ${error.message}`);
        $('#acc-window').remove();
    }
}

function populateDropdowns() {
    const charSelect = $('#acc-target-char');
    const prevCharId = charSelect.val();

    charSelect.empty().append('<option value="">-- 请选择 --</option>');
    charSelect.append('<option value="new">新建角色卡</option>');

    let isPrevCharStillPresent = false;
    characters.forEach((char, index) => {
        if (char) {
            charSelect.append($('<option>').val(index).text(char.name));
            if (String(index) === prevCharId) {
                isPrevCharStillPresent = true;
            }
        }
    });

    if (isPrevCharStillPresent) {
        charSelect.val(prevCharId);
    } else if (this_chid !== undefined) {
        charSelect.val(this_chid);
    }

    const worldSelect = $('#acc-target-world');
    const prevWorldName = worldSelect.val();

    worldSelect.empty().append('<option value="">-- 请选择 --</option>');
    worldSelect.append('<option value="new">新建世界书</option>');

    let isPrevWorldStillPresent = false;
    world_names.forEach(name => {
        worldSelect.append($('<option>').val(name).text(name));
        if (name === prevWorldName) {
            isPrevWorldStillPresent = true;
        }
    });

    if (isPrevWorldStillPresent) {
        worldSelect.val(prevWorldName);
    }
}

async function handleContextUpdate(type, value) {
    console.log(`[Amily2 AutoCharCard] Context Update: ${type} -> ${value}`);
    
    if (type === 'char') {
        await getCharacters(); 
    }
    
    populateDropdowns(); 
    
    if (type === 'char') {
        $('#acc-target-char').val(value);
    } else if (type === 'world') {
        $('#acc-target-world').val(value);
    }
}

function handlePromptLog(messages) {
    const userType = localStorage.getItem("plugin_user_type");
    if (userType !== "3") return;

    const timestamp = new Date().toLocaleTimeString();
    let logEntry = `\n\n--- [${timestamp}] New Request ---\n`;
    
    messages.forEach(msg => {
        logEntry += `\n[${msg.role.toUpperCase()}]\n${msg.content}\n`;
    });
    
    promptLogContent += logEntry;
    
    
    if (openedFiles.has('debug-prompt-log')) {
        const file = openedFiles.get('debug-prompt-log');
        file.content = promptLogContent;
        if (activeFileId === 'debug-prompt-log') {
            renderEditor();
        }
    }
}

function renderRulesList() {
    const list = $('#acc-rules-list');
    list.empty();

    if (!agentManager || !agentManager.contextManager) return;

    const rules = agentManager.contextManager.rules;
    if (rules.length === 0) {
        list.append('<div class="acc-empty-state" style="padding: 10px;">暂无规则</div>');
        return;
    }

    rules.forEach((rule, index) => {
        const item = $('<div>').addClass('acc-rule-item').css({
            'background': 'rgba(0,0,0,0.1)',
            'padding': '5px',
            'margin-bottom': '5px',
            'border-radius': '4px',
            'display': 'flex',
            'justify-content': 'space-between',
            'align-items': 'center'
        });

        const text = $('<span>').text(`${rule.keyword ? `[${rule.keyword}] ` : ''}${rule.content}`);
        const delBtn = $('<button>').addClass('acc-btn-danger').html('<i class="fas fa-trash"></i>').css({
            'padding': '2px 5px',
            'font-size': '12px'
        });

        delBtn.on('click', () => {
            agentManager.contextManager.rules.splice(index, 1);
            renderRulesList();
        });

        item.append(text).append(delBtn);
        list.append(item);
    });
}

function loadApiSettings() {
    const executorConfig = getApiConfig('executor');
    $('#acc-executor-url').val(executorConfig.apiUrl);
    $('#acc-executor-key').val(executorConfig.apiKey);
    $('#acc-executor-max-tokens').val(executorConfig.maxTokens || 4000);
    
    const executorModelSelect = $('#acc-executor-model');
    if (executorConfig.model) {
        if (executorModelSelect.find(`option[value="${executorConfig.model}"]`).length === 0) {
            executorModelSelect.append(new Option(executorConfig.model, executorConfig.model));
        }
        executorModelSelect.val(executorConfig.model);
    }
}

function bindEvents() {
    const windowEl = $('#acc-window');
    const minIcon = $('#acc-minimized-icon');

    $('#acc-file-selector').on('change', async function() {
        const val = $(this).val();
        if (!val) return;

        const [type, id, subId] = val.split('|');
        
        if (type === 'debug' && id === 'log') {
            const userType = localStorage.getItem("plugin_user_type");
            if (userType !== "3") {
                toastr.warning('权限不足：仅开发者可查看调试日志。');
                $(this).val('');
                return;
            }

            const fileId = 'debug-prompt-log';
            openedFiles.set(fileId, {
                title: 'Prompt Log',
                content: promptLogContent,
                type: 'log',
                metadata: null
            });
            activeFileId = fileId;
            renderEditor();
            $(this).val('');
            return;
        }

        if (type === 'char') {
            const chid = id;
            const field = subId;
            
            
            const fileId = `char-${chid}-${field}`;
            if (openedFiles.has(fileId)) {
                activeFileId = fileId;
                renderEditor();
                return;
            }

            
            
            let content = '';
            
            
            
            
            try {
                console.log(`[AutoCharCard] Reading char ${chid}, field ${field}`);
                const charData = await tools.read_character_card({ chid });
                const response = JSON.parse(charData);
                
                if (response.status !== 'success' || !response.data) {
                    throw new Error(response.message || 'Unknown error');
                }
                
                const char = response.data;
                previousCharData = char;
                console.log(`[AutoCharCard] Char data:`, char);
                
                if (field.startsWith('greeting_')) {
                    const index = parseInt(field.split('_')[1]);
                    content = char.alternate_greetings[index];
                } else {
                    content = char[field];
                }
                console.log(`[AutoCharCard] Content for ${field}:`, content);
            } catch (e) {
                console.error(e);
                toastr.error('无法读取角色卡内容');
                return;
            }

            openedFiles.set(fileId, {
                title: field.startsWith('greeting_') ? `Greeting #${field.split('_')[1]}` : field,
                content: content || '',
                type: 'normal',
                metadata: { type: 'char', chid, field }
            });
            activeFileId = fileId;
            renderEditor();

        } else if (type === 'wi') {
            const bookName = id;
            const uid = subId;
            
            const fileId = `wi-${bookName}-${uid}`;
            if (openedFiles.has(fileId)) {
                activeFileId = fileId;
                renderEditor();
                return;
            }

            try {
                const entryData = await tools.read_world_entry({ book_name: bookName, uid: uid });
                const response = JSON.parse(entryData);
                
                if (response.status !== 'success' || !response.data) {
                    throw new Error(response.message || 'Unknown error');
                }
                
                const entry = response.data;
                
                let keys = entry.key;
                if (Array.isArray(keys)) keys = keys.join(', ');

                openedFiles.set(fileId, {
                    title: `WI: ${keys}`,
                    content: entry.content,
                    type: 'normal',
                    metadata: { type: 'wi', bookName, uid }
                });
                activeFileId = fileId;
                renderEditor();
            } catch (e) {
                console.error(e);
                toastr.error('无法读取世界书条目');
            }
        }
        
        
        $(this).val('');
    });

    $('#acc-close-btn').on('click', () => {
        if (confirm('确定要关闭自动构建器吗？当前任务可能会丢失。')) {
            windowEl.remove();
            minIcon.hide();
            isInitialized = false;
            agentManager = null;
        }
    });

    $('#acc-minimize-btn').on('click', () => {
        windowEl.hide(); 
        minIcon.show();
    });

    minIcon.on('click', () => {
        minIcon.hide();
        windowEl.show();
        minIcon.find('.acc-notification-dot').hide();
    });

    $('#acc-send-btn').on('click', handleSendMessage);
    $('#acc-user-input').on('keypress', (e) => {
        if (e.which === 13 && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });

    $('#acc-stop-btn').on('click', () => {
        if (agentManager) {
            agentManager.stop();
            toastr.info('已请求停止生成');
            $('#acc-stop-btn').hide();
            $('#acc-status-indicator').removeClass('status-working').addClass('status-idle').text('已停止');
            $('#acc-send-btn').prop('disabled', false);
        }
    });

    $('#acc-require-approval').on('change', function() {
        if (agentManager) {
            agentManager.setApprovalRequired($(this).is(':checked'));
        }
    });

    

    
    const previewHeader = $('.acc-right-panel .acc-panel-header');
    if (previewHeader.find('#acc-refresh-preview').length === 0) {
        const refreshBtn = $('<button>')
            .attr('id', 'acc-refresh-preview')
            .addClass('acc-control-btn')
            .attr('title', '加载当前所有文件')
            .html('<i class="fas fa-sync-alt"></i>')
            .css({ 'margin-left': 'auto', 'font-size': '12px' });
        
        previewHeader.append(refreshBtn);
        
        refreshBtn.on('click', () => {
            loadContextToEditor();
            toastr.info('已加载当前角色和世界书内容');
        });
    }
    
    $('#acc-rules-toggle').on('click', function() {
        const content = $('#acc-rules-content');
        const icon = $(this).find('.fa-chevron-down, .fa-chevron-up');
        if (content.is(':visible')) {
            content.slideUp();
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            content.slideDown();
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    $('#acc-add-rule-btn').on('click', () => {
        const input = $('#acc-new-rule-input');
        const val = input.val().trim();
        if (!val) return;

        const parts = val.split('|');
        let keyword = null;
        let content = val;

        if (parts.length > 1) {
            keyword = parts[0].trim();
            content = parts.slice(1).join('|').trim();
        }

        if (agentManager && agentManager.contextManager) {
            agentManager.contextManager.addRule({ keyword, content });
            renderRulesList();
            input.val('');
            toastr.success('规则已添加');
        }
    });

    $('#acc-api-settings-toggle').on('click', function() {
        const content = $('#acc-api-settings-content');
        const icon = $(this).find('.fa-chevron-down, .fa-chevron-up');
        if (content.is(':visible')) {
            content.slideUp();
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            content.slideDown();
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    $('#acc-save-api').on('click', () => {
        const execMaxTokens = parseInt($('#acc-executor-max-tokens').val());

        const executorConfig = {
            apiUrl: $('#acc-executor-url').val().trim(),
            apiKey: $('#acc-executor-key').val().trim(),
            model: $('#acc-executor-model').val() || '',
            maxTokens: isNaN(execMaxTokens) ? 0 : execMaxTokens 
        };

        setApiConfig('executor', executorConfig);
        saveSettingsDebounced();
        toastr.success('API 配置已保存');
    });

    const handleRefreshModels = async (role) => {
        const urlInput = $(`#acc-${role}-url`);
        const keyInput = $(`#acc-${role}-key`);
        const select = $(`#acc-${role}-model`);
        const btn = $(`#acc-${role}-refresh-models`);

        const apiUrl = urlInput.val().trim();
        const apiKey = keyInput.val().trim();

        if (!apiUrl) {
            toastr.warning('请先输入 API URL');
            return;
        }

        const originalIcon = btn.html();
        btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>');
        select.empty().append('<option value="">加载中...</option>');

        try {
            const models = await fetchModels(apiUrl, apiKey);
            select.empty().append('<option value="">-- 请选择模型 --</option>');
            
            if (models.length === 0) {
                select.append('<option value="" disabled>未找到模型</option>');
            } else {
                models.forEach(model => {
                    select.append(new Option(model, model));
                });
                toastr.success(`成功获取 ${models.length} 个模型`);
            }
        } catch (error) {
            console.error(`[AutoCharCard] Failed to fetch models for ${role}:`, error);
            toastr.error(`获取模型失败: ${error.message}`);
            select.empty().append('<option value="">获取失败</option>');
        } finally {
            btn.prop('disabled', false).html(originalIcon);
        }
    };

    $('#acc-executor-refresh-models').on('click', () => handleRefreshModels('executor'));

    $('#acc-executor-test').on('click', async function() {
        const btn = $(this);
        btn.prop('disabled', true).text('测试中...');
        const result = await testConnection('executor');
        btn.prop('disabled', false).text('测试连接');
        if (result.success) {
            toastr.success('连接成功');
        } else {
            toastr.error(`连接失败: ${result.error || '未知错误'}`);
        }
    });

    
    $('.acc-nav-btn').on('click', function() {
        const targetClass = $(this).data('target');
        
        
        $('.acc-nav-btn').removeClass('active');
        $(this).addClass('active');
        
        
        $('.acc-column').removeClass('mobile-active');
        $(`.${targetClass}`).addClass('mobile-active');
    });

    
    if (window.innerWidth <= 768) {
        $('.acc-center-panel').addClass('mobile-active');
    }
}

async function handleSendMessage() {
    const input = $('#acc-user-input');
    const message = input.val().trim();
    
    if (isWaitingForApproval) {
        if (!agentManager) return;
        
        isWaitingForApproval = false;
        
        const btn = $('#acc-send-btn');
        btn.html('<i class="fas fa-paper-plane"></i>');
        btn.prop('title', '发送');
        btn.removeClass('acc-btn-success');
        $('#acc-reject-btn').remove(); 
        
        input.attr('placeholder', '描述您的需求...');
        input.val('');
        
        if (message) {
            
            addMessage('user', message); 
            await agentManager.resumeWithApproval(
                false, 
                message, 
                (content, role) => addMessage(role, content),
                updatePreview,
                showApprovalRequest,
                handleContextUpdate,
                handlePromptLog
            );
        } else {
            
            await agentManager.resumeWithApproval(
                true, 
                null, 
                (content, role) => addMessage(role, content),
                updatePreview,
                showApprovalRequest,
                handleContextUpdate,
                handlePromptLog
            );
        }
        return;
    }

    if (!message) return;

    if (!agentManager) {
        toastr.error('Agent 未初始化');
        return;
    }

    const selectedCharId = $('#acc-target-char').val();
    const selectedWorld = $('#acc-target-world').val();

    if (!selectedCharId && selectedCharId !== '0') { 
        toastr.warning('请先选择一个目标角色（或选择新建）');
        return;
    }

    addMessage('user', message);
    input.val('');
    
    $('#acc-send-btn').prop('disabled', true);
    $('#acc-status-indicator').removeClass('status-idle').addClass('status-working').text('工作中...');

    try {
        agentManager.setContext(selectedCharId, selectedWorld);
        agentManager.setApprovalRequired($('#acc-require-approval').is(':checked'));
        $('#acc-stop-btn').show();
        
        await agentManager.handleUserMessage(
            message, 
            (content, role) => {
                addMessage(role, content);
            },
            updatePreview,
            showApprovalRequest,
            handleContextUpdate,
            handlePromptLog
        );
    } catch (error) {
        console.error('Agent Error:', error);
        addMessage('system', `[Error] 发生错误: ${error.message}`);
    } finally {
        $('#acc-send-btn').prop('disabled', false);
        $('#acc-stop-btn').hide();
        $('#acc-status-indicator').removeClass('status-working').addClass('status-idle').text('空闲');
    }
}

function showApprovalRequest(toolName, args) {
    isWaitingForApproval = true;
    
    
    updatePreview(toolName, args, false);

    
    const btn = $('#acc-send-btn');
    btn.html('<i class="fas fa-check"></i>');
    btn.prop('title', '批准执行');
    btn.addClass('acc-btn-success');
    $('#acc-user-input').attr('placeholder', '输入反馈以修改，或点击 √ 批准，点击 X 拒绝...');

    
    if ($('#acc-reject-btn').length === 0) {
        const rejectBtn = $('<button>')
            .attr('id', 'acc-reject-btn')
            .addClass('acc-btn-danger')
            .html('<i class="fas fa-times"></i>')
            .attr('title', '拒绝执行')
            .css({
                'margin-right': '5px',
                'width': '40px',
                'height': '40px',
                'border-radius': '50%',
                'border': 'none',
                'cursor': 'pointer',
                'display': 'flex',
                'align-items': 'center',
                'justify-content': 'center'
            });
        
        rejectBtn.insertBefore(btn);
        
        rejectBtn.on('click', async () => {
            if (!isWaitingForApproval) return;
            isWaitingForApproval = false;
            
            const input = $('#acc-user-input');
            const message = input.val().trim();
            
            
            btn.html('<i class="fas fa-paper-plane"></i>');
            btn.prop('title', '发送');
            btn.removeClass('acc-btn-success');
            rejectBtn.remove();
            input.attr('placeholder', '描述您的需求...');
            input.val('');

            
            updatePreview(toolName, args, false, true);

            const feedback = message || "用户拒绝了操作。";
            addMessage('user', `[拒绝] ${feedback}`);

            await agentManager.resumeWithApproval(
                false, 
                feedback, 
                (content, role) => addMessage(role, content),
                updatePreview,
                showApprovalRequest,
                handleContextUpdate,
                handlePromptLog
            );
        });
    }

    
    const toolDisplay = `
        <div class="acc-tool-request">
            <details>
                <summary class="acc-tool-header" style="cursor: pointer;">
                    <i class="fas fa-code"></i> 请求执行: ${toolName}
                    <span style="float: right; font-size: 10px; color: #888;">(点击展开)</span>
                </summary>
                <pre class="acc-tool-content">${JSON.stringify(args, null, 2)}</pre>
            </details>
        </div>
    `;
    addMessage('system', toolDisplay);
}

function addMessage(role, content) {
    const stream = $('#acc-chat-stream');
    
    if (role === 'stream-assistant') {
        let lastMsg = stream.children().last();
        
        if (!lastMsg.hasClass('assistant') || !lastMsg.hasClass('acc-streaming')) {
            
            
            const msgDiv = $('<div>').addClass('acc-message assistant acc-streaming');
            const avatarDiv = $('<div>').addClass('acc-avatar').html('<i class="fas fa-robot" style="color: #4caf50;"></i>');
            const contentDiv = $('<div>').addClass('acc-message-content');
            msgDiv.append(avatarDiv).append(contentDiv);
            stream.append(msgDiv);
            lastMsg = msgDiv;
        }
        
        const contentDiv = lastMsg.find('.acc-message-content');
        
        
        const escapedContent = content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    
            .replace(/'/g, "&#039;")
            .replace(/\n/g, '<br>');
            
        contentDiv.append(escapedContent);
        stream.scrollTop(stream[0].scrollHeight);
        return;
    }

    let displayContent = content;
    if (role === 'executor' || role === 'assistant') {
        
        
        displayContent = displayContent
            .replace(/<thinking(?:\s+[^>]*)?>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<\/thinking>/gi, '') 
            .replace(/<tool_code(?:\s+[^>]*)?>[\s\S]*?<\/tool_code>/gi, '')
            .trim();

        const tools = [
            'read_world_info', 'read_world_entry', 'write_world_info_entry', 'create_world_book',
            'read_character_card', 'update_character_card', 'edit_character_text',
            'edit_world_info_entry',
            'manage_first_message', 'use_tool'
        ];
        
        const regex = new RegExp(`<(${tools.join('|')})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi');
        displayContent = displayContent.replace(regex, '').trim();
        
        if (!displayContent && role === 'executor') {
            displayContent = "<i>(正在执行操作...)</i>";
        }

        
        if (role === 'assistant') {
            stream.find('.acc-streaming').remove();
        }
    }

    let formattedContent;
    
    
    if (displayContent.trim().startsWith('<div class="acc-tool-request"')) {
        formattedContent = displayContent;
    } else {
        formattedContent = parseMarkdown(displayContent);
    }

    const msgDiv = $('<div>').addClass(`acc-message ${role}`);
    
    const avatarDiv = $('<div>').addClass('acc-avatar');
    if (role === 'user') {
        avatarDiv.html('<i class="fas fa-user"></i>');
    } else if (role === 'assistant') {
        avatarDiv.html('<i class="fas fa-robot" style="color: #4caf50;"></i>'); 
    } else if (role === 'thought') {
        avatarDiv.html('<i class="fas fa-brain" style="color: #9c27b0;"></i>'); 
    } else if (role === 'executor') {
        avatarDiv.html('<i class="fas fa-robot" style="color: #4caf50;"></i>'); 
    } else if (role === 'system') {
        avatarDiv.html('<i class="fas fa-info-circle"></i>');
    }

    const contentDiv = $('<div>').addClass('acc-message-content');
    
    if (role === 'thought') {
        msgDiv.addClass('acc-thought-message');
        contentDiv.css({
            'font-style': 'italic',
            'color': '#aaa',
            'font-size': '0.9em'
        });
    }

    msgDiv.append(avatarDiv);
    msgDiv.append(contentDiv);
    stream.append(msgDiv);

    contentDiv.html(formattedContent);
    stream.scrollTop(stream[0].scrollHeight);
}

function parseMarkdown(text) {
    if (!text) return '';

    
    let html = text
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">");

    
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    
    html = html.replace(/^#### (.*$)/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    
    html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');

    
    html = html.replace(/^[\*\-]{3,}$/gm, '<hr>');

    
    
    html = html.replace(/^\s*[\-\*]\s+(.*$)/gm, '<li>$1</li>');
    
    
    
    
    
    
    
    
    
    html = html.replace(/\n/g, '<br>');

    return html;
}

function renderEditor() {
    const container = $('#acc-preview-container');
    const tabsContainer = $('.acc-preview-tabs');
    
    
    
    
    
    container.empty();
    tabsContainer.empty();

    if (openedFiles.size === 0) {
        container.html('<div class="acc-empty-state"><i class="fas fa-file-alt"></i><p>暂无内容</p></div>');
        return;
    }

    
    if (!activeFileId || !openedFiles.has(activeFileId)) {
        activeFileId = openedFiles.keys().next().value;
    }

    openedFiles.forEach((file, id) => {
        const isActive = id === activeFileId;
        
        const tabBtn = $('<button>')
            .addClass(`acc-tab-btn ${isActive ? 'active' : ''}`)
            .attr('title', file.title)
            .on('click', () => {
                activeFileId = id;
                renderEditor(); 
            });

        const icon = $('<i class="fas fa-file-alt"></i>');
        const titleSpan = $('<span>').addClass('acc-tab-title').text(file.title);
        
        
        const closeBtn = $('<span>')
            .html('&times;')
            .addClass('acc-tab-close')
            .on('click', (e) => {
                e.stopPropagation();
                openedFiles.delete(id);
                if (activeFileId === id) activeFileId = null;
                renderEditor();
            });
        
        tabBtn.append(icon).append(titleSpan).append(closeBtn);
        tabsContainer.append(tabBtn);

        if (isActive) {
            const contentDiv = $('<div>')
                .addClass('acc-editor-content')
                .css('display', 'flex')
                .css('flex-direction', 'column')
                .css('height', '100%');

            
            const toolbar = $('<div>').addClass('acc-editor-toolbar').css({
                'padding': '5px',
                'border-bottom': '1px solid #444',
                'display': 'flex',
                'justify-content': 'flex-end',
                'gap': '10px'
            });

            const saveBtn = $('<button>')
                .addClass('acc-btn-primary')
                .html('<i class="fas fa-save"></i> 保存')
                .on('click', () => saveFile(id));
            
            toolbar.append(saveBtn);


            contentDiv.append(toolbar);

            if (file.type === 'diff-view') {
                const editorDiv = $('<div>')
                    .addClass('acc-editor-diff-view')
                    .css({
                        'flex': '1',
                        'width': '100%',
                        'background': '#1e1e1e',
                        'color': '#d4d4d4',
                        'padding': '10px',
                        'font-family': 'monospace',
                        'overflow-y': 'auto',
                        'white-space': 'pre-wrap'
                    });
                
                if (file.segments) {
                    file.segments.forEach((segment) => {
                        if (segment.type === 'text') {
                            editorDiv.append($('<span>').text(segment.content));
                        } else if (segment.type === 'change') {
                            const container = $('<div>').addClass('acc-diff-container').css({
                                'display': 'block',
                                'margin': '10px 0',
                                'border': '1px solid #444',
                                'padding': '5px',
                                'border-radius': '4px'
                            });
                            
                            const renderChange = () => {
                                container.empty();
                                if (segment.active) {
                                    const removed = $('<div>')
                                        .text(segment.original)
                                        .css({
                                            'background-color': 'rgba(255, 0, 0, 0.2)',
                                            'cursor': 'pointer',
                                            'padding': '5px',
                                            'margin-bottom': '2px',
                                            'white-space': 'pre-wrap',
                                            'color': '#d4d4d4'
                                        })
                                        .attr('title', '点击恢复 (Click to restore)');
                                    
                                    const added = $('<div>')
                                        .attr('contenteditable', 'true')
                                        .css({
                                            'background-color': 'rgba(0, 255, 0, 0.2)',
                                            'cursor': 'text',
                                            'padding': '5px',
                                            'white-space': 'pre-wrap',
                                            'color': '#d4d4d4',
                                            'outline': 'none'
                                        })
                                        .attr('title', '点击编辑');
                                    
                                    const toggle = () => {
                                        segment.active = false;
                                        renderChange();
                                        if (agentManager) {
                                            const newDiff = reconstructDiff(file.segments);
                                            agentManager.updatePendingToolArgs({ diff: newDiff });
                                        }
                                    };
                                    
                                    removed.on('click', toggle);
                                    
                                    added.on('input', function() {
                                        segment.new = $(this).text();
                                        if (agentManager) {
                                            const newDiff = reconstructDiff(file.segments);
                                            agentManager.updatePendingToolArgs({ diff: newDiff });
                                        }
                                    });
                                    
                                    container.append(removed).append(added);
                                } else {
                                    
                                    const restored = $('<div>')
                                        .text(segment.original)
                                        .css({
                                            'cursor': 'pointer',
                                            'border-left': '3px solid #666',
                                            'padding': '5px',
                                            'white-space': 'pre-wrap',
                                            'opacity': '0.7'
                                        })
                                        .attr('title', '点击重新应用修改 (Click to re-apply change)');
                                    
                                    restored.on('click', () => {
                                        segment.active = true;
                                        renderChange();
                                        if (agentManager) {
                                            const newDiff = reconstructDiff(file.segments);
                                            agentManager.updatePendingToolArgs({ diff: newDiff });
                                        }
                                    });
                                    
                                    container.append(restored);
                                }
                            };
                            
                            renderChange();
                            editorDiv.append(container);
                        }
                    });
                } else {
                    editorDiv.text('Error: No segments found for diff view.');
                }
                
                contentDiv.append(editorDiv);
            } else {
                
                const textarea = $('<textarea>')
                    .addClass('acc-editor-textarea')
                    .val(file.content)
                    .css({
                        'flex': '1',
                        'width': '100%',
                        'background': '#1e1e1e',
                        'color': '#d4d4d4',
                        'border': 'none',
                        'padding': '10px',
                        'font-family': 'monospace',
                        'resize': 'none',
                        'outline': 'none'
                    })
                    .on('input', function() {
                        file.content = $(this).val();
                    });
                
                contentDiv.append(textarea);
            }
            
            container.append(contentDiv);
        }
    });
}

async function saveFile(id) {
    const file = openedFiles.get(id);
    if (!file) return;

    const meta = file.metadata;
    if (!meta) {
        toastr.warning('该文件无法保存（缺少元数据）');
        return;
    }

    let contentToSave = file.content;
    if (file.type === 'diff-view' && file.segments) {
        contentToSave = file.segments.map(seg => {
            if (seg.type === 'text') return seg.content;
            if (seg.type === 'change') {
                return seg.active ? seg.new : seg.original;
            }
            return '';
        }).join('');
    }

    try {
        let result;
        if (meta.type === 'char') {
            if (meta.field.startsWith('greeting_')) {
                const index = parseInt(meta.field.split('_')[1]);
                
                
                result = await tools.manage_first_message({
                    action: 'update',
                    chid: meta.chid,
                    index: index + 1,
                    message: contentToSave
                });
            } else {
                result = await tools.update_character_card({
                    chid: meta.chid,
                    [meta.field]: contentToSave
                });
            }
        } else if (meta.type === 'wi') {
            
            
            
            
            
            
            
            if (meta.uid !== undefined) {
                result = await tools.write_world_info_entry({
                    book_name: meta.bookName,
                    entries: [{ uid: meta.uid, content: contentToSave }]
                });
            } else {
                
                
                try {
                    const entry = JSON.parse(contentToSave);
                    result = await tools.write_world_info_entry({
                        book_name: meta.bookName,
                        entries: [entry]
                    });
                } catch (e) {
                    
                    
                    toastr.error('保存失败: 内容必须是有效的 JSON (针对新建条目) 或包含 UID');
                    return;
                }
            }
        }

        if (result && !result.startsWith('Error') && !result.includes('失败')) {
            toastr.success('保存成功');

            
            if (file.type === 'diff-view') {
                file.type = 'normal';
                delete file.segments;
                
                file.content = contentToSave;
                renderEditor();
            }
        } else {
            toastr.error(result || '保存失败');
        }
    } catch (e) {
        console.error('Save failed:', e);
        toastr.error(`保存异常: ${e.message}`);
    }
}

async function loadContextToEditor() {
    const chid = $('#acc-target-char').val();
    const bookName = $('#acc-target-world').val();
    const selector = $('#acc-file-selector');
    
    selector.empty().append('<option value="">-- 选择文件 --</option>');

    if (chid && chid !== 'new') {
        try {
            const charData = await tools.read_character_card({ chid });
            const response = JSON.parse(charData);
            
            if (response.status !== 'success' || !response.data) {
                console.error("Failed to read character:", response);
                return;
            }
            
            const char = response.data;
            previousCharData = char; 

            const charGroup = $('<optgroup label="角色卡字段">');
            const fields = ['description', 'personality', 'first_mes', 'scenario', 'mes_example'];
            fields.forEach(field => {
                charGroup.append(`<option value="char|${chid}|${field}">${field}</option>`);
            });
            
            if (char.alternate_greetings && char.alternate_greetings.length > 0) {
                char.alternate_greetings.forEach((_, index) => {
                    charGroup.append(`<option value="char|${chid}|greeting_${index}">开场白 #${index + 1}</option>`);
                });
            }
            selector.append(charGroup);

            
            const userType = localStorage.getItem("plugin_user_type");
            if (userType === "3") {
                selector.append('<option value="debug|log">Debug: Prompt Log</option>');
            }

            
            if (openedFiles.size === 0 && char.description) {
                const id = `char-${chid}-description`;
                openedFiles.set(id, {
                    title: 'description',
                    content: char.description,
                    type: 'normal',
                    metadata: { type: 'char', chid, field: 'description' }
                });
                activeFileId = id;
            }

        } catch (e) {
            console.error("Failed to load character for editor:", e);
        }
    }

    if (bookName && bookName !== 'new') {
        try {
            
            const indexData = await tools.read_world_info({ book_name: bookName, return_full: false });
            const index = JSON.parse(indexData);
            
            const wiGroup = $('<optgroup label="世界书条目">');
            if (index.entries) {
                index.entries.forEach(entry => {
                    const name = entry.comment || entry.keys || `Entry ${entry.uid}`;
                    wiGroup.append(`<option value="wi|${bookName}|${entry.uid}">${name}</option>`);
                });
            }
            selector.append(wiGroup);

        } catch (e) {
            console.error("Failed to load world info for editor:", e);
        }
    }

    renderEditor();
}

async function updatePreview(toolName, args, isPartial = false, isExecuted = false) {
    let chid = args.chid;
    if (chid === undefined || chid === null || chid === '') {
        chid = $('#acc-target-char').val();
    }
    chid = String(chid);

    let bookName = args.book_name;
    if (bookName === undefined || bookName === null || bookName === '') {
        bookName = $('#acc-target-world').val();
    }
    bookName = String(bookName);

    if (toolName === 'update_character_card') {
        const fields = ['description', 'personality', 'first_mes', 'scenario', 'mes_example'];
        fields.forEach(field => {
            let content = args[field];
            if (args.updates && args.updates[field]) content = args.updates[field];
            
            if (content !== undefined) {
                const id = `char-${chid}-${field}`;
                openedFiles.set(id, {
                    title: field,
                    content: content,
                    type: 'normal',
                    metadata: { type: 'char', chid, field }
                });
                activeFileId = id;
            }
        });

    } else if (toolName === 'edit_character_text') {
        const field = args.field || 'Unknown Field';

        
        if (field !== 'Unknown Field') {
            const unknownDiffId = `diff-${chid}-Unknown Field`;
            if (openedFiles.has(unknownDiffId)) {
                openedFiles.delete(unknownDiffId);
            }
            
            
            const unknownId = `char-${chid}-Unknown Field`;
            if (openedFiles.has(unknownId)) {
                const file = openedFiles.get(unknownId);
                openedFiles.delete(unknownId);
                file.title = field;
                file.metadata.field = field;
                openedFiles.set(id, file); 
                if (activeFileId === unknownId) activeFileId = id;
            }
        }

        const diff = args.diff || '';
        const id = `char-${chid}-${field}`;
        
        if (isPartial) {
            const diffId = `diff-${chid}-${field}`;
            openedFiles.set(diffId, {
                title: `Diff: ${field}`,
                content: diff,
                type: 'diff',
                metadata: null
            });
            activeFileId = diffId;
        } else if (isExecuted) {
            
            let success = false;
            let content = '';

            try {
                const charData = await tools.read_character_card({ chid });
                const response = JSON.parse(charData);
                if (response.status === 'success' && response.data) {
                    const char = response.data;
                    if (field.startsWith('greeting_')) {
                        const index = parseInt(field.split('_')[1]);
                        content = char.alternate_greetings[index];
                    } else {
                        content = char[field];
                    }
                    success = true;
                }
            } catch (e) {
                console.error("Failed to refresh content after edit", e);
            }

            openedFiles.delete(`diff-${chid}-${field}`);

            
            if (!openedFiles.has(id)) {
                for (const [key, val] of openedFiles) {
                    if (val.metadata && val.metadata.chid == chid && val.metadata.field == field) {
                        id = key;
                        break;
                    }
                }
            }

            
            
            let foundAndFixed = false;
            openedFiles.forEach((file, fileId) => {
                if (file.metadata && file.metadata.chid == chid && file.metadata.field == field) {
                    if (file.type === 'diff-view') {
                        
                        if (file.segments) {
                            const newContent = file.segments.map(s => s.type === 'change' ? s.new : s.content).join('');
                            file.content = newContent;
                        }
                        file.type = 'normal';
                        delete file.segments;
                        
                        
                        if (fileId !== id) {
                            openedFiles.delete(fileId);
                            openedFiles.set(id, file);
                            if (activeFileId === fileId) activeFileId = id;
                        }
                        foundAndFixed = true;
                    }
                }
            });

            if (success) {
                
                
                
                
                openedFiles.set(id, {
                    title: field,
                    content: content,
                    type: 'normal',
                    metadata: { type: 'char', chid, field }
                });
                activeFileId = id;
            } else if (!foundAndFixed) {
                
                
                
                if (openedFiles.has(id)) {
                     
                     const file = openedFiles.get(id);
                     file.type = 'normal';
                     activeFileId = id;
                }
            }
            
            
            renderEditor();
        } else {
            
            let originalContent = '';
            if (openedFiles.has(id)) {
                originalContent = openedFiles.get(id).content;
            } else {
                
                try {
                    const charData = await tools.read_character_card({ chid });
                    const response = JSON.parse(charData);
                    if (response.status === 'success' && response.data) {
                        const char = response.data;
                        if (field.startsWith('greeting_')) {
                            const index = parseInt(field.split('_')[1]);
                            originalContent = char.alternate_greetings[index];
                        } else {
                            originalContent = char[field];
                        }
                    }
                } catch (e) {
                    console.error("Failed to fetch original content for diff view", e);
                }
            }

            if (originalContent) {
                const segments = parseDiff(originalContent, diff);
                openedFiles.set(id, {
                    title: field,
                    content: originalContent, 
                    segments: segments,
                    type: 'diff-view',
                    metadata: { type: 'char', chid, field }
                });
                activeFileId = id;
                openedFiles.delete(`diff-${chid}-${field}`);
            } else {
                 
                 const diffId = `diff-${chid}-${field}`;
                 openedFiles.set(diffId, {
                     title: `Diff: ${field}`,
                     content: diff,
                     type: 'diff',
                     metadata: null
                 });
                 activeFileId = diffId;
            }
        }

    } else if (toolName === 'edit_world_info_entry') {
        const uid = args.uid;

        
        if (uid !== undefined) {
            const unknownDiffId = `diff-wi-${bookName}-undefined`;
            if (openedFiles.has(unknownDiffId)) {
                openedFiles.delete(unknownDiffId);
            }
        }

        const diff = args.diff || '';
        const id = `wi-${bookName}-${uid}`;
        
        if (isPartial) {
            const diffId = `diff-wi-${bookName}-${uid}`;
            openedFiles.set(diffId, {
                title: `Diff: WI ${uid}`,
                content: diff,
                type: 'diff',
                metadata: null
            });
            activeFileId = diffId;
        } else if (isExecuted) {
            
            try {
                const entryData = await tools.read_world_entry({ book_name: bookName, uid: uid });
                const response = JSON.parse(entryData);
                if (response.status === 'success' && response.data) {
                    openedFiles.delete(`diff-wi-${bookName}-${uid}`);
                    openedFiles.delete(id); 
                    
                    openedFiles.set(id, {
                        title: `WI: ${uid}`,
                        content: response.data.content,
                        type: 'normal',
                        metadata: { type: 'wi', bookName, uid }
                    });
                    activeFileId = id;
                }
            } catch (e) {
                console.error("Failed to refresh WI content after edit", e);
            }
        } else {
            let originalContent = '';
            if (openedFiles.has(id)) {
                originalContent = openedFiles.get(id).content;
            } else {
                try {
                    const entryData = await tools.read_world_entry({ book_name: bookName, uid: uid });
                    const response = JSON.parse(entryData);
                    if (response.status === 'success' && response.data) {
                        originalContent = response.data.content;
                    }
                } catch (e) {
                    console.error("Failed to fetch original content for WI diff view", e);
                }
            }
            
            if (originalContent) {
                const segments = parseDiff(originalContent, diff);
                openedFiles.set(id, {
                    title: `WI: ${uid}`,
                    content: originalContent,
                    segments: segments,
                    type: 'diff-view',
                    metadata: { type: 'wi', bookName, uid }
                });
                activeFileId = id;
                openedFiles.delete(`diff-wi-${bookName}-${uid}`);
            } else {
                 const diffId = `diff-wi-${bookName}-${uid}`;
                 openedFiles.set(diffId, {
                     title: `Diff: WI ${uid}`,
                     content: diff,
                     type: 'diff',
                     metadata: null
                 });
                 activeFileId = diffId;
            }
        }

    } else if (toolName === 'write_world_info_entry') {
        let entries = args.entries;
        
        if (isPartial && typeof entries === 'string') {
            
            const id = `wi-raw-partial`;
            openedFiles.set(id, {
                title: 'WI Entry (Generating...)',
                content: entries,
                type: 'json',
                metadata: null
            });
            activeFileId = id;
        } else {
            if (typeof entries === 'string') {
                try { entries = JSON.parse(entries); } catch(e) {}
            }
            if (!Array.isArray(entries)) entries = [entries];

            entries.forEach(entry => {
                const keys = Array.isArray(entry.key) ? entry.key.join(', ') : (entry.key || 'New Entry');
                const uid = entry.uid || 'new';
                const id = `wi-${bookName}-${uid}`;
                
                openedFiles.set(id, {
                    title: `WI: ${keys}`,
                    content: entry.content,
                    type: 'normal',
                    metadata: { type: 'wi', bookName, uid: entry.uid }
                });
                activeFileId = id;
            });
            
            openedFiles.delete(`wi-raw-partial`);
        }
    }

    renderEditor();
}

function parseDiff(originalContent, diff) {
    const segments = [];
    let currentIndex = 0;
    
    const parts = diff.split('------- SEARCH');
    
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const split1 = part.split('=======');
        if (split1.length < 2) continue;
        
        const searchContent = split1[0].trim();
        const split2 = split1[1].split('+++++++ REPLACE');
        if (split2.length < 1) continue;
        
        const replaceContent = split2[0].trim();
        
        const foundIndex = originalContent.indexOf(searchContent, currentIndex);
        
        if (foundIndex !== -1) {
            if (foundIndex > currentIndex) {
                segments.push({
                    type: 'text',
                    content: originalContent.substring(currentIndex, foundIndex)
                });
            }
            
            segments.push({
                type: 'change',
                original: searchContent,
                new: replaceContent,
                active: true
            });
            
            currentIndex = foundIndex + searchContent.length;
        }
    }
    
    if (currentIndex < originalContent.length) {
        segments.push({
            type: 'text',
            content: originalContent.substring(currentIndex)
        });
    }
    
    return segments;
}

function reconstructDiff(segments) {
    return segments
        .filter(s => s.type === 'change' && s.active)
        .map(s => `------- SEARCH\n${s.original}\n=======\n${s.new}\n+++++++ REPLACE`)
        .join('\n');
}
