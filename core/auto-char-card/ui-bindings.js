import { t, autoCardLabel, autoCardOption, setAutoCardText, setAutoCardAttribute,
    initializeAutoCardI18n, refreshAutoCardSecretPlaceholder, autoCardOptionsSignature } from './ui-i18n.js';
import { extensionName } from "../../utils/settings.js";
import { AgentManager } from "./agent-manager.js";
import { characters, this_chid, saveSettingsDebounced } from "/script.js";
import { extension_settings } from "/scripts/extensions.js";
import { world_names } from "/scripts/world-info.js";
import { getResolvedApiConfig, setApiConfig, testConnection, fetchModels } from "./api.js";
import * as toolModule from "./tools.js";
import { ToolApprovalGate, runWithToolPermit } from "./tool-policy.js";
import { syncSlot } from "../../ui/profile-sync.js";
import { clearSecretInput, markSecretInputStored, readSecretInputUpdate } from "../../ui/secret-input.js";
import { pluginAuthStatus, subscribePluginAuthStatus } from "../../utils/auth-state.js";
import { apiProfileManager } from "../../utils/config/ApiProfileManager.js";

const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const { tools } = toolModule;
const pendingFileSaves = new WeakSet();

let isInitialized = false;
let agentManager = null;
let previousCharData = {};
let previousWorldData = {};
let isWaitingForApproval = false;
let activeApprovalRequest = null;
let sendSequence = 0;
let openedFiles = new Map(); 
let activeFileId = null;
let promptLogContent = "=== Prompt Log ===\n\n";

subscribePluginAuthStatus(transition => {
    if (transition.authorized === true) return;
    agentManager?.revokeToolApprovals('PLUGIN_AUTH_REVOKED');
    resetApprovalUi();
    $('#acc-stop-btn').hide();
    setAutoCardText($('#acc-status-indicator').removeClass('status-working').addClass('status-idle'), 'autoCardUi.status.revoked');
});

export async function openAutoCharCardWindow() {
    if (pluginAuthStatus.authorized !== true) {
        toastr.warning(t('autoCardUi.auth.noStart'));
        return;
    }
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
            await loadApiSettings();
            await syncSlot('autoCharCard');
            renderRulesList();
            renderSessionsList();
            restoreChatHistory();
        } catch (dataError) {
            console.error('[Amily2 AutoCharCard] Failed to load data:', dataError);
            toastr.warning(t('autoCardUi.load.partial'));
        }
        
        isInitialized = true;
        console.log('[Amily2 AutoCharCard] Window initialized.');
    } catch (error) {
        console.error('[Amily2 AutoCharCard] Failed to initialize window:', error);
        toastr.error(t('autoCardUi.load.failed', { error: error.message }), '', { escapeHtml: true });
        $('#acc-window').remove();
    }
}

function populateDropdowns() {
    const charSelect = $('#acc-target-char');
    const prevCharId = charSelect.val();
    const stableAvatar = agentManager?.currentCharacterAvatar;

    charSelect.empty().append(autoCardOption('', 'autoCardUi.choose'));
    charSelect.append(autoCardOption('new', 'autoCardUi.newCharacter'));

    let isPrevCharStillPresent = false;
    characters.forEach((char, index) => {
        if (char) {
            charSelect.append($('<option>').val(index).text(char.name));
            if (String(index) === prevCharId) {
                isPrevCharStillPresent = true;
            }
        }
    });

    const stableCharId = stableAvatar
        ? characters.findIndex(char => char?.avatar === stableAvatar)
        : -1;
    if (stableCharId >= 0) {
        charSelect.val(String(stableCharId));
    } else if (isPrevCharStillPresent) {
        charSelect.val(prevCharId);
    } else if (this_chid !== undefined) {
        charSelect.val(this_chid);
    }

    const worldSelect = $('#acc-target-world');
    const prevWorldName = worldSelect.val();

    worldSelect.empty().append(autoCardOption('', 'autoCardUi.choose'));
    worldSelect.append(autoCardOption('new', 'autoCardUi.newWorld'));

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

function handleContextUpdate(type, value) {
    console.log(`[Amily2 AutoCharCard] Context Update: ${type} -> ${value}`);
    
    const previousCharacter = $('#acc-target-char').val();
    const previousBook = $('#acc-target-world').val();
    // The write adapter already published the verified character. Do not reload
    // every host character or allow a late fetch to change a newer selection.
    populateDropdowns(); 
    
    if (type === 'char') {
        const stableCharId = agentManager?.currentCharacterAvatar
            ? characters.findIndex(char => char?.avatar === agentManager.currentCharacterAvatar)
            : -1;
        $('#acc-target-char').val(stableCharId >= 0 ? String(stableCharId) : value);
        $('#acc-target-world').val(previousBook);
    } else if (type === 'world') {
        $('#acc-target-world').val(value);
        $('#acc-target-char').val(previousCharacter);
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

function getSelectedApprovalContext() {
    return {
        chid: $('#acc-target-char').val(),
        bookName: $('#acc-target-world').val(),
    };
}

function characterEditorMetadata(chid, field, expectedAvatar) {
    const target = toolModule.resolveCharacterToolTarget(chid, expectedAvatar);
    return { type: 'char', chid: target.chid, avatar: target.avatar, field };
}

function resetApprovalUi() {
    sendSequence += 1;
    isWaitingForApproval = false;
    activeApprovalRequest = null;
    const btn = $('#acc-send-btn');
    btn.html('<i class="fas fa-paper-plane"></i>');
    setAutoCardAttribute(btn, 'title', 'autoCardUi.send');
    btn.removeClass('acc-btn-success');
    $('#acc-reject-btn').remove();
    setAutoCardAttribute($('#acc-user-input'), 'placeholder', 'autoCardUi.input.request');
}

function syncActiveApprovalRequest(nextApproval) {
    if (nextApproval) activeApprovalRequest = nextApproval;
}

function restoreChatHistory() {
    const stream = $('#acc-chat-stream');
    stream.empty();
    
    if (agentManager && agentManager.history && agentManager.history.length > 0) {
        agentManager.history.forEach(msg => {
            addMessage(msg.role, msg.content);
        });
    } else {
        stream.append(`
            <div class="acc-message system">
                <div class="acc-message-content">
                    ${autoCardLabel('autoCardUi.welcome.title')}<br>
                    ${autoCardLabel('autoCardUi.welcome.workspace')}<br>
                    ${autoCardLabel('autoCardUi.welcome.character')}
                </div>
            </div>
        `);
    }
}

function renderSessionsList() {
    const list = $('#acc-sessions-list');
    list.empty();

    if (!agentManager) return;

    const sessions = agentManager.getSessionsList();
    if (sessions.length === 0) {
        list.append(`<div class="acc-empty-state" style="padding: 10px;">${autoCardLabel('autoCardUi.sessions.empty')}</div>`);
        return;
    }

    sessions.forEach(session => {
        const isActive = session.id === agentManager.sessionId;
        const item = $('<div>').addClass('acc-session-item').css({
            'background': isActive ? 'rgba(76, 175, 80, 0.2)' : 'rgba(0,0,0,0.1)',
            'border': isActive ? '1px solid #4caf50' : '1px solid transparent',
            'padding': '8px',
            'margin-bottom': '5px',
            'border-radius': '4px',
            'display': 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            'cursor': 'pointer'
        });

        const date = new Date(session.timestamp).toLocaleString();
        const textContainer = $('<div>').css({
            'display': 'flex',
            'flex-direction': 'column',
            'flex': '1',
            'overflow': 'hidden',
            'margin-right': '10px'
        });
        
        const titleSpan = $('<span>').text(session.title).css({
            'font-weight': 'bold',
            'white-space': 'nowrap',
            'overflow': 'hidden',
            'text-overflow': 'ellipsis'
        });
        const dateSpan = $('<span>').text(date).css({
            'font-size': '10px',
            'color': '#888'
        });

        textContainer.append(titleSpan).append(dateSpan);

        const delBtn = $('<button>').addClass('acc-btn-danger').html('<i class="fas fa-trash"></i>').css({
            'padding': '4px 8px',
            'font-size': '12px'
        });

        item.on('click', (e) => {
            if (e.target === delBtn[0] || delBtn.has(e.target).length > 0) return;
            if (!isActive) {
                if (agentManager.loadSession(session.id)) {
                    resetApprovalUi();
                    restoreChatHistory();
                    renderSessionsList();
                    populateDropdowns();
                    toastr.success(t('autoCardUi.sessions.switched'));
                } else {
                    toastr.error(t('autoCardUi.sessions.failed'));
                }
            }
        });

        delBtn.on('click', (e) => {
            e.stopPropagation();
            if (confirm(t('autoCardUi.sessions.deleteConfirm'))) {
                agentManager.deleteSession(session.id);
                resetApprovalUi();
                renderSessionsList();
                if (isActive) {
                    restoreChatHistory();
                    populateDropdowns();
                }
            }
        });

        item.append(textContainer).append(delBtn);
        list.append(item);
    });
}

function renderRulesList() {
    const list = $('#acc-rules-list');
    list.empty();

    if (!agentManager || !agentManager.contextManager) return;

    const rules = agentManager.contextManager.rules;
    if (rules.length === 0) {
        list.append(`<div class="acc-empty-state" style="padding: 10px;">${autoCardLabel('autoCardUi.rules.empty')}</div>`);
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
            agentManager.contextManager.removeRule(index);
            renderRulesList();
        });

        item.append(text).append(delBtn);
        list.append(item);
    });
}

async function loadApiSettings() {
    const executorConfig = await getResolvedApiConfig('executor');
    const executorKeyInput = $('#acc-executor-key');
    $('#acc-executor-url').val(executorConfig.apiUrl);
    clearSecretInput(executorKeyInput, Boolean(executorConfig.apiKey));
    refreshAutoCardSecretPlaceholder(executorKeyInput);
    $('#acc-executor-max-tokens').val(executorConfig.maxTokens || 4000);
    
    const executorModelSelect = $('#acc-executor-model');
    if (executorConfig.model) {
        if (!Array.from(executorModelSelect[0].options).some(option => option.value === executorConfig.model)) {
            executorModelSelect.append(new Option(executorConfig.model, executorConfig.model));
        }
        executorModelSelect.val(executorConfig.model);
    }
}

function bindEvents() {
    const windowEl = $('#acc-window');
    const minIcon = $('#acc-minimized-icon');
    initializeAutoCardI18n(windowEl);
    initializeAutoCardI18n(minIcon, 'minimized');

    // 一键生卡总开关（与 API 分配页 SLOT_TOGGLES.autoCharCard 双向同步）
    const masterToggle = document.getElementById('acc_master_enabled');
    if (masterToggle) {
        const s = extension_settings[extensionName] || {};
        masterToggle.checked = s.autoCharCardEnabled !== false;
        masterToggle.addEventListener('change', () => {
            if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
            extension_settings[extensionName].autoCharCardEnabled = masterToggle.checked;
            if (!masterToggle.checked && agentManager) {
                agentManager.revokeToolApprovals('MASTER_SWITCH_REVOKED');
                resetApprovalUi();
            }
            saveSettingsDebounced();
        });
    }

    $('#acc-file-selector').on('change', async function() {
        const val = $(this).val();
        if (!val) return;

        const [type, id, subId] = val.split('|');
        
        if (type === 'debug' && id === 'log') {
            const userType = localStorage.getItem("plugin_user_type");
            if (userType !== "3") {
                toastr.warning(t('autoCardUi.debug.denied'));
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
            const target = toolModule.resolveCharacterToolTarget(id);
            const chid = target.chid;
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
                const charData = await tools.read_character_card({ chid }, { expectedAvatar: target.avatar });
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
                toastr.error(t('autoCardUi.file.characterFailed'));
                return;
            }

            openedFiles.set(fileId, {
                title: field.startsWith('greeting_') ? `Greeting #${field.split('_')[1]}` : field,
                content: content || '',
                type: 'normal',
                metadata: characterEditorMetadata(chid, field, target.avatar)
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
                toastr.error(t('autoCardUi.file.worldFailed'));
            }
        }
        
        
        $(this).val('');
    });

    $('#acc-close-btn').on('click', () => {
        if (confirm(t('autoCardUi.closeConfirm'))) {
            agentManager?.stop();
            resetApprovalUi();
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
            resetApprovalUi();
            toastr.info(t('autoCardUi.stopRequested'));
            $('#acc-stop-btn').hide();
            setAutoCardText($('#acc-status-indicator').removeClass('status-working').addClass('status-idle'), 'autoCardUi.status.stopped');
            $('#acc-send-btn').prop('disabled', false);
        }
    });

    $('#acc-require-approval').on('change', function() {
        if (agentManager) {
            agentManager.setApprovalRequired($(this).is(':checked'));
            if (!agentManager.pendingToolCall) resetApprovalUi();
        }
    });

    $('#acc-target-char, #acc-target-world').on('change', () => {
        if (!agentManager) return;
        const wasActive = agentManager.status !== 'idle' || agentManager.pendingToolCall;
        agentManager.revokeToolApprovals('TARGET_SELECTION_CHANGED');
        resetApprovalUi();
        $('#acc-send-btn').prop('disabled', false);
        $('#acc-stop-btn').hide();
        if (wasActive) toastr.warning(t('autoCardUi.targetChanged'));
    });

    

    
    const previewHeader = $('.acc-right-panel .acc-panel-header');
    if (previewHeader.find('#acc-refresh-preview').length === 0) {
        const refreshBtn = $('<button>')
            .attr('id', 'acc-refresh-preview')
            .addClass('acc-control-btn')
            .attr('data-acc-i18n-title', 'autoCardUi.file.loadAll')
            .attr('title', t('autoCardUi.file.loadAll'))
            .html('<i class="fas fa-sync-alt"></i>')
            .css({ 'margin-left': 'auto', 'font-size': '12px' });
        
        previewHeader.append(refreshBtn);
        
        refreshBtn.on('click', () => {
            loadContextToEditor();
            toastr.info(t('autoCardUi.file.loaded'));
        });
    }
    
    $('#acc-sessions-toggle').on('click', function() {
        const content = $('#acc-sessions-content');
        const icon = $(this).find('.fa-chevron-down, .fa-chevron-up');
        if (content.is(':visible')) {
            content.slideUp();
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            content.slideDown();
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    $('#acc-new-session-btn').on('click', () => {
        if (agentManager) {
            agentManager.createNewSession();
            resetApprovalUi();
            restoreChatHistory();
            renderSessionsList();
            populateDropdowns();
            toastr.success(t('autoCardUi.sessions.created'));
        }
    });

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
            toastr.success(t('autoCardUi.rules.added'));
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

    $('#acc-save-api').on('click', async () => {
        const executorKeyInput = $('#acc-executor-key');
        const keyUpdate = readSecretInputUpdate(executorKeyInput);
        const execMaxTokens = parseInt($('#acc-executor-max-tokens').val());

        const executorConfig = {
            apiUrl: $('#acc-executor-url').val().trim(),
            model: $('#acc-executor-model').val() || '',
            maxTokens: isNaN(execMaxTokens) ? 0 : execMaxTokens,
            ...(keyUpdate.changed ? { apiKey: keyUpdate.value } : {}),
        };

        await setApiConfig('executor', executorConfig);
        const savedConfig = await getResolvedApiConfig('executor');
        markSecretInputStored(executorKeyInput, Boolean(savedConfig.apiKey));
        refreshAutoCardSecretPlaceholder(executorKeyInput);
        saveSettingsDebounced();
        toastr.success(t('autoCardUi.api.saved'));
    });

    const handleRefreshModels = async (role) => {
        const urlInput = $(`#acc-${role}-url`);
        const keyInput = $(`#acc-${role}-key`);
        const select = $(`#acc-${role}-model`);
        const btn = $(`#acc-${role}-refresh-models`);
        const inputs = [urlInput, keyInput, select];
        const controls = [...inputs, btn];
        const isAttached = control => control[0]?.isConnected && $(`#${control[0].id}`)[0] === control[0];
        if (!controls.every(isAttached) || btn.prop('disabled')) return;

        const rawUrl = urlInput.val();
        const rawKey = keyInput.val();
        const previousModel = select.val();
        const previousOptions = autoCardOptionsSignature(select);
        const hasCachedModels = Boolean(previousModel) || Array.from(select[0].options).some(option => option.value);
        const keyUpdate = readSecretInputUpdate(keyInput);
        const { secretStored, secretDirty } = keyInput[0].dataset;
        const originalIcon = btn.html();
        let stale = false;
        let unsubscribeProfile;
        const invalidate = () => { stale = true; };
        // Capture both values and edits, including an edit that restores the original value.
        const isCurrent = () => !stale && controls.every(isAttached)
            && urlInput.val() === rawUrl && keyInput.val() === rawKey
            && keyInput[0].dataset.secretStored === secretStored
            && keyInput[0].dataset.secretDirty === secretDirty
            && autoCardOptionsSignature(select) === previousOptions && select.val() === previousModel;
        btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>');

        try {
            const assignmentId = apiProfileManager.getAssignment('autoCharCard');
            const hasProfile = Boolean(assignmentId && apiProfileManager.getProfile(assignmentId));
            let apiUrl = rawUrl.trim();
            let apiKey = keyUpdate.value;
            if (!hasProfile && !apiUrl) {
                toastr.warning(t('autoCardUi.api.enterUrl'));
                return;
            }

            inputs.forEach(input => input.on('input change', invalidate));
            unsubscribeProfile = apiProfileManager.subscribeLifecycle(change => {
                if (change.slot === 'autoCharCard'
                    || (change.type !== 'assignment-changed' && assignmentId && change.profileId === assignmentId)) {
                    invalidate();
                }
            });
            // Keep the last list usable while refreshing; saving must not lose the selected model.

            if (hasProfile) {
                // A real assignment owns the whole connection; credential failures must not fall back.
                const profile = await apiProfileManager.getAssignedProfile('autoCharCard');
                if (!profile || profile.id !== assignmentId) {
                    throw new Error('当前 API Profile 不可用，请重新选择。');
                }
                apiUrl = profile.apiUrl;
                apiKey = profile.apiKey ?? '';
            } else if (!keyUpdate.changed) {
                const resolved = await getResolvedApiConfig(role);
                apiKey = typeof resolved.apiUrl === 'string' && resolved.apiUrl.trim() === apiUrl
                    ? (resolved.apiKey ?? '') : '';
            }
            stale ||= apiProfileManager.getAssignment('autoCharCard') !== assignmentId;
            if (!isCurrent()) return;

            const models = await fetchModels(apiUrl, apiKey);
            stale ||= apiProfileManager.getAssignment('autoCharCard') !== assignmentId;
            if (!isCurrent()) return;
            select.empty().append(autoCardOption('', 'autoCardUi.api.chooseModel'));
            
            if (models.length === 0) {
                select.append(autoCardOption('', 'autoCardUi.api.noModels', {}, true));
            } else {
                models.forEach(model => {
                    select.append(new Option(model, model));
                });
                toastr.success(t('autoCardUi.api.modelsLoaded', { count: models.length }));
            }
            if (previousModel && !models.includes(previousModel)) {
                select.append(new Option(previousModel, previousModel));
            }
            select.val(previousModel || '');
        } catch (error) {
            if (!isCurrent()) return;
            console.error(`[AutoCharCard] Failed to fetch models for ${role}:`, error);
            toastr.error(t('autoCardUi.api.modelsFailed', { error: error?.message ?? String(error) }), '', { escapeHtml: true });
            if (!hasCachedModels) select.empty().append(autoCardOption('', 'autoCardUi.api.failed'));
        } finally {
            inputs.forEach(input => input.off('input change', invalidate));
            unsubscribeProfile?.();
            if (isAttached(btn)) btn.prop('disabled', false).html(originalIcon);
        }
    };

    $('#acc-executor-refresh-models').on('click', () => handleRefreshModels('executor'));

    $('#acc-executor-test').on('click', async function() {
        const btn = $(this);
        setAutoCardText(btn.prop('disabled', true), 'autoCardUi.api.testing');
        const result = await testConnection('executor');
        setAutoCardText(btn.prop('disabled', false), 'autoCardUi.api.test');
        if (result.success) {
            toastr.success(t('autoCardUi.api.connected'));
        } else {
            toastr.error(t('autoCardUi.api.connectFailed', { error: result.error || t('autoCardUi.api.unknownError') }), '', { escapeHtml: true });
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

async function handleSendMessage(rejectApproval = false) {
    const input = $('#acc-user-input');
    const message = input.val().trim();

    if (pluginAuthStatus.authorized !== true) {
        agentManager?.revokeToolApprovals('PLUGIN_AUTH_REVOKED');
        resetApprovalUi();
        toastr.warning(t('autoCardUi.auth.noTools'));
        return;
    }
    
    if (!isWaitingForApproval && !message) return;

    if (!agentManager) {
        toastr.error(t('autoCardUi.agent.missing'));
        return;
    }
    if (['running', 'validating'].includes(agentManager.status)) return;

    const approvalRequest = isWaitingForApproval ? activeApprovalRequest : null;
    const waitingForApproval = isWaitingForApproval;
    const selectedContext = getSelectedApprovalContext();
    const selectedCharId = $('#acc-target-char').val();
    const selectedWorld = $('#acc-target-world').val();

    if (!waitingForApproval && !selectedCharId && selectedCharId !== '0') {
        toastr.warning(t('autoCardUi.targetRequired'));
        return;
    }

    if (waitingForApproval) resetApprovalUi();
    const manager = agentManager;
    const panel = $('#acc-window')[0];
    const sequence = ++sendSequence;
    let generation = manager.approvalGeneration;
    const ownsUi = () => sequence === sendSequence && manager === agentManager
        && panel?.isConnected && $('#acc-window')[0] === panel;
    const isCurrent = () => ownsUi() && generation === manager.approvalGeneration;
    const guard = callback => (...args) => { if (ownsUi()) return callback(...args); };
    const onStream = guard((content, role) => addMessage(role, content));
    const onPreview = guard(updatePreview);
    const onApproval = guard(showApprovalRequest);
    const onContext = guard(handleContextUpdate);
    const onPrompt = guard(handlePromptLog);
    const feedback = message || (rejectApproval === true ? '用户拒绝了操作。' : null);
    if (feedback) addMessage('user', feedback);
    input.val('');
    
    $('#acc-send-btn').prop('disabled', true);
    setAutoCardText($('#acc-status-indicator').removeClass('status-idle').addClass('status-working'), 'autoCardUi.status.working');
    $('#acc-stop-btn').show();

    try {
        if (waitingForApproval) {
            await manager.resumeWithApproval(!feedback, feedback, onStream, onPreview, onApproval, onContext, onPrompt,
                approvalRequest?.approvalId, selectedContext);
        } else {
            const contextReady = manager.setContext(selectedCharId, selectedWorld);
            generation = manager.approvalGeneration;
            await contextReady;
            if (!isCurrent()) return;
            manager.setApprovalRequired($('#acc-require-approval').is(':checked'));
            if (!isCurrent()) return;
            const running = manager.handleUserMessage(message, onStream, onPreview, onApproval, onContext, onPrompt);
            generation = manager.approvalGeneration;
            await running;
        }
    } catch (error) {
        if (!ownsUi()) return;
        console.error('Agent Error:', error);
        addMessage('system', autoCardLabel('autoCardUi.agent.error', { error: error.message }), { trustedHtml: true });
    } finally {
        if (ownsUi()) {
            $('#acc-send-btn').prop('disabled', false);
            $('#acc-stop-btn').hide();
            setAutoCardText($('#acc-status-indicator').removeClass('status-working').addClass('status-idle'),
                manager.status === 'paused' ? 'autoCardUi.status.approval' : 'autoCardUi.status.idle');
        }
    }
}

function showApprovalRequest(toolName, args, approvalRequest) {
    isWaitingForApproval = true;
    activeApprovalRequest = approvalRequest || null;
    
    
    updatePreview(toolName, args, false);

    
    const btn = $('#acc-send-btn');
    btn.html('<i class="fas fa-check"></i>');
    setAutoCardAttribute(btn, 'title', 'autoCardUi.approval.approve');
    btn.addClass('acc-btn-success');
    setAutoCardAttribute($('#acc-user-input'), 'placeholder', 'autoCardUi.approval.feedback');

    
    if ($('#acc-reject-btn').length === 0) {
        const rejectBtn = $('<button>')
            .attr('id', 'acc-reject-btn')
            .addClass('acc-btn-danger')
            .html('<i class="fas fa-times"></i>')
            .attr('data-acc-i18n-title', 'autoCardUi.approval.reject')
            .attr('title', t('autoCardUi.approval.reject'))
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
            await handleSendMessage(true);
        });
    }

    
    const riskKeys = {
        'read-only': 'autoCardUi.approval.readOnly',
        'reversible-write': 'autoCardUi.approval.reversible',
        'destructive-write': 'autoCardUi.approval.destructive',
    };
    const risk = approvalRequest?.risk;
    const riskLabel = Object.hasOwn(riskKeys, risk) ? autoCardLabel(riskKeys[risk])
        : approvalRequest?.riskLabel ? escapeHtmlText(approvalRequest.riskLabel) : autoCardLabel('autoCardUi.approval.required');
    const toolDisplay = `
        <div class="acc-tool-request">
            <details>
                <summary class="acc-tool-header" style="cursor: pointer;">
                    <i class="fas fa-code"></i> ${autoCardLabel('autoCardUi.approval.request')}${escapeHtmlText(toolName)}
                    <span style="float: right; font-size: 10px; color: #888;">${riskLabel} · ${autoCardLabel('autoCardUi.approval.batch')}</span>
                </summary>
                <pre class="acc-tool-content">${escapeHtmlText(JSON.stringify(args, null, 2))}</pre>
                ${approvalRequest?.scope?.sourceFingerprint ? `<p class="acc-tool-content">${autoCardLabel('autoCardUi.approval.target')}${escapeHtmlText(approvalRequest.scope.writeTarget)}<br>${autoCardLabel('autoCardUi.approval.fingerprint')}${escapeHtmlText(approvalRequest.scope.sourceFingerprint)}</p>` : ''}
            </details>
        </div>
    `;
    addMessage('system', toolDisplay, { trustedHtml: true });
}

function addMessage(role, content, options = {}) {
    const stream = $('#acc-chat-stream');
    content = String(content ?? '');
    
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
    let authoredPlaceholder = false;
    if (role === 'executor' || role === 'assistant') {
        
        
        displayContent = displayContent
            .replace(/<thinking(?:\s+[^>]*)?>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<\/thinking>/gi, '') 
            .replace(/<tool_code(?:\s+[^>]*)?>[\s\S]*?<\/tool_code>/gi, '')
            .trim();

        const toolNames = Object.keys(tools);
        const regex = new RegExp(`<(${toolNames.join('|')})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi');
        displayContent = displayContent.replace(regex, '').trim();
        
        if (!displayContent && role === 'executor') {
            displayContent = `<em>${autoCardLabel('autoCardUi.executing')}</em>`;
            authoredPlaceholder = true;
        }

        
        if (role === 'assistant') {
            stream.find('.acc-streaming').remove();
        }
    }

    let formattedContent;
    
    
    if (options.trustedHtml === true || authoredPlaceholder) {
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

    let html = escapeHtmlText(text);

    
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

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderEditor() {
    const container = $('#acc-preview-container');
    const tabsContainer = $('.acc-preview-tabs');
    
    
    
    
    
    container.empty();
    tabsContainer.empty();

    if (openedFiles.size === 0) {
        container.html(`<div class="acc-empty-state"><i class="fas fa-file-alt"></i><p>${autoCardLabel('autoCardUi.file.empty')}</p></div>`);
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
                .html(`<i class="fas fa-save"></i> ${autoCardLabel('autoCardUi.save')}`)
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
                                        .attr('data-acc-i18n-title', 'autoCardUi.diff.restore')
                                        .attr('title', t('autoCardUi.diff.restore'));
                                    
                                    const added = $('<div>')
                                        .text(segment.new)
                                        .attr('contenteditable', 'true')
                                        .css({
                                            'background-color': 'rgba(0, 255, 0, 0.2)',
                                            'cursor': 'text',
                                            'padding': '5px',
                                            'white-space': 'pre-wrap',
                                            'color': '#d4d4d4',
                                            'outline': 'none'
                                        })
                                        .attr('data-acc-i18n-title', 'autoCardUi.diff.edit')
                                        .attr('title', t('autoCardUi.diff.edit'));
                                    
                                    const toggle = () => {
                                        segment.active = false;
                                        renderChange();
                                        if (agentManager) {
                                            const newDiff = reconstructDiff(file.segments);
                                            syncActiveApprovalRequest(agentManager.updatePendingToolArgs({ diff: newDiff }));
                                        }
                                    };
                                    
                                    removed.on('click', toggle);
                                    
                                    added.on('input', function() {
                                        segment.new = $(this).text();
                                        if (agentManager) {
                                            const newDiff = reconstructDiff(file.segments);
                                            syncActiveApprovalRequest(agentManager.updatePendingToolArgs({ diff: newDiff }));
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
                                        .attr('data-acc-i18n-title', 'autoCardUi.diff.reapply')
                                        .attr('title', t('autoCardUi.diff.reapply'));
                                    
                                    restored.on('click', () => {
                                        segment.active = true;
                                        renderChange();
                                        if (agentManager) {
                                            const newDiff = reconstructDiff(file.segments);
                                            syncActiveApprovalRequest(agentManager.updatePendingToolArgs({ diff: newDiff }));
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
                    setAutoCardText(editorDiv, 'autoCardUi.diff.noSegments');
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
    if (!file || pendingFileSaves.has(file)) return;
    if (pluginAuthStatus.authorized !== true || extension_settings[extensionName]?.autoCharCardEnabled === false) {
        toastr.warning(t('autoCardUi.save.denied'));
        return;
    }
    if (!agentManager || agentManager.status !== 'idle') {
        toastr.warning(t('autoCardUi.save.busy'));
        return;
    }

    const meta = file.metadata;
    if (!meta) {
        toastr.warning(t('autoCardUi.save.noMetadata'));
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

    let characterTarget = null;
    if (meta.type === 'char') {
        if (typeof meta.avatar !== 'string') {
            toastr.error(t('autoCardUi.save.targetMissing'), '', { escapeHtml: true });
            return;
        }
        try {
            characterTarget = toolModule.resolveCharacterToolTarget(meta.chid, meta.avatar);
        } catch (error) {
            toastr.error(error.message, '', { escapeHtml: true });
            return;
        }
    }

    const manager = agentManager;
    const generation = manager.approvalGeneration;
    const panel = $('#acc-window')[0];
    const fileKey = JSON.stringify(file);
    const selectionKey = JSON.stringify(getSelectedApprovalContext());
    const isCurrent = () => agentManager === manager && generation === manager.approvalGeneration
        && manager.status === 'idle' && pluginAuthStatus.authorized === true
        && extension_settings[extensionName]?.autoCharCardEnabled !== false
        && panel?.isConnected && $('#acc-window')[0] === panel
        && openedFiles.get(id) === file && JSON.stringify(file) === fileKey
        && JSON.stringify(getSelectedApprovalContext()) === selectionKey;
    const gate = new ToolApprovalGate();
    pendingFileSaves.add(file);
    try {
        let toolCall;
        if (meta.type === 'char') {
            if (meta.field.startsWith('greeting_')) {
                const index = parseInt(meta.field.split('_')[1]);
                toolCall = { name: 'manage_first_message', arguments: {
                    action: 'update',
                    chid: characterTarget.chid,
                    index: index + 1,
                    message: contentToSave
                } };
            } else {
                toolCall = { name: 'update_character_card', arguments: {
                    chid: characterTarget.chid,
                    [meta.field]: contentToSave
                } };
            }
        } else if (meta.type === 'wi') {
            const entry = meta.uid !== undefined ? { uid: meta.uid, content: contentToSave } : JSON.parse(contentToSave);
            toolCall = { name: 'write_world_info_entry', arguments: { book_name: meta.bookName, entries: [entry] } };
        } else {
            throw new Error('不支持保存该文件类型。');
        }

        const preview = await toolModule.prepareToolWritePreview(toolCall, {
            isCurrent,
            expectedAvatar: characterTarget?.avatar,
        });
        if (!isCurrent()) return;
        const scope = { sessionId: manager.sessionId, ...manager.getToolApprovalScope(getSelectedApprovalContext()),
            writeTarget: preview.target, sourceFingerprint: preview.fingerprint };
        const plan = gate.plan(toolCall, scope);
        if (!confirm(t('autoCardUi.save.confirm', { target: preview.target, fingerprint: preview.fingerprint }))) {
            gate.reject(plan.approval.approvalId);
            return;
        }
        if (!isCurrent()) return;
        await toolModule.validateToolWritePreview(toolCall, preview, isCurrent);
        if (!isCurrent()) return;
        const permit = gate.approve(plan.approval.approvalId, toolCall, scope);
        const result = JSON.parse(await runWithToolPermit({ gate, permit, toolCall, scope,
            execute: () => tools[toolCall.name](toolCall.arguments, { preview, isCurrent }) }));
        if (!isCurrent()) return;
        const receipt = result.receipt;
        const targetMatches = meta.type === 'char'
            ? receipt?.target?.avatar === characterTarget.avatar && receipt?.target?.avatar === preview.target
                && receipt?.target?.chid === String(toolCall.arguments.chid)
            : receipt?.target?.book === preview.target;
        if (result.status !== 'success' || result.success !== true || result.committed !== true
            || receipt?.version !== 1 || receipt.verification !== 'readback'
            || receipt.sourceFingerprint !== preview.fingerprint || !targetMatches) {
            toastr[result.committed === true ? 'warning' : 'error'](result.message || t('autoCardUi.save.unconfirmed'), '', { escapeHtml: true });
            return;
        }
        toastr.success(t('autoCardUi.save.success'));
        if (meta.type === 'char') {
            meta.chid = characterTarget.chid;
            meta.avatar = characterTarget.avatar;
        }
        file.type = 'normal';
        delete file.segments;
        file.content = contentToSave;
        if (meta.type === 'wi' && meta.uid === undefined && result.data?.created_uids?.length === 1) {
            meta.uid = result.data.created_uids[0];
            file.content = toolCall.arguments.entries[0].content ?? '';
        }
        renderEditor();
    } catch (e) {
        if (!isCurrent()) return;
        console.error('Save failed:', e);
        toastr.error(t('autoCardUi.save.error', { error: e.message }), '', { escapeHtml: true });
    } finally {
        pendingFileSaves.delete(file);
    }
}

async function loadContextToEditor() {
    const chid = $('#acc-target-char').val();
    const bookName = $('#acc-target-world').val();
    const selector = $('#acc-file-selector');
    
    selector.empty().append(autoCardOption('', 'autoCardUi.file.choose'));

    if (chid && chid !== 'new') {
        try {
            const target = toolModule.resolveCharacterToolTarget(chid);
            const charData = await tools.read_character_card({ chid: target.chid }, { expectedAvatar: target.avatar });
            const response = JSON.parse(charData);
            
            if (response.status !== 'success' || !response.data) {
                console.error("Failed to read character:", response);
                return;
            }
            
            const char = response.data;
            previousCharData = char; 

            const charGroup = setAutoCardAttribute($('<optgroup>'), 'label', 'autoCardUi.file.characterFields');
            const fields = ['description', 'personality', 'first_mes', 'scenario', 'mes_example'];
            fields.forEach(field => {
                charGroup.append($('<option>').val(`char|${target.chid}|${field}`).text(field));
            });
            
            if (char.alternate_greetings && char.alternate_greetings.length > 0) {
                char.alternate_greetings.forEach((_, index) => {
                    charGroup.append(autoCardOption(`char|${target.chid}|greeting_${index}`, 'autoCardUi.file.greeting', { index: index + 1 }));
                });
            }
            selector.append(charGroup);

            
            const userType = localStorage.getItem("plugin_user_type");
            if (userType === "3") {
                selector.append('<option value="debug|log">Debug: Prompt Log</option>');
            }

            
            if (openedFiles.size === 0 && char.description) {
                const id = `char-${target.chid}-description`;
                openedFiles.set(id, {
                    title: 'description',
                    content: char.description,
                    type: 'normal',
                    metadata: characterEditorMetadata(target.chid, 'description', target.avatar)
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
            
            const wiGroup = setAutoCardAttribute($('<optgroup>'), 'label', 'autoCardUi.file.worldEntries');
            if (index.entries) {
                index.entries.forEach(entry => {
                    const name = entry.comment || entry.keys || `Entry ${entry.uid}`;
                    wiGroup.append($('<option>').val(`wi|${bookName}|${entry.uid}`).text(String(name)));
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
    const manager = agentManager;
    const generation = manager?.approvalGeneration;
    const panel = $('#acc-window')[0];
    const sequence = sendSequence;
    const isCurrent = () => agentManager === manager && manager?.approvalGeneration === generation
        && panel?.isConnected && $('#acc-window')[0] === panel && sequence === sendSequence;
    if (!isCurrent()) return;
    let chid = args.chid;
    if (chid === undefined || chid === null || chid === '') {
        const uiVal = $('#acc-target-char').val();
        if (uiVal !== 'new' && uiVal !== '') {
            chid = uiVal;
        }
    }
    chid = String(chid);

    let characterTarget = null;
    if (['update_character_card', 'edit_character_text'].includes(toolName)) {
        const expectedAvatar = manager?.currentCharacterAvatar;
        const targetChid = expectedAvatar && manager?.currentChid !== undefined ? manager.currentChid : chid;
        if (expectedAvatar || /^(0|[1-9][0-9]*)$/.test(String(targetChid))) {
            characterTarget = toolModule.resolveCharacterToolTarget(targetChid, expectedAvatar);
            chid = characterTarget.chid;
        }
    }

    let bookName = args.book_name;
    if (bookName === undefined || bookName === null || bookName === '') {
        const uiVal = $('#acc-target-world').val();
        if (uiVal !== 'new' && uiVal !== '') {
            bookName = uiVal;
        }
    }
    bookName = String(bookName);

    if (toolName === 'update_character_card') {
        if (!characterTarget) return;
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
                    metadata: characterEditorMetadata(chid, field, characterTarget.avatar)
                });
                activeFileId = id;
            }
        });

    } else if (toolName === 'edit_character_text') {
        const field = args.field || 'Unknown Field';
        const diff = args.diff || '';
        let id = `char-${chid}-${field}`;

        if (!characterTarget && !isPartial) return;

        // Clean up any tabs with undefined chid or Unknown Field
        openedFiles.forEach((file, fileId) => {
            if (fileId.startsWith('diff-') && !fileId.startsWith('diff-wi-')) {
                if (fileId.includes('-undefined') || fileId.includes('-Unknown Field')) {
                    if (fileId !== `diff-${chid}-${field}`) {
                        openedFiles.delete(fileId);
                    }
                }
            }
            if (fileId.startsWith('char-')) {
                if (fileId.includes('-undefined') || fileId.includes('-Unknown Field')) {
                    if (fileId !== id) {
                        const fileToRename = openedFiles.get(fileId);
                        openedFiles.delete(fileId);
                        fileToRename.title = field;
                        if (fileToRename.metadata) {
                            fileToRename.metadata.chid = chid;
                            fileToRename.metadata.avatar = characterTarget?.avatar;
                            fileToRename.metadata.field = field;
                        }
                        openedFiles.set(id, fileToRename);
                        if (activeFileId === fileId) activeFileId = id;
                    }
                }
            }
        });
        
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
                const charData = await tools.read_character_card({ chid }, { expectedAvatar: characterTarget.avatar });
                if (!isCurrent()) return;
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
            if (!isCurrent()) return;

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
                    metadata: characterEditorMetadata(chid, field, characterTarget.avatar)
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
            const diffId = `diff-${chid}-${field}`;
            if (openedFiles.has(diffId)) {
                openedFiles.delete(diffId);
            }
            
            let originalContent = null;
            if (openedFiles.has(id)) {
                originalContent = openedFiles.get(id).content || '';
            } else {
                try {
                    const charData = await tools.read_character_card({ chid }, { expectedAvatar: characterTarget.avatar });
                    if (!isCurrent()) return;
                    const response = JSON.parse(charData);
                    if (response.status === 'success' && response.data) {
                        const char = response.data;
                        if (field.startsWith('greeting_')) {
                            const index = parseInt(field.split('_')[1]);
                            originalContent = char.alternate_greetings[index] || '';
                        } else {
                            originalContent = char[field] || '';
                        }
                    }
                } catch (e) {
                    console.error("Failed to fetch original content for diff view", e);
                }
            }

            if (!isCurrent()) return;
            if (originalContent !== null) {
                const segments = parseDiff(originalContent, diff);
                openedFiles.set(id, {
                    title: field,
                    content: originalContent, 
                    segments: segments,
                    type: 'diff-view',
                    metadata: characterEditorMetadata(chid, field, characterTarget.avatar)
                });
                activeFileId = id;
            } else {
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
        const diff = args.diff || '';
        const id = `wi-${bookName}-${uid}`;

        // Clean up any tabs with undefined bookName or uid
        openedFiles.forEach((file, fileId) => {
            if (fileId.startsWith('diff-wi-') || fileId.startsWith('wi-')) {
                if (fileId.includes('-undefined')) {
                    if (fileId !== `diff-wi-${bookName}-${uid}` && fileId !== id) {
                        openedFiles.delete(fileId);
                    }
                }
            }
        });
        
        if (isPartial) {
            const diffId = `diff-wi-${bookName}-${uid}`;
            
            // Clean up any other diff tabs for this book to prevent duplicates during streaming
            openedFiles.forEach((file, fileId) => {
                if (fileId.startsWith(`diff-wi-${bookName}-`) && fileId !== diffId) {
                    openedFiles.delete(fileId);
                }
            });

            openedFiles.set(diffId, {
                title: uid !== undefined ? `Diff: WI ${uid}` : 'Diff: WI (Generating...)',
                content: diff,
                type: 'diff',
                metadata: null
            });
            activeFileId = diffId;
        } else if (isExecuted) {
            
            try {
                const entryData = await tools.read_world_entry({ book_name: bookName, uid: uid });
                if (!isCurrent()) return;
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
            const diffId = `diff-wi-${bookName}-${uid}`;
            if (openedFiles.has(diffId)) {
                openedFiles.delete(diffId);
            }
            
            // Clean up any other diff tabs for this book to prevent duplicates
            openedFiles.forEach((file, fileId) => {
                if (fileId.startsWith(`diff-wi-${bookName}-`) && fileId !== diffId) {
                    openedFiles.delete(fileId);
                }
            });
            
            let originalContent = null;
            if (openedFiles.has(id)) {
                originalContent = openedFiles.get(id).content || '';
            } else {
                try {
                    const entryData = await tools.read_world_entry({ book_name: bookName, uid: uid });
                    if (!isCurrent()) return;
                    const response = JSON.parse(entryData);
                    if (response.status === 'success' && response.data) {
                        originalContent = response.data.content || '';
                    }
                } catch (e) {
                    console.error("Failed to fetch original content for WI diff view", e);
                }
            }
            
            if (!isCurrent()) return;
            if (originalContent !== null) {
                const segments = parseDiff(originalContent, diff);
                openedFiles.set(id, {
                    title: `WI: ${uid}`,
                    content: originalContent,
                    segments: segments,
                    type: 'diff-view',
                    metadata: { type: 'wi', bookName, uid }
                });
                activeFileId = id;
            } else {
                 openedFiles.set(diffId, {
                     title: uid !== undefined ? `Diff: WI ${uid}` : 'Diff: WI (Generating...)',
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

            entries
                .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
                .forEach(entry => {
                const keys = Array.isArray(entry.key) ? entry.key.join(', ') : (entry.key || 'New Entry');
                const uid = entry.uid ?? 'new';
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

    if (isCurrent()) renderEditor();
}

function parseDiff(originalContent, diff) {
    const segments = [];
    let currentIndex = 0;
    
    const parts = diff.split('------- SEARCH');
    
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const split1 = part.split('=======');
        if (split1.length < 2) continue;
        
        // Remove only the first and last newline to preserve indentation
        let searchContent = split1[0].replace(/^\r?\n|\r?\n$/g, '');
        const split2 = split1[1].split('+++++++ REPLACE');
        if (split2.length < 1) continue;
        
        let replaceContent = split2[0].replace(/^\r?\n|\r?\n$/g, '');
        
        let foundIndex = originalContent.indexOf(searchContent, currentIndex);
        
        // Fallback: try normalizing line endings if exact match fails
        if (foundIndex === -1) {
            const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
            const normalizedSearch = searchContent.replace(/\r\n/g, '\n');
            foundIndex = normalizedOriginal.indexOf(normalizedSearch, currentIndex);
            
            if (foundIndex !== -1) {
                // Use the actual original string for the matched portion
                searchContent = originalContent.substring(foundIndex, foundIndex + normalizedSearch.length);
            }
        }
        
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
        } else {
            // If still not found, append it anyway so it doesn't silently disappear
            console.warn("Diff search block not found in original content:", searchContent);
            
            // If we haven't added any text yet, add the whole original content first
            if (currentIndex === 0 && i === 1) {
                segments.push({
                    type: 'text',
                    content: originalContent
                });
                currentIndex = originalContent.length;
            }
            
            segments.push({
                type: 'change',
                original: searchContent,
                new: replaceContent,
                active: true,
                error: true
            });
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
