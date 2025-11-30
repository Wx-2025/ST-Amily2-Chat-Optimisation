import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../../utils/settings.js';
import { saveSettingsDebounced } from '/script.js';
import { world_names } from '/scripts/world-info.js';
import { state } from './cwb_state.js';
import { cwbCompleteDefaultSettings } from './cwb_config.js';
import { logError, showToastr, escapeHtml, compareVersions, isCwbEnabled } from './cwb_utils.js';
import { fetchModelsAndConnect, updateApiStatusDisplay } from './cwb_apiService.js';
import { checkForUpdates } from './cwb_updater.js';
import { handleManualUpdateCard, startBatchUpdate, handleFloorRangeUpdate, handleLegacyFormatConversion } from './cwb_core.js';
import { initializeCharCardViewer } from './cwb_uiManager.js';
import { CHAR_CARD_VIEWER_BUTTON_ID } from './cwb_state.js';

const { jQuery: $ } = window;

const CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY = 'cwb_boolean_settings_override';
let $panel;

const getSettings = () => extension_settings[extensionName];

function updateControlsLockState() {
    if (!$panel) return;
    const settings = getSettings();
    const isMasterEnabled = settings.cwb_master_enabled;

    const $controlsToToggle = $panel.find('input, textarea, select, button').not('#cwb_master_enabled-checkbox, #amily2_back_to_main_from_cwb, .sinan-nav-item');

    if (isMasterEnabled) {
        $controlsToToggle.prop('disabled', false);
        $panel.find('.settings-group').not('.master-control-group').css('opacity', '1');
    } else {
        $controlsToToggle.prop('disabled', true);
        $panel.find('.settings-group').not('.master-control-group').css('opacity', '0.5');
    }
}

function saveApiConfig() {
    const settings = getSettings();
    settings.cwb_api_mode = $panel.find('#cwb-api-mode').val();
    settings.cwb_api_url = $panel.find('#cwb-api-url').val().trim();
    settings.cwb_api_key = $panel.find('#cwb-api-key').val();
    settings.cwb_api_model = $panel.find('#cwb-api-model').val();
    settings.cwb_tavern_profile = $panel.find('#cwb-tavern-profile').val();

    if (settings.cwb_api_mode === 'sillytavern_preset') {
        if (!settings.cwb_tavern_profile) {
            showToastr('warning', '请选择SillyTavern预设。');
            return;
        }
        showToastr('success', 'API配置已保存！');
    } else {
        if (!settings.cwb_api_url) {
            showToastr('warning', 'API URL 不能为空。');
            return;
        }
        showToastr('success', 'API配置已保存！');
    }
    
    saveSettingsDebounced();
    loadSettings();
}

function clearApiConfig() {
    const settings = getSettings();
    settings.cwb_api_url = '';
    settings.cwb_api_key = '';
    settings.cwb_api_model = '';
    saveSettingsDebounced();
    state.customApiConfig.url = '';
    state.customApiConfig.apiKey = '';
    state.customApiConfig.model = '';
    updateUiWithSettings();
    updateApiStatusDisplay($panel);
    showToastr('info', 'API配置已清除！');
}

function saveBreakArmorPrompt() {
    const newPrompt = $panel.find('#cwb-break-armor-prompt-textarea').val().trim();
    if (!newPrompt) {
        showToastr('warning', '破甲预设不能为空。');
        return;
    }
    getSettings().cwb_break_armor_prompt = newPrompt;
    state.currentBreakArmorPrompt = newPrompt;
    saveSettingsDebounced();
    showToastr('success', '破甲预设已保存！');
}

function resetBreakArmorPrompt() {
    getSettings().cwb_break_armor_prompt = cwbCompleteDefaultSettings.cwb_break_armor_prompt;
    state.currentBreakArmorPrompt = cwbCompleteDefaultSettings.cwb_break_armor_prompt;
    saveSettingsDebounced();
    updateUiWithSettings();
    showToastr('info', '破甲预设已恢复为默认值！');
}

function saveCharCardPrompt() {
    const newPrompt = $panel.find('#cwb-char-card-prompt-textarea').val().trim();
    if (!newPrompt) {
        showToastr('warning', '角色卡预设不能为空。');
        return;
    }
    getSettings().cwb_char_card_prompt = newPrompt;
    state.currentCharCardPrompt = newPrompt;
    saveSettingsDebounced();
    showToastr('success', '角色卡预设已保存！');
}

function resetCharCardPrompt() {
    getSettings().cwb_char_card_prompt = cwbCompleteDefaultSettings.cwb_char_card_prompt;
    state.currentCharCardPrompt = cwbCompleteDefaultSettings.cwb_char_card_prompt;
    saveSettingsDebounced();
    updateUiWithSettings();
    showToastr('info', '角色卡预设已恢复为默认值！');
}

function saveAutoUpdateThreshold() {
    const valStr = $panel.find('#cwb-auto-update-threshold').val();
    const newT = parseInt(valStr, 10);
    if (!isNaN(newT) && newT >= 1) {
        getSettings().cwb_auto_update_threshold = newT;
        state.autoUpdateThreshold = newT;
        saveSettingsDebounced();
        showToastr('success', '自动更新阈值已保存！');
    } else {
        showToastr('warning', `阈值 "${valStr}" 无效。`);
        $panel.find('#cwb-auto-update-threshold').val(getSettings().cwb_auto_update_threshold);
    }
}

function saveScanDepth() {
    const valStr = $panel.find('#cwb-scan-depth').val();
    const newT = parseInt(valStr, 10);
    if (!isNaN(newT) && newT >= 1) {
        getSettings().cwb_scan_depth = newT;
        state.scanDepth = newT;
        saveSettingsDebounced();
        showToastr('success', '扫描深度已保存！');
    } else {
        showToastr('warning', `深度 "${valStr}" 无效。`);
        $panel.find('#cwb-scan-depth').val(getSettings().cwb_scan_depth);
    }
}

function bindWorldBookSettings() {
    const MAX_RETRIES = 10;
    const RETRY_DELAY = 200;
    let attempt = 0;

    function tryBind() {
        if (world_names && world_names.length > 0) {
            console.log('[CWB] World books loaded, binding settings...');
            const settings = getSettings();

            if (settings.cwb_worldbook_target === undefined) settings.cwb_worldbook_target = 'primary';
            if (settings.cwb_custom_worldbook === undefined) settings.cwb_custom_worldbook = null;

            const customSelectWrapper = $panel.find('#cwb_worldbook_select_wrapper');
            const bookListContainer = $panel.find('#cwb_worldbook_radio_list');

            const renderWorldBookList = () => {
                const worldBooks = world_names.map(name => ({ name: name.replace('.json', ''), file_name: name }));
                bookListContainer.empty();

                if (worldBooks.length > 0) {
                    worldBooks.forEach(book => {
                        const div = $('<div class="checkbox-item"></div>').attr('title', book.name);
                        const radio = $('<input type="radio" name="cwb_worldbook_selection">')
                            .attr('id', `cwb-wb-radio-${book.file_name}`)
                            .val(book.file_name)
                            .prop('checked', settings.cwb_custom_worldbook === book.file_name);
                        const label = $('<label></label>').attr('for', `cwb-wb-radio-${book.file_name}`).text(book.name);
                        div.append(radio).append(label);
                        bookListContainer.append(div);
                    });
                } else {
                    bookListContainer.html('<p class="notes">没有找到世界书。</p>');
                }
            };

            const updateCustomSelectVisibility = () => {
                const isCustom = settings.cwb_worldbook_target === 'custom';
                customSelectWrapper.toggle(isCustom);
                if (isCustom) {
                    renderWorldBookList();
                }
            };

            $panel.find('input[name="cwb_worldbook_target"]').each(function() {
                $(this).prop('checked', $(this).val() === settings.cwb_worldbook_target);
            });
            updateCustomSelectVisibility();

            $panel.off('change.cwb_worldbook_target').on('change.cwb_worldbook_target', 'input[name="cwb_worldbook_target"]', function() {
                if ($(this).prop('checked')) {
                    settings.cwb_worldbook_target = $(this).val();
                    state.worldbookTarget = $(this).val();
                    updateCustomSelectVisibility();
                    saveSettingsDebounced();
                }
            });

            bookListContainer.off('change.cwb_worldbook_selection').on('change.cwb_worldbook_selection', 'input[name="cwb_worldbook_selection"]', function() {
                const radio = $(this);
                if (radio.prop('checked')) {
                    settings.cwb_custom_worldbook = radio.val();
                    state.customWorldBook = radio.val();
                    saveSettingsDebounced();
                    showToastr('info', `已选择世界书: ${radio.next('label').text()}`);
                }
            });

            $panel.off('click.cwb_refresh_worldbooks').on('click.cwb_refresh_worldbooks', '#cwb_refresh_worldbooks', renderWorldBookList);

        } else if (attempt < MAX_RETRIES) {
            attempt++;
            console.log(`[CWB] World books not ready, retrying... (Attempt ${attempt})`);
            setTimeout(tryBind, RETRY_DELAY);
        } else {
            console.error('[CWB] Failed to load world books after multiple retries.');
            $panel.find('#cwb_worldbook_radio_list').html('<p class="notes error">加载世界书失败，请刷新页面重试。</p>');
        }
    }

    tryBind();
}

export function bindSettingsEvents($settingsPanel) {
    $panel = $settingsPanel;

    bindWorldBookSettings();
    $panel.on('click', '.sinan-nav-item', function () {
        const $this = $(this);
        const tabId = $this.data('tab');

        $panel.find('.sinan-nav-item').removeClass('active');
        $this.addClass('active');
        $panel.find('.sinan-tab-pane').removeClass('active');
        $panel.find(`#cwb-${tabId}-tab`).addClass('active');
    });
    $panel.on('change', '#cwb-api-mode', function() {
        const selectedMode = $(this).val();
        
        // 自动保存API模式设置
        getSettings().cwb_api_mode = selectedMode;
        saveSettingsDebounced();
        
        updateApiModeUI(selectedMode);
        if (selectedMode === 'sillytavern_preset') {
            loadSillyTavernPresets(true);
        }
        
        showToastr('success', `API模式已切换为: ${selectedMode === 'sillytavern_preset' ? 'SillyTavern预设' : '全兼容'}`);
    });
    $panel.on('change', '#cwb-tavern-profile', function() {
        const selectedProfile = $(this).val();
        
        // 自动保存SillyTavern预设选择
        getSettings().cwb_tavern_profile = selectedProfile;
        saveSettingsDebounced();
        
        if (selectedProfile) {
            console.log(`[CWB] 选择了预设: ${selectedProfile}`);
            showToastr('success', `SillyTavern预设已选择: ${selectedProfile}`);
        }
        
        updateApiStatusDisplay($panel);
    });
    // 添加API字段的实时保存
    $panel.on('input', '#cwb-api-url', function() {
        const apiUrl = $(this).val().trim();
        
        // 同时更新设置和状态
        getSettings().cwb_api_url = apiUrl;
        state.customApiConfig.url = apiUrl;
        
        saveSettingsDebounced();
        updateApiStatusDisplay($panel);
        
        console.log('[CWB] API URL已更新 - 设置:', getSettings().cwb_api_url, ', 状态:', state.customApiConfig.url);
    });
    
    $panel.on('input', '#cwb-api-key', function() {
        const apiKey = $(this).val();
        
        // 同时更新设置和状态
        getSettings().cwb_api_key = apiKey;
        state.customApiConfig.apiKey = apiKey;
        
        saveSettingsDebounced();
        
        console.log('[CWB] API Key已更新 - 设置长度:', getSettings().cwb_api_key?.length || 0, ', 状态长度:', state.customApiConfig.apiKey?.length || 0);
    });
    
    $panel.on('change', '#cwb-api-model', function() {
        const model = $(this).val();
        
        // 同时更新设置和状态
        getSettings().cwb_api_model = model;
        state.customApiConfig.model = model;
        
        saveSettingsDebounced();
        updateApiStatusDisplay($panel);
        
        console.log('[CWB] 模型已更新 - 设置:', getSettings().cwb_api_model, ', 状态:', state.customApiConfig.model);
        
        if (model) {
            showToastr('success', `模型已选择: ${model}`);
        }
    });

    $panel.on('click', '#cwb-load-models', () => fetchModelsAndConnect($panel));

    $panel.on('click', '#cwb-save-break-armor-prompt', saveBreakArmorPrompt);
    $panel.on('click', '#cwb-reset-break-armor-prompt', resetBreakArmorPrompt);
    $panel.on('click', '#cwb-save-char-card-prompt', saveCharCardPrompt);
    $panel.on('click', '#cwb-reset-char-card-prompt', resetCharCardPrompt);

    $panel.on('click', '#cwb-save-auto-update-threshold', saveAutoUpdateThreshold);
    $panel.on('click', '#cwb-save-scan-depth', saveScanDepth);
    $panel.on('click', '#cwb-manual-update-card', () => handleManualUpdateCard($panel));
    $panel.on('click', '#cwb-batch-update-card', () => startBatchUpdate($panel));
    $panel.on('click', '#cwb-floor-range-update', () => handleFloorRangeUpdate($panel));
    $panel.on('click', '#cwb-legacy-auto-update', () => handleLegacyFormatConversion($panel));
    $panel.on('click', '#cwb-check-for-updates', () => checkForUpdates(true, $panel));

    $panel.on('click', '#cwb-auto-update-enabled', function () {
        const $checkbox = $(this).find('input[type="checkbox"]');
        const isChecked = !$checkbox.prop('checked'); 
        $checkbox.prop('checked', isChecked);

        console.log(`[CWB] Auto-update switch clicked. New state: ${isChecked}`);
        getSettings().cwb_auto_update_enabled = isChecked;

        const overrides = JSON.parse(localStorage.getItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY) || '{}');
        overrides.cwb_auto_update_enabled = isChecked;
        localStorage.setItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY, JSON.stringify(overrides));

        saveSettingsDebounced();
        state.autoUpdateEnabled = isChecked;
        showToastr('info', `角色卡自动更新已 ${isChecked ? '启用' : '禁用'}`);
    });

    $panel.on('click', '#cwb-viewer-enabled', function () {
        const $checkbox = $(this).find('input[type="checkbox"]');
        const isChecked = !$checkbox.prop('checked');
        $checkbox.prop('checked', isChecked);

        console.log(`[CWB] Viewer switch clicked. New state: ${isChecked}`);
        getSettings().cwb_viewer_enabled = isChecked;

        const overrides = JSON.parse(localStorage.getItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY) || '{}');
        overrides.cwb_viewer_enabled = isChecked;
        localStorage.setItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY, JSON.stringify(overrides));

        saveSettingsDebounced();

        state.viewerEnabled = isChecked;

        const $viewerButton = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
        if ($viewerButton.length > 0) {
            const shouldShow = isCwbEnabled() && isChecked;
            $viewerButton.toggle(shouldShow);
        }
        
        showToastr('info', `角色卡查看器已 ${isChecked ? '启用' : '禁用'}`);
    });

    $panel.on('click', '#cwb-incremental-update-enabled', function () {
        const $checkbox = $(this).find('input[type="checkbox"]');
        const isChecked = !$checkbox.prop('checked'); // Manually toggle
        $checkbox.prop('checked', isChecked);

        console.log(`[CWB] Incremental update switch clicked. New state: ${isChecked}`);
        getSettings().cwb_incremental_update_enabled = isChecked;

        const overrides = JSON.parse(localStorage.getItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY) || '{}');
        overrides.cwb_incremental_update_enabled = isChecked;
        localStorage.setItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY, JSON.stringify(overrides));

        saveSettingsDebounced();
        state.isIncrementalUpdateEnabled = isChecked;
        showToastr('info', `增量更新模式已 ${isChecked ? '启用' : '禁用'}`);
    });

    $panel.on('click', '#cwb_master_enabled', function () {
        const $checkbox = $(this).find('input[type="checkbox"]');
        const isChecked = !$checkbox.prop('checked');
        $checkbox.prop('checked', isChecked);

        console.log(`[CWB] Master switch clicked. New state: ${isChecked}`);

        getSettings().cwb_master_enabled = isChecked;

        const overrides = JSON.parse(localStorage.getItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY) || '{}');
        overrides.cwb_master_enabled = isChecked;
        localStorage.setItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY, JSON.stringify(overrides));

        state.masterEnabled = isChecked;

        saveSettingsDebounced();

        updateControlsLockState();

        const $viewerButton = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
        if ($viewerButton.length > 0) {
            const shouldShow = isChecked && state.viewerEnabled;
            $viewerButton.toggle(shouldShow);
        }
        
        showToastr('info', `CharacterWorldBook 已 ${isChecked ? '启用' : '禁用'}`);

        $(document).trigger('cwb:master-switch-changed', { isEnabled: isChecked });
    });
}

function updateApiModeUI(mode) {
    const fields = {
        openai: [
            'label[for="cwb-api-url"]',
            '#cwb-api-url',
            'label[for="cwb-api-key"]',
            '#cwb-api-key',
            'label[for="cwb-api-model"]',
            '#cwb-api-model',
            '#cwb-load-models'
        ],
        sillytavern: [
            'label[for="cwb-tavern-profile"]',
            '#cwb-tavern-profile'
        ]
    };

    if (mode === 'sillytavern_preset') {
        fields.openai.forEach(selector => $panel.find(selector).hide());
        fields.sillytavern.forEach(selector => $panel.find(selector).show());
    } else {
        fields.sillytavern.forEach(selector => $panel.find(selector).hide());
        fields.openai.forEach(selector => $panel.find(selector).show());
    }

    updateApiStatusDisplay($panel);
}

function loadSillyTavernPresets(showNotification = false) {
    const $profileSelect = $panel.find('#cwb-tavern-profile');
    
    try {
        const context = window.SillyTavern?.getContext?.();
        if (!context?.extensionSettings?.connectionManager?.profiles) {
            showToastr('warning', '无法获取SillyTavern配置文件列表');
            return;
        }
        
        const profiles = context.extensionSettings.connectionManager.profiles;
        
        $profileSelect.empty();
        $profileSelect.append('<option value="">选择预设</option>');
        
        profiles.forEach(profile => {
            $profileSelect.append(`<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`);
        });
        const currentProfile = getSettings().cwb_tavern_profile;
        if (currentProfile) {
            $profileSelect.val(currentProfile);
        }
        
        if (showNotification) {
            showToastr('success', `已加载 ${profiles.length} 个SillyTavern预设`);
        }
        
    } catch (error) {
        logError('加载SillyTavern预设失败:', error);
        showToastr('error', '加载SillyTavern预设失败');
    }
}

function updateUiWithSettings() {
    if (!$panel) return;
    const settings = getSettings();

    $panel.find('#cwb-api-mode').val(settings.cwb_api_mode || 'openai_test');

    const currentMode = settings.cwb_api_mode || 'openai_test';
    updateApiModeUI(currentMode);

    if (currentMode === 'sillytavern_preset') {
        loadSillyTavernPresets();
    }

    $panel.find('#cwb-api-url').val(settings.cwb_api_url);
    $panel.find('#cwb-api-key').val(settings.cwb_api_key);
    $panel.find('#cwb-tavern-profile').val(settings.cwb_tavern_profile);
    
    const $modelSelect = $panel.find('#cwb-api-model');
    if (settings.cwb_api_model) {
        $modelSelect.empty().append(`<option value="${escapeHtml(settings.cwb_api_model)}">${escapeHtml(settings.cwb_api_model)} (已保存)</option>`);
    } else {
        $modelSelect.empty().append('<option value="">请先加载并选择模型</option>');
    }
    updateApiStatusDisplay($panel);

    $panel.find('#cwb-break-armor-prompt-textarea').val(settings.cwb_break_armor_prompt);
    $panel.find('#cwb-char-card-prompt-textarea').val(settings.cwb_char_card_prompt);

    $panel.find('#cwb-temperature').val(settings.cwb_temperature);
    $panel.find('#cwb-temperature-value').text(settings.cwb_temperature);
    $panel.find('#cwb-max-tokens').val(settings.cwb_max_tokens);
    $panel.find('#cwb-max-tokens-value').text(settings.cwb_max_tokens);

    $panel.find('#cwb-auto-update-threshold').val(settings.cwb_auto_update_threshold);
    $panel.find('#cwb-scan-depth').val(settings.cwb_scan_depth);
    $panel.find('#cwb_master_enabled-checkbox').prop('checked', settings.cwb_master_enabled);
    $panel.find('#cwb-auto-update-enabled-checkbox').prop('checked', settings.cwb_auto_update_enabled);
    $panel.find('#cwb-viewer-enabled-checkbox').prop('checked', settings.cwb_viewer_enabled);
    $panel.find('#cwb-incremental-update-enabled-checkbox').prop('checked', settings.cwb_incremental_update_enabled);

    if (!$panel.find('#cwb-start-floor').val()) {
        $panel.find('#cwb-start-floor').val(1);
    }
    if (!$panel.find('#cwb-end-floor').val()) {
        $panel.find('#cwb-end-floor').val(1);
    }

    $panel.find('input[name="cwb_worldbook_target"]').each(function() {
        $(this).prop('checked', $(this).val() === settings.cwb_worldbook_target);
    });
    if (settings.cwb_worldbook_target === 'custom') {
        $panel.find('#cwb_worldbook_select_wrapper').show();
    } else {
        $panel.find('#cwb_worldbook_select_wrapper').hide();
    }
}

export function loadSettings() {
    console.log('[CWB] Loading settings...');
    
    const settings = getSettings();
    
    // Initialize settings with defaults if not present
    if (!settings) {
        extension_settings[extensionName] = { ...cwbCompleteDefaultSettings };
        console.log('[CWB] Initialized default settings');
    } else {
        // Ensure all default settings exist
        Object.keys(cwbCompleteDefaultSettings).forEach(key => {
            if (settings[key] === undefined || settings[key] === null) {
                settings[key] = cwbCompleteDefaultSettings[key];
            }
        });
    }

    const finalSettings = getSettings();
    
    // Apply localStorage overrides
    const overrides = JSON.parse(localStorage.getItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY) || '{}');
    if (overrides.cwb_master_enabled !== undefined) {
        finalSettings.cwb_master_enabled = overrides.cwb_master_enabled;
    }
    if (overrides.cwb_auto_update_enabled !== undefined) {
        finalSettings.cwb_auto_update_enabled = overrides.cwb_auto_update_enabled;
    }
    if (overrides.cwb_viewer_enabled !== undefined) {
        finalSettings.cwb_viewer_enabled = overrides.cwb_viewer_enabled;
    }
    if (overrides.cwb_incremental_update_enabled !== undefined) {
        finalSettings.cwb_incremental_update_enabled = overrides.cwb_incremental_update_enabled;
    }

    // Update state object with current settings
    state.masterEnabled = finalSettings.cwb_master_enabled;
    state.viewerEnabled = finalSettings.cwb_viewer_enabled;
    state.autoUpdateEnabled = finalSettings.cwb_auto_update_enabled;
    state.isIncrementalUpdateEnabled = finalSettings.cwb_incremental_update_enabled;
    
    state.customApiConfig.url = finalSettings.cwb_api_url || '';
    state.customApiConfig.apiKey = finalSettings.cwb_api_key || '';
    state.customApiConfig.model = finalSettings.cwb_api_model || '';
    
    state.currentBreakArmorPrompt = finalSettings.cwb_break_armor_prompt;
    state.currentCharCardPrompt = finalSettings.cwb_char_card_prompt;
    state.currentIncrementalCharCardPrompt = finalSettings.cwb_incremental_char_card_prompt;
    
    state.autoUpdateThreshold = finalSettings.cwb_auto_update_threshold;
    state.scanDepth = finalSettings.cwb_scan_depth;
    state.worldbookTarget = finalSettings.cwb_worldbook_target;
    state.customWorldBook = finalSettings.cwb_custom_worldbook;

    console.log('[CWB] State updated:', {
        masterEnabled: state.masterEnabled,
        viewerEnabled: state.viewerEnabled,
        autoUpdateEnabled: state.autoUpdateEnabled,
        worldbookTarget: state.worldbookTarget,
        customWorldBook: state.customWorldBook
    });
    if ($panel) {
        updateUiWithSettings();
    }

    updateControlsLockState();
    setTimeout(() => {
        const $viewerButton = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
        if ($viewerButton.length > 0) {
            const shouldShow = isCwbEnabled() && state.viewerEnabled;
            $viewerButton.toggle(shouldShow);
            console.log('[CWB] Viewer button visibility updated:', shouldShow);
        }
    }, 100);
}
