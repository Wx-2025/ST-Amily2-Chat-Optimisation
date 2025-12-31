import { extensionName } from "../../utils/settings.js";
import { AgentManager } from "./agent-manager.js";
import { characters, this_chid, saveSettingsDebounced } from "/script.js";
import { world_names } from "/scripts/world-info.js";
import { getApiConfig, setApiConfig, testConnection, fetchModels } from "./api.js";
import { tools } from "./tools.js";

const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

let isInitialized = false;
let agentManager = null;
let previousCharData = {};
let previousWorldData = {};
let isWaitingForApproval = false;
let openedFiles = new Map(); // Key: string ID, Value: { title, content, type, metadata }
let activeFileId = null;

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
    charSelect.empty().append('<option value="">-- 请选择 --</option>');
    charSelect.append('<option value="new">新建角色卡</option>');

    characters.forEach((char, index) => {
        if (char) {
            const option = $('<option>').val(index).text(char.name);
            if (index === this_chid) option.prop('selected', true);
            charSelect.append(option);
        }
    });

    const worldSelect = $('#acc-target-world');
    worldSelect.empty().append('<option value="">-- 请选择 --</option>');
    worldSelect.append('<option value="new">新建世界书</option>');

    world_names.forEach(name => {
        worldSelect.append($('<option>').val(name).text(name));
    });
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
        
        if (type === 'char') {
            const chid = id;
            const field = subId;
            
            // Check if already open
            const fileId = `char-${chid}-${field}`;
            if (openedFiles.has(fileId)) {
                activeFileId = fileId;
                renderEditor();
                return;
            }

            // Fetch content if needed (we might have it cached in previousCharData or need to fetch)
            // For simplicity, fetch again or use cache
            let content = '';
            if (previousCharData && previousCharData.name) { // Simple check if loaded
                 if (field.startsWith('greeting_')) {
                     const index = parseInt(field.split('_')[1]);
                     content = previousCharData.alternate_greetings[index];
                 } else {
                     content = previousCharData[field];
                 }
            } else {
                // Fetch
                try {
                    const charData = await tools.read_character_card({ chid });
                    const char = JSON.parse(charData);
                    previousCharData = char;
                    if (field.startsWith('greeting_')) {
                        const index = parseInt(field.split('_')[1]);
                        content = char.alternate_greetings[index];
                    } else {
                        content = char[field];
                    }
                } catch (e) {
                    toastr.error('无法读取角色卡内容');
                    return;
                }
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
                const entry = JSON.parse(entryData);
                
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
                toastr.error('无法读取世界书条目');
            }
        }
        
        // Reset selector
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

    // Removed old approval buttons handlers

    // Add Refresh Button to Preview Header if not exists
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
            maxTokens: isNaN(execMaxTokens) ? 0 : execMaxTokens // 0 means unlimited
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
}

async function handleSendMessage() {
    const input = $('#acc-user-input');
    const message = input.val().trim();
    
    if (isWaitingForApproval) {
        if (!agentManager) return;
        
        isWaitingForApproval = false;
        // Reset UI
        const btn = $('#acc-send-btn');
        btn.html('<i class="fas fa-paper-plane"></i>');
        btn.prop('title', '发送');
        btn.removeClass('acc-btn-success');
        input.attr('placeholder', '描述您的需求...');
        input.val('');
        
        if (message) {
            // User typed something -> Reject with feedback
            addMessage('user', message); // Show feedback in chat
            await agentManager.resumeWithApproval(
                false, 
                message, 
                (content, role) => addMessage(role, content),
                (toolName, args) => updatePreview(toolName, args),
                showApprovalRequest
            );
        } else {
            // Empty input -> Approve
            await agentManager.resumeWithApproval(
                true, 
                null, 
                (content, role) => addMessage(role, content),
                (toolName, args) => updatePreview(toolName, args),
                showApprovalRequest
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
            (toolName, args) => {
                updatePreview(toolName, args);
            },
            showApprovalRequest
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
    
    // Update UI to Approval Mode
    const btn = $('#acc-send-btn');
    btn.html('<i class="fas fa-check"></i>');
    btn.prop('title', '批准执行 (点击批准，或输入文字拒绝)');
    btn.addClass('acc-btn-success');
    $('#acc-user-input').attr('placeholder', '输入反馈以拒绝/修改，或直接点击右侧按钮批准...');

    // Show tool call in chat (Collapsible)
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
        // Check if the last message is a streaming assistant message
        if (!lastMsg.hasClass('assistant') || !lastMsg.hasClass('acc-streaming')) {
            // Create new message if last one wasn't a streaming assistant
            // We use 'assistant' role but add 'acc-streaming' class
            const msgDiv = $('<div>').addClass('acc-message assistant acc-streaming');
            const avatarDiv = $('<div>').addClass('acc-avatar').html('<i class="fas fa-robot" style="color: #4caf50;"></i>');
            const contentDiv = $('<div>').addClass('acc-message-content');
            msgDiv.append(avatarDiv).append(contentDiv);
            stream.append(msgDiv);
            lastMsg = msgDiv;
        }
        
        const contentDiv = lastMsg.find('.acc-message-content');
        
        // Simple escaping for stream chunks
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
        // Remove thinking blocks and tool_code wrappers for final display
        // Use case-insensitive and robust matching
        displayContent = displayContent
            .replace(/<thinking(?:\s+[^>]*)?>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<\/thinking>/gi, '') // Remove residual closing tags
            .replace(/<tool_code(?:\s+[^>]*)?>[\s\S]*?<\/tool_code>/gi, '')
            .trim();

        const tools = [
            'read_world_info', 'read_world_entry', 'write_world_info_entry', 'create_world_book',
            'read_character_card', 'update_character_card', 'edit_character_text',
            'manage_first_message', 'use_tool'
        ];
        // Match tools with potential attributes and whitespace
        const regex = new RegExp(`<(${tools.join('|')})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi');
        displayContent = displayContent.replace(regex, '').trim();
        
        if (!displayContent && role === 'executor') {
            displayContent = "<i>(正在执行操作...)</i>";
        }

        // If this is a final assistant message, remove ANY streaming message
        if (role === 'assistant') {
            stream.find('.acc-streaming').remove();
        }
    }

    let formattedContent;
    
    // Check if content is pre-formatted HTML (e.g. tool requests)
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

    // 1. Escape HTML (basic)
    let html = text
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">");

    // 2. Code Blocks (```...```)
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // 3. Inline Code (`...`)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 4. Headers
    html = html.replace(/^#### (.*$)/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    // 5. Bold & Italic
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // 6. Horizontal Rules
    html = html.replace(/^[\*\-]{3,}$/gm, '<hr>');

    // 7. Lists
    // Replace * or - at start of line with a bullet point
    html = html.replace(/^\s*[\-\*]\s+(.*$)/gm, '<li>$1</li>');
    
    // 8. Line breaks
    // We want to preserve line breaks, but block elements (h1-h6, pre, li) handle their own spacing.
    // We can replace newlines with <br> ONLY if they are not around block tags.
    // A simpler approach for chat: just replace all \n with <br>, and let CSS handle the extra spacing or remove it.
    // But <pre> content shouldn't have <br>.
    // Let's just replace \n with <br> globally, but we need to protect <pre> blocks.
    // Actually, the code block regex above already consumed the newlines inside it.
    // So we can just replace remaining \n.
    
    html = html.replace(/\n/g, '<br>');

    return html;
}

function renderEditor() {
    const container = $('#acc-preview-container');
    const tabsContainer = $('.acc-preview-tabs');
    
    // Don't fully empty if we want to preserve state, but for simplicity we re-render tabs
    // To preserve scroll position or focus, we might need more complex logic.
    // For now, re-rendering is acceptable as long as data is in openedFiles.
    
    container.empty();
    tabsContainer.empty();

    if (openedFiles.size === 0) {
        container.html('<div class="acc-empty-state"><i class="fas fa-file-alt"></i><p>暂无内容</p></div>');
        return;
    }

    // Ensure activeFileId is valid
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
                renderEditor(); // Re-render to switch tabs
            });

        const icon = $('<i class="fas fa-file-alt"></i>');
        const titleSpan = $('<span>').addClass('acc-tab-title').text(file.title);
        
        // Close button for tab
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

            // Toolbar
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

            // Textarea
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
                    // file.isDirty = true; // Could add dirty indicator
                });
            
            contentDiv.append(textarea);
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

    try {
        let result;
        if (meta.type === 'char') {
            result = await tools.update_character_card({
                chid: meta.chid,
                [meta.field]: file.content
            });
        } else if (meta.type === 'wi') {
            // For WI, we need to construct the entry object
            // We assume file.content is the 'content' field of the entry
            // We need other fields like keys, etc. stored in metadata or parsed?
            // If we only have content, we might lose keys if we just write content.
            // But wait, write_world_info_entry takes an array of entry objects.
            // If we only update content, we need the UID.
            
            if (meta.uid !== undefined) {
                result = await tools.write_world_info_entry({
                    book_name: meta.bookName,
                    entries: [{ uid: meta.uid, content: file.content }]
                });
            } else {
                // New entry? We need keys.
                // If it's a raw JSON view, we can parse it.
                try {
                    const entry = JSON.parse(file.content);
                    result = await tools.write_world_info_entry({
                        book_name: meta.bookName,
                        entries: [entry]
                    });
                } catch (e) {
                    // If it's just text content, we can't save it as a new entry without keys.
                    // Unless we assume it's an update to an existing entry we know about.
                    toastr.error('保存失败: 内容必须是有效的 JSON (针对新建条目) 或包含 UID');
                    return;
                }
            }
        }

        if (result && !result.startsWith('Error') && !result.includes('失败')) {
            toastr.success('保存成功');
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
            const char = JSON.parse(charData);
            previousCharData = char; // Cache for selector

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

            // Open Description by default if nothing open
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
            // Use return_full: false to get index only
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

async function updatePreview(toolName, args, isPartial = false) {
    const chid = args.chid !== undefined ? args.chid : $('#acc-target-char').val();
    const bookName = args.book_name !== undefined ? args.book_name : $('#acc-target-world').val();

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
        const diff = args.diff || '';
        const id = `char-${chid}-${field}`;
        
        if (isPartial) {
            // For partial diffs, we might want to show the diff itself in a temp tab?
            // Or if we have the original content, try to apply it?
            // Applying partial diff is hard.
            // Let's show the diff in a separate tab for now.
            const diffId = `diff-${chid}-${field}`;
            openedFiles.set(diffId, {
                title: `Diff: ${field}`,
                content: diff,
                type: 'diff',
                metadata: null // Cannot save raw diff easily
            });
            activeFileId = diffId;
        } else {
            // Full diff available. Try to apply to existing content.
            let originalContent = '';
            if (openedFiles.has(id)) {
                originalContent = openedFiles.get(id).content;
            } else {
                // Try to fetch if not open?
                // For now, just assume it's open or we can't apply.
                // If we can't apply, show diff.
            }

            if (originalContent) {
                // Apply diff logic
                const changes = diff.split('------- SEARCH');
                if (changes[0].trim() === '') changes.shift();
                
                let newContent = originalContent;
                let applied = true;

                for (const change of changes) {
                    const parts = change.split('=======');
                    if (parts.length === 2) {
                        const searchBlock = parts[0].trim();
                        const replaceBlock = parts[1].split('+++++++ REPLACE')[0].trim();
                        if (newContent.includes(searchBlock)) {
                            newContent = newContent.replace(searchBlock, replaceBlock);
                        } else {
                            applied = false;
                        }
                    }
                }

                if (applied) {
                    openedFiles.set(id, {
                        title: field,
                        content: newContent,
                        type: 'normal',
                        metadata: { type: 'char', chid, field }
                    });
                    activeFileId = id;
                    // Close diff tab if open
                    openedFiles.delete(`diff-${chid}-${field}`);
                } else {
                    // Failed to apply, show diff
                    const diffId = `diff-${chid}-${field}`;
                    openedFiles.set(diffId, {
                        title: `Diff: ${field} (Failed to Apply)`,
                        content: diff,
                        type: 'diff',
                        metadata: null
                    });
                    activeFileId = diffId;
                }
            } else {
                 // Original not found, show diff
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

    } else if (toolName === 'write_world_info_entry') {
        let entries = args.entries;
        
        if (isPartial && typeof entries === 'string') {
            // Show raw JSON for partial
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
            // Remove partial tab
            openedFiles.delete(`wi-raw-partial`);
        }
    }

    renderEditor();
}
