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

export async function openAutoCharCardWindow() {
    toastr.info("该功能正在开发，尚未完成，请耐心等待。");
    return;

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

function loadApiSettings() {
    const executorConfig = getApiConfig('executor');
    $('#acc-executor-url').val(executorConfig.apiUrl);
    $('#acc-executor-key').val(executorConfig.apiKey);
    
    const executorModelSelect = $('#acc-executor-model');
    if (executorConfig.model) {
        if (executorModelSelect.find(`option[value="${executorConfig.model}"]`).length === 0) {
            executorModelSelect.append(new Option(executorConfig.model, executorConfig.model));
        }
        executorModelSelect.val(executorConfig.model);
    }

    const reviewerConfig = getApiConfig('reviewer');
    $('#acc-reviewer-url').val(reviewerConfig.apiUrl);
    $('#acc-reviewer-key').val(reviewerConfig.apiKey);
    
    const reviewerModelSelect = $('#acc-reviewer-model');
    if (reviewerConfig.model) {
        if (reviewerModelSelect.find(`option[value="${reviewerConfig.model}"]`).length === 0) {
            reviewerModelSelect.append(new Option(reviewerConfig.model, reviewerConfig.model));
        }
        reviewerModelSelect.val(reviewerConfig.model);
    }
}

function bindEvents() {
    const windowEl = $('#acc-window');
    const minIcon = $('#acc-minimized-icon');

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

    $('.acc-preview-tabs .acc-tab-btn').on('click', function() {
        $('.acc-preview-tabs .acc-tab-btn').removeClass('active');
        $(this).addClass('active');
        const tab = $(this).data('tab');
        console.log('Switch preview tab to:', tab);
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

    $('#acc-api-settings-content .acc-tab-btn').on('click', function() {
        const target = $(this).data('target');
        $('#acc-api-settings-content .acc-tab-btn').removeClass('active');
        $(this).addClass('active');
        
        $('.acc-api-group').hide();
        $(`#acc-api-${target}`).show();
    });

    $('#acc-save-api').on('click', () => {
        const executorConfig = {
            apiUrl: $('#acc-executor-url').val().trim(),
            apiKey: $('#acc-executor-key').val().trim(),
            model: $('#acc-executor-model').val() || ''
        };
        const reviewerConfig = {
            apiUrl: $('#acc-reviewer-url').val().trim(),
            apiKey: $('#acc-reviewer-key').val().trim(),
            model: $('#acc-reviewer-model').val() || ''
        };

        setApiConfig('executor', executorConfig);
        setApiConfig('reviewer', reviewerConfig);
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
    $('#acc-reviewer-refresh-models').on('click', () => handleRefreshModels('reviewer'));

    $('#acc-executor-test').on('click', async function() {
        const btn = $(this);
        btn.prop('disabled', true).text('测试中...');
        const success = await testConnection('executor');
        btn.prop('disabled', false).text('测试连接');
        if (success) toastr.success('模型 A 连接成功');
        else toastr.error('模型 A 连接失败');
    });

    $('#acc-reviewer-test').on('click', async function() {
        const btn = $(this);
        btn.prop('disabled', true).text('测试中...');
        const success = await testConnection('reviewer');
        btn.prop('disabled', false).text('测试连接');
        if (success) toastr.success('模型 B 连接成功');
        else toastr.error('模型 B 连接失败');
    });
}

async function handleSendMessage() {
    const input = $('#acc-user-input');
    const message = input.val().trim();
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
        
        await agentManager.handleUserMessage(
            message, 
            (content, role) => {
                addMessage(role, content);
            },
            (toolName, args) => {
                updatePreview(toolName, args);
            }
        );
    } catch (error) {
        console.error('Agent Error:', error);
        addMessage('system', `发生错误: ${error.message}`);
    } finally {
        $('#acc-send-btn').prop('disabled', false);
        $('#acc-status-indicator').removeClass('status-working').addClass('status-idle').text('空闲');
    }
}

function addMessage(role, content) {
    const stream = $('#acc-chat-stream');
    
    let displayContent = content;
    if (role === 'executor') {
        const tools = [
            'read_world_info', 'write_world_info_entry', 'create_world_book',
            'read_character_card', 'update_character_card', 'edit_character_text',
            'manage_first_message', 'use_tool'
        ];
        const regex = new RegExp(`<(${tools.join('|')})>[\\s\\S]*?<\\/\\1>`, 'g');
        displayContent = content.replace(regex, '').trim();
        
        if (!displayContent) {
            displayContent = "<i>(正在执行操作...)</i>";
        }
    }

    const escapedContent = displayContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    const formattedContent = escapedContent.replace(/\n/g, '<br>');

    const msgDiv = $('<div>').addClass(`acc-message ${role}`);
    
    const avatarDiv = $('<div>').addClass('acc-avatar');
    if (role === 'user') {
        avatarDiv.html('<i class="fas fa-user"></i>');
    } else if (role === 'assistant') {
        avatarDiv.html('<i class="fas fa-brain" style="color: #ff9800;"></i>'); 
    } else if (role === 'executor') {
        avatarDiv.html('<i class="fas fa-robot" style="color: #4caf50;"></i>'); 
    } else if (role === 'system') {
        avatarDiv.html('<i class="fas fa-info-circle"></i>');
    }

    const contentDiv = $('<div>').addClass('acc-message-content');
    
    msgDiv.append(avatarDiv);
    msgDiv.append(contentDiv);
    stream.append(msgDiv);

    if (role === 'assistant') {
        let i = 0;
        const speed = 2; 
        const chunkSize = 5; 
        
        function typeWriter() {
            if (i < formattedContent.length) {
                let chunk = "";
                let count = 0;
                
                while (count < chunkSize && i < formattedContent.length) {
                    if (formattedContent.charAt(i) === '<') {
                        const tagEnd = formattedContent.indexOf('>', i);
                        if (tagEnd !== -1) {
                            chunk += formattedContent.substring(i, tagEnd + 1);
                            i = tagEnd + 1;
                        } else {
                            chunk += formattedContent.charAt(i);
                            i++;
                        }
                    } else {
                        chunk += formattedContent.charAt(i);
                        i++;
                    }
                    count++;
                }
                
                contentDiv.html(contentDiv.html() + chunk);
                stream.scrollTop(stream[0].scrollHeight);
                setTimeout(typeWriter, speed);
            }
        }
        typeWriter();
    } else {
        contentDiv.html(formattedContent);
        stream.scrollTop(stream[0].scrollHeight);
    }
}

async function updatePreview(toolName, args) {
    const container = $('#acc-preview-container');
    
    if (toolName === 'update_character_card' || toolName === 'edit_character_text') {
        const chid = args.chid !== undefined ? args.chid : $('#acc-target-char').val();
        if (chid !== undefined) {
            const charData = await tools.read_character_card({ chid });
            const char = JSON.parse(charData);
            
            let html = `<h3>角色预览: ${char.name}</h3>`;
            
            const fields = ['description', 'personality', 'first_mes', 'scenario'];
            fields.forEach(field => {
                const oldVal = previousCharData[field] || '';
                const newVal = char[field] || '';
                let contentHtml = newVal;
                
                if (oldVal !== newVal) {
                    contentHtml = `<div class="diff-added">${newVal}</div>`;
                    if (oldVal) {
                        contentHtml += `<div class="diff-removed" style="display:none;">${oldVal}</div>`; 
                    }
                }
                
                html += `<div class="acc-preview-item"><strong>${field}:</strong><pre>${contentHtml}</pre></div>`;
            });
            
            container.html(html);
            previousCharData = char; 
        }
    } else if (toolName === 'write_world_info_entry') {
        const bookName = args.book_name || $('#acc-target-world').val();
        if (bookName) {
            const entriesData = await tools.read_world_info({ book_name: bookName });
            const entries = JSON.parse(entriesData);
            
            let html = `<h3>世界书预览: ${bookName}</h3>`;
            entries.forEach(entry => {
                
                let isModified = false;
                if (args.entries) {
                    const modifiedEntries = Array.isArray(args.entries) ? args.entries : [args.entries];
                    isModified = modifiedEntries.some(e => e.key === entry.key || (Array.isArray(entry.keys) && entry.keys.includes(e.key)));
                }

                const contentClass = isModified ? 'diff-added' : '';
                
                html += `<div class="acc-preview-item ${contentClass}">
                    <strong>Key:</strong> ${Array.isArray(entry.keys) ? entry.keys.join(', ') : entry.key}<br>
                    <strong>Content:</strong><pre>${entry.content}</pre>
                </div>`;
            });
            
            container.html(html);
        }
    }
}
