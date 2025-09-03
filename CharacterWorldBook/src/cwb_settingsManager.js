import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../../utils/settings.js';
import { saveSettingsDebounced } from '/script.js';
import { world_names } from '/scripts/world-info.js';
import { state } from './cwb_state.js';
import { cwbCompleteDefaultSettings } from './cwb_config.js';
import { logError, showToastr, escapeHtml, compareVersions, isCwbEnabled } from './cwb_utils.js';
import { fetchModelsAndConnect, updateApiStatusDisplay } from './cwb_apiService.js';
import { checkForUpdates } from './cwb_updater.js';
import { handleManualUpdateCard, startBatchUpdate, handleFloorRangeUpdate } from './cwb_core.js';
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

    const $controlsToToggle = $panel.find('input, textarea, select, button').not('#cwb_master_enabled-checkbox');

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

function bindWorldBookSettings() {
    const settings = getSettings();

    if (settings.cwb_worldbook_target === undefined) settings.cwb_worldbook_target = 'primary';
    if (settings.cwb_custom_worldbook === undefined) settings.cwb_custom_worldbook = null;

    const sourceRadios = $panel.find('input[name="cwb_worldbook_target"]');
    const customSelectWrapper = $panel.find('#cwb_worldbook_select_wrapper');
    const refreshButton = $panel.find('#cwb_refresh_worldbooks');
    const bookListContainer = $panel.find('#cwb_worldbook_radio_list');

    const renderWorldBookList = () => {
        const worldBooks = world_names.map(name => ({ name: name.replace('.json', ''), file_name: name }));
        bookListContainer.empty();

        if (worldBooks && worldBooks.length > 0) {
            worldBooks.forEach(book => {
                const div = $('<div class="checkbox-item"></div>').attr('title', book.name);
                const radio = $('<input type="radio" name="cwb_worldbook_selection">')
                    .attr('id', `cwb-wb-radio-${book.file_name}`)
                    .val(book.file_name)
                    .prop('checked', settings.cwb_custom_worldbook === book.file_name);

                radio.on('change', () => {
                    if (radio.prop('checked')) {
                        settings.cwb_custom_worldbook = book.file_name;
                        saveSettingsDebounced();
                        loadSettings(); 
                        showToastr('info', `已选择世界书: ${book.name}`);
                    }
                });

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

    sourceRadios.each(function() {
        $(this).prop('checked', $(this).val() === settings.cwb_worldbook_target);
    });
    updateCustomSelectVisibility();
    sourceRadios.on('change', function() {
        if ($(this).prop('checked')) {
            settings.cwb_worldbook_target = $(this).val();
            updateCustomSelectVisibility();
            saveSettingsDebounced();
            loadSettings(); // Sync to state
        }
    });

    refreshButton.on('click', renderWorldBookList);
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
        updateApiModeUI(selectedMode);
        if (selectedMode === 'sillytavern_preset') {
            loadSillyTavernPresets();
        }
    });
    $panel.on('change', '#cwb-tavern-profile', function() {
        const selectedProfile = $(this).val();
        if (selectedProfile) {
            console.log(`[CWB] 选择了预设: ${selectedProfile}`);
        }
    });
    $panel.on('click', '#cwb-load-models', () => fetchModelsAndConnect($panel));
    $panel.on('click', '#cwb-save-config', saveApiConfig);
    $panel.on('click', '#cwb-clear-config', clearApiConfig);

    $panel.on('click', '#cwb-save-break-armor-prompt', saveBreakArmorPrompt);
    $panel.on('click', '#cwb-reset-break-armor-prompt', resetBreakArmorPrompt);
    $panel.on('click', '#cwb-save-char-card-prompt', saveCharCardPrompt);
    $panel.on('click', '#cwb-reset-char-card-prompt', resetCharCardPrompt);

    $panel.on('click', '#cwb-save-auto-update-threshold', saveAutoUpdateThreshold);
    $panel.on('click', '#cwb-manual-update-card', () => handleManualUpdateCard($panel));
    $panel.on('click', '#cwb-batch-update-card', () => startBatchUpdate($panel));
    $panel.on('click', '#cwb-floor-range-update', () => handleFloorRangeUpdate($panel));
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
    const $apiUrlLabel = $panel.find('label[for="cwb-api-url"]');
    const $apiUrlField = $panel.find('#cwb-api-url');
    const $apiKeyLabel = $panel.find('label[for="cwb-api-key"]');
    const $apiKeyField = $panel.find('#cwb-api-key');
    const $apiModelLabel = $panel.find('label[for="cwb-api-model"]');
    const $apiModelWrapper = $panel.find('#cwb-api-model').parent();
    const $loadModelsButton = $panel.find('#cwb-load-models');
    
    const $tavernProfileLabel = $panel.find('label[for="cwb-tavern-profile"]');
    const $tavernProfileField = $panel.find('#cwb-tavern-profile');
    
    if (mode === 'sillytavern_preset') {
        $apiUrlLabel.hide();
        $apiUrlField.hide();
        $apiKeyLabel.hide();
        $apiKeyField.hide();
        $apiModelLabel.hide();
        $apiModelWrapper.hide();
        $loadModelsButton.hide();
        
        $tavernProfileLabel.show();
        $tavernProfileField.show();
    } else {
        $apiUrlLabel.show();
        $apiUrlField.show();
        $apiKeyLabel.show();
        $apiKeyField.show();
        $apiModelLabel.show();
        $apiModelWrapper.show();
        $loadModelsButton.show();
        
        $tavernProfileLabel.hide();
        $tavernProfileField.hide();
    }

    updateApiStatusDisplay($panel);
}

function loadSillyTavernPresets() {
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
        
        showToastr('success', `已加载 ${profiles.length} 个SillyTavern预设`);
        
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

    $panel.find('#cwb-auto-update-threshold').val(settings.cwb_auto_update_threshold);
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
    if (!$panel) {
        logError('Settings panel is not yet available for loading settings.');
        return;
    }

    const settings = getSettings();
    if (!settings) {
        logError('CWB settings not found in extension_settings.');
        return;
    }

    Object.keys(cwbCompleteDefaultSettings).forEach(key => {
        if (settings[key] === undefined || settings[key] === null) {
            settings[key] = cwbCompleteDefaultSettings[key];
        }
    });

    const overrides = JSON.parse(localStorage.getItem(CWB_BOOLEAN_SETTINGS_OVERRIDE_KEY) || '{}');
    if (overrides.cwb_master_enabled !== undefined) {
        settings.cwb_master_enabled = overrides.cwb_master_enabled;
    }
    if (overrides.cwb_auto_update_enabled !== undefined) {
        settings.cwb_auto_update_enabled = overrides.cwb_auto_update_enabled;
    }
    if (overrides.cwb_viewer_enabled !== undefined) {
        settings.cwb_viewer_enabled = overrides.cwb_viewer_enabled;
    }
    if (overrides.cwb_incremental_update_enabled !== undefined) {
        settings.cwb_incremental_update_enabled = overrides.cwb_incremental_update_enabled;
    }

    state.masterEnabled = settings.cwb_master_enabled;
    state.customApiConfig.url = settings.cwb_api_url;
    state.customApiConfig.apiKey = settings.cwb_api_key;
    state.customApiConfig.model = settings.cwb_api_model;
    state.currentBreakArmorPrompt = settings.cwb_break_armor_prompt;
    state.currentCharCardPrompt = settings.cwb_char_card_prompt;
    state.currentIncrementalCharCardPrompt = settings.cwb_incremental_char_card_prompt;

    state.currentBreakArmorPrompt = settings.cwb_break_armor_prompt;
    state.currentCharCardPrompt = settings.cwb_char_card_prompt;
    state.currentIncrementalCharCardPrompt = settings.cwb_incremental_char_card_prompt;

    state.autoUpdateThreshold = settings.cwb_auto_update_threshold;
    state.autoUpdateEnabled = settings.cwb_auto_update_enabled;
    state.viewerEnabled = settings.cwb_viewer_enabled;
    state.isIncrementalUpdateEnabled = settings.cwb_incremental_update_enabled;

    state.worldbookTarget = settings.cwb_worldbook_target;
    state.customWorldBook = settings.cwb_custom_worldbook;

    if ($panel) {
        updateUiWithSettings();
    }

    updateControlsLockState();

    saveSettingsDebounced();
}
