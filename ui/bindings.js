import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, this_chid, saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { defaultSettings, extensionName, saveSettings, extensionBasePath } from "../utils/settings.js";
import {
    pluginAuthStatus,
    activatePluginAuthorization,
    getPasswordForDate,
    refreshUserInfo,
    resetPluginAuthorizationState,
} from "../utils/auth.js";
import {
    enrollDeviceCredential,
    getDeviceCredentialStatus,
    revokeAndForgetDeviceCredential,
} from "../utils/device-credential.js";
import { bindDeviceCredentialManagement, confirmDeviceCredentialAction } from './device-credential-management.js';
import { fetchModels, testApiConnection } from "../core/api.js";
import { safeLorebooks, safeCharLorebooks, safeLorebookEntries } from "../core/tavernhelper-compatibility.js";
import { configManager } from '../utils/config/ConfigManager.js';
import { markSecretInputStored } from './secret-input.js';

import { setAvailableModels, populateModelDropdown, getLatestUpdateInfo } from "./state.js";
import { fixCommand, testReplyChecker } from "../core/commands.js";
import { messageFormatting } from '/script.js';
import { executeManualCommand } from '../core/autoHideManager.js';
import { showContentModal, showHtmlModal, showCwbWarningModal } from './page-window.js';
import { openAutoCharCardWindow } from '../core/auto-char-card/ui-bindings.js';
import { showPresetSettings } from '../PresetSettings/prese_ui.js';
import { watchProfileSliderGuard } from './profile-slider-guard.js';
import { refreshSuperMemoryPanel } from '../core/super-memory/bindings.js';
import { hasSuperMemoryAccess } from '../core/super-memory/access-policy.js';
import { refreshProgressiveMemorySourceOptions } from '../core/progressive-memory/bindings.js';
import { refreshTimeRiverPanel } from '../core/time-river/bindings.js';
import { getTimeRiverAccess } from '../core/time-river/auth.js';
import { hasCombatType3Access } from '../core/combat/access-policy.js';
import { refreshCombatPanel } from './combat-bindings.js';
import { getSecurityAuditAccess } from '../core/security-audit/access-policy.js';
import { escapeHTML } from '../utils/utils.js';
import { applyTranslations, getLocale, setLocale, subscribeLocaleChange, t } from '../utils/i18n/index.js';
import { applyLocalePreference } from '../utils/i18n/onboarding.js';

function displayDailyAuthCode() {
    const displayEl = document.getElementById('amily2_daily_code_display');
    const copyBtn = document.getElementById('amily2_copy_daily_code');

    if (displayEl && copyBtn) {
        const todayCode = getPasswordForDate(new Date());
        displayEl.textContent = todayCode;

        if(copyBtn) copyBtn.style.display = 'inline-block';

        copyBtn.onclick = () => {
            navigator.clipboard.writeText(todayCode).then(() => {
                toastr.success(t('auth.copySuccess'));
            }, () => {
                toastr.error(t('auth.copyFailure'));
            });
        };
    }
}

let unsubscribeLocaleControls = () => {};
let unsubscribeDeviceLocale = () => {};

function deviceCredentialStatusText(status) {
    if (status.state === 'active') {
        const device = status.deviceLabel || t('shell.device.current');
        return status.permanent ? t('shell.device.permanent', { device })
            : t('shell.device.active', { device, expiry: new Date(status.expiresAt).toLocaleString() });
    }
    if (status.state === 'expired') return t('shell.device.expired');
    if (status.state === 'unavailable') return t('shell.device.unavailable');
    return t('shell.device.none');
}

function bindLocaleControls(container) {
    if (!container?.length) return;
    const settings = extension_settings[extensionName];
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    setLocale(settings.uiLocale ?? defaultSettings.uiLocale, {
        notify: false,
    });
    const syncControls = () => $('.amily2-ui-locale-select').val(getLocale());
    unsubscribeLocaleControls();
    unsubscribeLocaleControls = subscribeLocaleChange(() => {
        syncControls();
        populateModelDropdown();
    });
    syncControls();

    container
        .off('change.amily2.locale', '.amily2-ui-locale-select')
        .on('change.amily2.locale', '.amily2-ui-locale-select', function () {
            try {
                const nextLocale = applyLocalePreference(extension_settings[extensionName], this.value, {
                    save: saveSettingsDebounced,
                });
                syncControls();
                if (nextLocale) toastr.success(t('settings.language.changed'), t('app.toastTitle'));
            } catch (error) {
                syncControls();
                toastr.error(t('settings.language.saveFailed'), t('app.toastTitle'));
                console.error('[Amily2 i18n] Unable to save locale preference:', error);
            }
        });
}


async function loadSillyTavernPresets() {
    console.log('[Amily2号-UI] 正在加载SillyTavern预设列表');
    
    const select = $('#amily2_preset_selector');
    const settings = extension_settings[extensionName] || {};
    const currentProfileId = settings.tavernProfile || settings.selectedPreset;

    select.empty().append(new Option(t('shell.presets.choose'), ''));

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];
        
        if (!tavernProfiles || tavernProfiles.length === 0) {
            select.append($('<option>', { value: '', text: t('shell.presets.empty'), disabled: true }));
            console.warn('[Amily2号-UI] 未找到SillyTavern预设');
            return;
        }

        let foundCurrentProfile = false;
        tavernProfiles.forEach(profile => {
            if (profile.api && profile.preset) {
                const option = new Option(profile.name || profile.id, profile.id);
                if (profile.id === currentProfileId) {
                    option.selected = true;
                    foundCurrentProfile = true;
                }
                select.append(option);
            }
        });

        if (currentProfileId && !foundCurrentProfile) {
            toastr.warning(t('shell.presets.missing', { profile: currentProfileId }), t('app.toastTitle'));
            const updateAndSaveSetting = (key, value) => {
                if (!extension_settings[extensionName]) {
                    extension_settings[extensionName] = {};
                }
                extension_settings[extensionName][key] = value;
                saveSettingsDebounced();
            };
            updateAndSaveSetting('selectedPreset', '');
            updateAndSaveSetting('tavernProfile', '');
        } else if (foundCurrentProfile) {
            console.log(`[Amily2号-UI] SillyTavern预设已成功恢复：${currentProfileId}`);
        }

        const validProfiles = tavernProfiles.filter(p => p.api && p.preset);
        console.log(`[Amily2号-UI] SillyTavern预设列表加载完成，找到 ${validProfiles.length} 个有效预设`);
        
    } catch (error) {
        console.error(`[Amily2号-UI] 加载酒馆API预设失败:`, error);
        select.append($('<option>', { value: '', text: t('shell.presets.failed'), disabled: true }));
        toastr.error(t('shell.presets.failureDetail'), t('app.toastTitle'));
    }
}


function updateApiProviderUI() {
    const settings = extension_settings[extensionName] || {};
    const provider = settings.apiProvider || 'openai';

    $('#amily2_api_provider').val(provider);

    $('#amily2_api_provider').trigger('change');
}

function bindAmily2ModalWorldBookSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const settings = extension_settings[extensionName];

    const enabledCheckbox = document.getElementById('amily2_wb_enabled');
    const optionsContainer = document.getElementById('amily2_wb_options_container');
    const sourceRadios = document.querySelectorAll('input[name="amily2_wb_source"]');
    const manualSelectWrapper = document.getElementById('amily2_wb_select_wrapper');
    const bookListContainer = document.getElementById('amily2_wb_checkbox_list');
    const entryListContainer = document.getElementById('amily2_wb_entry_list');

    if (!enabledCheckbox || !optionsContainer || !sourceRadios.length || !manualSelectWrapper || !bookListContainer || !entryListContainer) {
        console.warn('[Amily2 Modal] World book UI elements not found, skipping bindings.');
        return;
    }

    // Ensure settings objects exist before reading
    if (settings.modal_amily2_wb_selected_worldbooks === undefined) {
        settings.modal_amily2_wb_selected_worldbooks = [];
    }
    if (settings.modal_amily2_wb_selected_entries === undefined) {
        settings.modal_amily2_wb_selected_entries = {};
    }


    const renderWorldBookEntries = async () => {

        entryListContainer.innerHTML = `<p class="notes" data-amily-i18n="shell.world.entriesLoading">${escapeHTML(t('shell.world.entriesLoading'))}</p>`;
        const source = settings.modal_wbSource || 'character';
        let bookNames = [];

        if (source === 'manual') {
            bookNames = settings.modal_amily2_wb_selected_worldbooks || [];
        } else {
            if (this_chid !== undefined && this_chid >= 0 && characters[this_chid]) {
                try {
                    const charLorebooks = await safeCharLorebooks({ type: 'all' });
                    if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
                    if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
                } catch (error) {
                    console.error(`[Amily2 Modal] Failed to get character world books:`, error);
                    entryListContainer.innerHTML = `<p class="notes" style="color:red;" data-amily-i18n="shell.world.characterFailed">${escapeHTML(t('shell.world.characterFailed'))}</p>`;
                    return;
                }
            } else {
                entryListContainer.innerHTML = `<p class="notes" data-amily-i18n="shell.world.characterRequired">${escapeHTML(t('shell.world.characterRequired'))}</p>`;
                return;
            }
        }

        if (bookNames.length === 0) {
            entryListContainer.innerHTML = `<p class="notes" data-amily-i18n="shell.world.unselected">${escapeHTML(t('shell.world.unselected'))}</p>`;
            return;
        }

        try {
            const allEntries = [];
            for (const bookName of bookNames) {
                const entries = await safeLorebookEntries(bookName);
                entries.forEach(entry => allEntries.push({ ...entry, bookName }));
            }

            entryListContainer.innerHTML = '';
            if (allEntries.length === 0) {
                entryListContainer.innerHTML = `<p class="notes" data-amily-i18n="shell.world.entriesEmpty">${escapeHTML(t('shell.world.entriesEmpty'))}</p>`;
                return;
            }

            allEntries.forEach(entry => {
                const div = document.createElement('div');
                div.className = 'checkbox-item';
                div.title = t('shell.world.entryTitle', { book: entry.bookName, uid: entry.uid });
                div.style.display = 'flex';
                div.style.alignItems = 'center';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.style.marginRight = '5px';
                checkbox.id = `amily2-wb-entry-check-${entry.bookName}-${entry.uid}`;
                checkbox.dataset.book = entry.bookName;
                checkbox.dataset.uid = entry.uid;
                
                const isChecked = settings.modal_amily2_wb_selected_entries[entry.bookName]?.includes(String(entry.uid));
                checkbox.checked = !!isChecked;

                const label = document.createElement('label');
                label.htmlFor = checkbox.id;
                label.textContent = entry.comment || t('shell.world.untitled');
                if (!entry.comment) label.setAttribute('data-amily-i18n', 'shell.world.untitled');

                div.appendChild(checkbox);
                div.appendChild(label);
                entryListContainer.appendChild(div);
            });
        } catch (error) {
            console.error(`[Amily2 Modal] Failed to load world book entries:`, error);
            entryListContainer.innerHTML = `<p class="notes" style="color:red;" data-amily-i18n="shell.world.entriesFailed">${escapeHTML(t('shell.world.entriesFailed'))}</p>`;
        }
    };

    const renderWorldBookList = async () => {
        bookListContainer.innerHTML = `<p class="notes" data-amily-i18n="shell.world.booksLoading">${escapeHTML(t('shell.world.booksLoading'))}</p>`;
        try {
            const worldBooks = await safeLorebooks();
            bookListContainer.innerHTML = '';
            if (worldBooks && worldBooks.length > 0) {
                worldBooks.forEach(bookName => {
                    const div = document.createElement('div');
                    div.className = 'checkbox-item';
                    div.title = bookName;
                    div.style.display = 'flex';
                    div.style.alignItems = 'center';

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.style.marginRight = '5px';
                    checkbox.id = `amily2-wb-check-${bookName}`;
                    checkbox.value = bookName;
                    checkbox.checked = settings.modal_amily2_wb_selected_worldbooks.includes(bookName);

                    const label = document.createElement('label');
                    label.htmlFor = `amily2-wb-check-${bookName}`;
                    label.textContent = bookName;

                    div.appendChild(checkbox);
                    div.appendChild(label);
                    bookListContainer.appendChild(div);
                });
            } else {
                bookListContainer.innerHTML = `<p class="notes" data-amily-i18n="shell.world.booksEmpty">${escapeHTML(t('shell.world.booksEmpty'))}</p>`;
            }
        } catch (error) {
            console.error(`[Amily2 Modal] Failed to load world book list:`, error);
            bookListContainer.innerHTML = `<p class="notes" style="color:red;" data-amily-i18n="shell.world.booksFailed">${escapeHTML(t('shell.world.booksFailed'))}</p>`;
        }
        renderWorldBookEntries();
    };
    
    const updateVisibility = () => {
        const settings = extension_settings[extensionName];
        const isEnabled = enabledCheckbox.checked;
        optionsContainer.style.display = isEnabled ? 'block' : 'none';
        
        if (isEnabled) {
            const isManual = settings.modal_wbSource === 'manual';
            manualSelectWrapper.style.display = isManual ? 'block' : 'none';
            renderWorldBookEntries();
            if (isManual) {
                renderWorldBookList();
            }
        }
    };

    // Initial state setup
    enabledCheckbox.checked = settings.modal_wbEnabled ?? false;
    const source = settings.modal_wbSource ?? 'character';
    sourceRadios.forEach(radio => {
        radio.checked = radio.value === source;
    });
    updateVisibility();

    // Event Listeners
    $(enabledCheckbox).off('change.amily2_wb').on('change.amily2_wb', () => {
        extension_settings[extensionName].modal_wbEnabled = enabledCheckbox.checked;
        saveSettingsDebounced();
        updateVisibility();
    });

    $(sourceRadios).off('change.amily2_wb').on('change.amily2_wb', (event) => {
        if (event.target.checked) {
            extension_settings[extensionName].modal_wbSource = event.target.value;
            saveSettingsDebounced();
            updateVisibility();
        }
    });

    $(bookListContainer).off('change.amily2_wb').on('change.amily2_wb', (event) => {
        if (event.target.type === 'checkbox' && event.target.id.startsWith('amily2-wb-check-')) {
            const checkbox = event.target;
            const bookName = checkbox.value;

            if (!settings.modal_amily2_wb_selected_worldbooks) {
                settings.modal_amily2_wb_selected_worldbooks = [];
            }

            if (checkbox.checked) {
                if (!settings.modal_amily2_wb_selected_worldbooks.includes(bookName)) {
                    settings.modal_amily2_wb_selected_worldbooks.push(bookName);
                }
            } else {
                const index = settings.modal_amily2_wb_selected_worldbooks.indexOf(bookName);
                if (index > -1) {
                    settings.modal_amily2_wb_selected_worldbooks.splice(index, 1);
                }
                if (settings.modal_amily2_wb_selected_entries) {
                    delete settings.modal_amily2_wb_selected_entries[bookName];
                }
            }
            saveSettingsDebounced();
            renderWorldBookEntries();
        }
    });

    $(entryListContainer).off('change.amily2_wb').on('change.amily2_wb', (event) => {
        if (event.target.type === 'checkbox') {
            const checkbox = event.target;
            const book = checkbox.dataset.book;
            const uid = checkbox.dataset.uid;

            if (!settings.modal_amily2_wb_selected_entries) {
                settings.modal_amily2_wb_selected_entries = {};
            }
            if (!settings.modal_amily2_wb_selected_entries[book]) {
                settings.modal_amily2_wb_selected_entries[book] = [];
            }

            const entryIndex = settings.modal_amily2_wb_selected_entries[book].indexOf(uid);

            if (checkbox.checked) {
                if (entryIndex === -1) {
                    settings.modal_amily2_wb_selected_entries[book].push(uid);
                }
            } else {
                if (entryIndex > -1) {
                    settings.modal_amily2_wb_selected_entries[book].splice(entryIndex, 1);
                }
            }
            
            if (settings.modal_amily2_wb_selected_entries[book].length === 0) {
                delete settings.modal_amily2_wb_selected_entries[book];
            }

            saveSettingsDebounced();
        }
    });

    // Search and Select/Deselect All Logic
    const bookSearchInput = document.getElementById('amily2_wb_book_search');
    const bookSelectAllBtn = document.getElementById('amily2_wb_book_select_all');
    const bookDeselectAllBtn = document.getElementById('amily2_wb_book_deselect_all');
    const entrySearchInput = document.getElementById('amily2_wb_entry_search');
    const entrySelectAllBtn = document.getElementById('amily2_wb_entry_select_all');
    const entryDeselectAllBtn = document.getElementById('amily2_wb_entry_deselect_all');

    bookSearchInput.addEventListener('input', () => {
        const searchTerm = bookSearchInput.value.toLowerCase();
        const items = bookListContainer.querySelectorAll('.checkbox-item');
        items.forEach(item => {
            const label = item.querySelector('label');
            if (label.textContent.toLowerCase().includes(searchTerm)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    });

    entrySearchInput.addEventListener('input', () => {
        const searchTerm = entrySearchInput.value.toLowerCase();
        const items = entryListContainer.querySelectorAll('.checkbox-item');
        items.forEach(item => {
            const label = item.querySelector('label');
            if (label.textContent.toLowerCase().includes(searchTerm)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    });

    bookSelectAllBtn.addEventListener('click', () => {
        const checkboxes = bookListContainer.querySelectorAll('.checkbox-item input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            if (checkbox.parentElement.style.display !== 'none' && !checkbox.checked) {
                $(checkbox).prop('checked', true).trigger('change');
            }
        });
    });

    bookDeselectAllBtn.addEventListener('click', () => {
        const checkboxes = bookListContainer.querySelectorAll('.checkbox-item input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            if (checkbox.parentElement.style.display !== 'none' && checkbox.checked) {
                $(checkbox).prop('checked', false).trigger('change');
            }
        });
    });

    entrySelectAllBtn.addEventListener('click', () => {
        const checkboxes = entryListContainer.querySelectorAll('.checkbox-item input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            if (checkbox.parentElement.style.display !== 'none' && !checkbox.checked) {
                $(checkbox).prop('checked', true).trigger('change');
            }
        });
    });

    entryDeselectAllBtn.addEventListener('click', () => {
        const checkboxes = entryListContainer.querySelectorAll('.checkbox-item input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            if (checkbox.parentElement.style.display !== 'none' && checkbox.checked) {
                $(checkbox).prop('checked', false).trigger('change');
            }
        });
    });

    console.log('[Amily2 Modal] World book settings bound successfully.');

    document.addEventListener('renderAmily2WorldBook', () => {
        console.log('[Amily2 Modal] Received render event from state update.');
        updateVisibility();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('[Amily2 Modal] Chat changed, re-rendering world book entries.');
        if (document.getElementById('amily2_wb_options_container')?.style.display === 'block') {
            renderWorldBookEntries();
        }
    });
}

export function bindModalEvents() {
    const refreshButton = document.getElementById('amily2_refresh_models');
    if (refreshButton && !document.getElementById('amily2_test_api_connection')) {
        const testButton = document.createElement('button');
        testButton.id = 'amily2_test_api_connection';
        testButton.className = 'menu_button interactable';
        testButton.innerHTML = '<i class="fas fa-plug"></i> <span data-amily-i18n="actions.testConnection">测试连接</span>';
        refreshButton.insertAdjacentElement('afterend', testButton);
    }

    bindAmily2ModalWorldBookSettings();

    const container = $("#amily2_drawer_content").length ? $("#amily2_drawer_content") : $("#amily2_chat_optimiser");
    let deviceCredentialStatusRevision = 0;
    let deviceCredentialDisplay = null;
    unsubscribeDeviceLocale();
    unsubscribeDeviceLocale = subscribeLocaleChange(() => {
        const cached = deviceCredentialDisplay;
        if (!cached || !container[0]?.isConnected || cached.authRevision !== pluginAuthStatus.revision
            || cached.authorizationCode !== sessionStorage.getItem('plugin_auth_code')) return;
        const target = container.find('#amily2_device_credential_status');
        if (target.text() !== cached.text) return;
        cached.text = deviceCredentialStatusText(cached.status);
        target.text(cached.text);
    });
    const renderDeviceCredentialStatus = async ({ isCurrent = () => true } = {}) => {
        const revision = ++deviceCredentialStatusRevision;
        const authRevision = pluginAuthStatus.revision;
        const authorizationCode = sessionStorage.getItem('plugin_auth_code');
        const status = await getDeviceCredentialStatus();
        if (!container[0]?.isConnected || revision !== deviceCredentialStatusRevision
            || authRevision !== pluginAuthStatus.revision
            || authorizationCode !== sessionStorage.getItem('plugin_auth_code') || !isCurrent()) return status;
        const statusElement = container.find('#amily2_device_credential_status');
        const forgetButton = container.find('#amily2_device_credential_forget');
        const text = deviceCredentialStatusText(status);
        deviceCredentialDisplay = { status, text, authRevision, authorizationCode };
        statusElement.text(text);
        if (status.state === 'active') {
            deviceCredentialPermanentInput.prop('checked', status.permanent === true);
            syncDeviceCredentialDuration();
            forgetButton.prop('disabled', false);
        } else if (status.state === 'expired') {
            forgetButton.prop('disabled', false);
        } else if (status.state === 'unavailable') {
            forgetButton.prop('disabled', true);
        } else {
            forgetButton.prop('disabled', true);
        }
        return status;
    };
    const deviceLabelInput = container.find('#amily2_device_credential_label');
    if (deviceLabelInput.length && !deviceLabelInput.val()) {
        deviceLabelInput.val(navigator.userAgentData?.platform || navigator.platform || t('shell.device.browser'));
    }
    const deviceCredentialDaysInput = container.find('#amily2_device_credential_days');
    const deviceCredentialPermanentInput = container.find('#amily2_device_credential_permanent');
    const syncDeviceCredentialDuration = () => {
        const permanent = deviceCredentialPermanentInput.prop('checked') === true;
        deviceCredentialDaysInput
            .prop('disabled', permanent)
            .attr('aria-disabled', permanent ? 'true' : 'false');
    };
    syncDeviceCredentialDuration();
    void renderDeviceCredentialStatus();
    bindDeviceCredentialManagement(container[0], {
        confirmRef: message => confirmDeviceCredentialAction(message, container[0].ownerDocument),
        onLocalChange: renderDeviceCredentialStatus,
    });
    const apiConfigButton = container.find('#amily2_open_api_config');
    if (apiConfigButton.length && !container.find('#amily2_open_rule_config').length) {
        // 经典首页：系统配置区与 API 同排插入「规则配置」
        const ruleConfigBtn =
            '<button id="amily2_open_rule_config" class="menu_button wide_button" type="button">' +
            '<i class="fas fa-list-check"></i> <span data-amily-i18n="nav.ruleConfig">规则配置</span>' +
            '</button>';
        const group = apiConfigButton.closest('.button-group');
        if (group.length) {
            group.append(ruleConfigBtn);
        } else {
            apiConfigButton.after(ruleConfigBtn);
        }
    }

    bindLocaleControls(container);

    // Collapsible sections logic
    container.find('.collapsible-legend').each(function() {
        $(this).on('click', function(e) {
            e.preventDefault();
            e.stopPropagation();

            const legend = $(this);
            const content = legend.siblings('.collapsible-content');
            const icon = legend.find('.collapse-icon');
            
            const isCurrentlyVisible = content.is(':visible');
            const isCollapsedAfterClick = isCurrentlyVisible;

            if (isCollapsedAfterClick) {
                content.hide();
                icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
            } else {
                content.show();
                icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
            }
            
            const sectionId = legend.closest('.collapsible').attr('data-amily-collapse-key')
                || legend.text().trim();
            if (!extension_settings[extensionName]) {
                extension_settings[extensionName] = {};
            }
            extension_settings[extensionName][`collapsible_${sectionId}_collapsed`] = isCollapsedAfterClick;
            saveSettingsDebounced();
        });
    });
    
    displayDailyAuthCode(); 
    function updateModelInputView() {
        const settings = extension_settings[extensionName] || {};
        const forceProxy = settings.forceProxyForCustomApi === true;
        const model = settings.model || '';

        container.find('#amily2_force_proxy').prop('checked', forceProxy);
        container.find('#amily2_manual_model_input').val(model);

        const apiKeyWrapper = container.find('#amily2_api_key_wrapper');
        const autoFetchWrapper = container.find('#amily2_model_autofetch_wrapper');
        const manualInput = container.find('#amily2_manual_model_input');

        if (forceProxy) {
            apiKeyWrapper.hide();
            autoFetchWrapper.show(); 
            manualInput.hide();
        } else {
            apiKeyWrapper.show();
            autoFetchWrapper.show();
            manualInput.hide();
        }
    }

    if (!container.length || container.data("events-bound")) return;

    container
        .off("change.amily2.device_credential_permanent")
        .on("change.amily2.device_credential_permanent", "#amily2_device_credential_permanent", () => {
            syncDeviceCredentialDuration();
        });

    const snakeToCamel = (s) => s.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    const updateAndSaveSetting = (key, value) => {
        console.log(`[Amily-谕令确认] 收到指令: 将 [${key}] 设置为 ->`, value);
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName][key] = value;
        saveSettingsDebounced();
        console.log(`[Amily-谕令镌刻] [${key}] 的新状态已保存。`);
    };

    container
        .off("change.amily2.force_proxy")
        .on("change.amily2.force_proxy", '#amily2_force_proxy', function () {
            if (!pluginAuthStatus.authorized) return;
            updateAndSaveSetting('forceProxyForCustomApi', this.checked);
            updateModelInputView();

            $('#amily2_refresh_models').trigger('click');
        });
    container
        .off("change.amily2.manual_model")
        .on("change.amily2.manual_model", '#amily2_manual_model_input', function() {
            if (!pluginAuthStatus.authorized) return;
            updateAndSaveSetting('model', this.value);
            toastr.success(t('shell.model.saved', { model: this.value }), t('app.toastTitle'));
        });


    container
        .off("click.amily2.auth")
        .on("click.amily2.auth", "#auth_submit", async function () {
            const authCode = $("#amily2_auth_code").val().trim();
            if (authCode) {
                await activatePluginAuthorization(authCode);
            } else {
                toastr.warning(t('auth.codeRequired'), t('app.toastTitle'));
            }
        });

    container
        .off("click.amily2.device_credential_enroll")
        .on("click.amily2.device_credential_enroll", "#amily2_device_credential_enroll", async function () {
            const button = $(this);
            if (button.prop('disabled')) return;
            button.prop('disabled', true);
            try {
                const suppliedCode = container.find('#amily2_device_credential_code').val().trim();
                if (suppliedCode) {
                    const activated = await activatePluginAuthorization(suppliedCode);
                    if (!activated) return;
                }
                const authorizationCode = sessionStorage.getItem('plugin_auth_code');
                if (!authorizationCode || localStorage.getItem('plugin_auth_source') !== 'server') {
                    toastr.warning(t('shell.device.authRequired'), t('shell.device.title'));
                    return;
                }
                const permanent = container.find('#amily2_device_credential_permanent').prop('checked') === true;
                const ttlDays = Number(container.find('#amily2_device_credential_days').val());
                const deviceLabel = container.find('#amily2_device_credential_label').val().trim();
                if (!permanent && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90)) {
                    toastr.warning(t('shell.device.invalidDays'), t('shell.device.title'));
                    return;
                }
                const result = await enrollDeviceCredential({
                    authorizationCode,
                    ttlDays,
                    permanent,
                    deviceLabel,
                });
                container.find('#amily2_device_credential_code').val('');
                await renderDeviceCredentialStatus();
                toastr.success(
                    result.permanent
                        ? t('shell.device.savedPermanent')
                        : t('shell.device.savedUntil', { expiry: new Date(result.expiresAt).toLocaleString() }),
                    t('shell.device.title'),
                );
            } catch {
                toastr.error(t('shell.device.saveFailed'), t('shell.device.title'));
            } finally {
                button.prop('disabled', false);
            }
        });

    container
        .off("click.amily2.device_credential_forget")
        .on("click.amily2.device_credential_forget", "#amily2_device_credential_forget", async function () {
            const button = $(this);
            if (button.prop('disabled')) return;
            button.prop('disabled', true);
            try {
                const authRevision = pluginAuthStatus.revision;
                const authorizationCode = sessionStorage.getItem('plugin_auth_code');
                const authSource = localStorage.getItem('plugin_auth_source');
                const isCurrent = () => this.isConnected && container[0]?.contains(this)
                    && authRevision === pluginAuthStatus.revision
                    && authorizationCode === sessionStorage.getItem('plugin_auth_code')
                    && authSource === localStorage.getItem('plugin_auth_source');
                if (!await confirmDeviceCredentialAction(t('shell.device.forgetConfirm'), this.ownerDocument, t('shell.device.forget'))
                    || !isCurrent()) return;
                const result = await revokeAndForgetDeviceCredential({ isCurrent });
                if (!isCurrent()) return;
                if (result.remoteRevoked) {
                    toastr.success(t('shell.device.revoked'), t('shell.device.title'));
                } else {
                    toastr.warning(t('shell.device.localOnly'), t('shell.device.title'));
                }
            } catch (error) {
                if (error?.code !== 'STALE_DEVICE_CREDENTIAL_REQUEST') {
                    toastr.error(t('shell.device.forgetFailed'), t('shell.device.title'));
                }
            } finally {
                await renderDeviceCredentialStatus();
            }
        });

    container
        .off("click.amily2.actions")
        .on(
            "click.amily2.actions",
            "#amily2_refresh_models, #amily2_test_api_connection, #amily2_test, #amily2_fix_now",
            async function () {
                if (!pluginAuthStatus.authorized) return;
                const button = $(this);
                const originalHtml = button.html();
                button
                    .prop("disabled", true)
                    .html(`<i class="fas fa-spinner fa-spin"></i> ${escapeHTML(t('shell.processing'))}`);
                try {
                    switch (this.id) {
                        case "amily2_refresh_models":
                            const models = await fetchModels();
                            if (models.length > 0) {
                                setAvailableModels(models);
                                localStorage.setItem(
                                  "cached_models_amily2",
                                  JSON.stringify(models),
                                );
                                populateModelDropdown();
                            }
                            break;
                        case "amily2_test_api_connection":
                            await testApiConnection();
                            break;
                        case "amily2_test":
                            await testReplyChecker();
                            break;
                        case "amily2_fix_now":
                            await fixCommand();
                            break;
                    }
                } catch (error) {
                    console.error(`[Amily2-工部] 操作按钮 ${this.id} 执行失败:`, error);
                    toastr.error(t('shell.operationFailed', { error: error.message }), t('app.toastTitle'));
                } finally {
                    button.prop("disabled", false).html(originalHtml);
                }
            },
        );

    container
        .off("click.amily2.jump")
        .on("click.amily2.jump", "#amily2_jump_to_message_btn", function() {
            const targetId = parseInt($("#amily2_jump_to_message_id").val());
            if (isNaN(targetId)) {
                toastr.warning(t('shell.history.invalidFloor'));
                return;
            }
            
            // 1. 尝试查找 DOM 元素
            const targetElement = document.querySelector(`.mes[mesid="${targetId}"]`);
            
            if (targetElement) {
                // 【V60.1】增强跳转：自动展开被隐藏的楼层及其上下文
                const allMessages = Array.from(document.querySelectorAll('.mes'));
                const targetIndex = allMessages.indexOf(targetElement);
                
                if (targetIndex !== -1) {
                    // 展开前后各10条，确保上下文连贯
                    const contextRange = 10; 
                    const start = Math.max(0, targetIndex - contextRange);
                    const end = Math.min(allMessages.length - 1, targetIndex + contextRange);
                    
                    let unhiddenCount = 0;
                    for (let i = start; i <= end; i++) {
                        const msg = allMessages[i];
                        if (msg.style.display === 'none') {
                            msg.style.removeProperty('display');
                            unhiddenCount++;
                        }
                    }
                    if (unhiddenCount > 0) {
                        toastr.info(t('shell.history.revealed', { count: unhiddenCount }));
                    }
                }

                targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
                targetElement.classList.add('highlight_message'); 
                setTimeout(() => targetElement.classList.remove('highlight_message'), 2000);
                toastr.success(t('shell.history.jumped', { floor: targetId }));
            } else {
                // 2. DOM 中未找到，尝试从内存中获取并弹窗显示
                const context = getContext();
                if (context && context.chat && context.chat[targetId]) {
                    const msg = context.chat[targetId];
                    const sender = String(msg.name ?? '');
                    let formattedContent = msg.mes;
                    
                    // 尝试使用 SillyTavern 的格式化函数
                    if (typeof messageFormatting === 'function') {
                        formattedContent = messageFormatting(msg.mes, sender, false, false);
                    } else {
                        formattedContent = escapeHTML(String(msg.mes ?? '')).replace(/\n/g, '<br>');
                    }
                    
                    const html = `
                        <div style="padding: 10px;">
                            <div style="margin-bottom: 10px; font-size: 1.1em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                                <strong style="color: var(--smart-theme-color, #ffcc00);">${escapeHTML(sender)}</strong>
                                <span style="opacity: 0.6; font-size: 0.8em;">(${escapeHTML(t('shell.history.floor', { floor: targetId }))})</span>
                            </div>
                            <div class="mes_text" style="max-height: 60vh; overflow-y: auto;">
                                ${formattedContent}
                            </div>
                            <div style="margin-top: 15px; font-size: 0.9em; opacity: 0.7; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 5px;">
                                <i class="fas fa-info-circle"></i> ${escapeHTML(t('shell.history.notRendered'))}
                            </div>
                        </div>
                    `;
                    
                    showHtmlModal(t('shell.history.title'), html);
                    toastr.info(t('shell.history.shown', { floor: targetId }));
                } else {
                    toastr.error(t('shell.history.missing', { floor: targetId }));
                }
            }
        });

    container
        .off("click.amily2.expand_editor")
        .on("click.amily2.expand_editor", "#amily2_expand_editor", function (event) {
            if (!pluginAuthStatus.authorized) return;
            event.stopPropagation();
            const selectedKey = $("#amily2_prompt_selector").val();
            const currentContent = $("#amily2_unified_editor").val();
            const dialogHtml = `
                <dialog class="popup wide_dialogue_popup large_dialogue_popup">
                  <div class="popup-body">
                    <h4 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">${escapeHTML(t('shell.prompt.editing', { key: selectedKey }))}</h4>
                    <div class="popup-content" style="height: 70vh;"><div class="height100p wide100p flex-container"><textarea id="amily2_dialog_editor" class="height100p wide100p maximized_textarea text_pole"></textarea></div></div>
                    <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">${escapeHTML(t('actions.saveAndClose'))}</div><div class="popup-button-cancel menu_button interactable" style="margin-left: 10px;">${escapeHTML(t('actions.cancel'))}</div></div>
                  </div>
                </dialog>`;
            const dialogElement = $(dialogHtml).appendTo('body');
            const dialogTextarea = dialogElement.find('#amily2_dialog_editor');
            dialogTextarea.val(currentContent);
            const closeDialog = () => { dialogElement[0].close(); dialogElement.remove(); };
            dialogElement.find('.popup-button-ok').on('click', () => {
                const newContent = dialogTextarea.val();
                $("#amily2_unified_editor").val(newContent);
                updateAndSaveSetting(selectedKey, newContent);
                toastr.success(t('shell.prompt.saved', { key: selectedKey }), t('app.toastTitle'));
                closeDialog();
            });
            dialogElement.find('.popup-button-cancel').on('click', closeDialog);
            dialogElement[0].showModal();
        });

    container
        .off("click.amily2.tutorial")
        .on("click.amily2.tutorial", "#amily2_open_tutorial, #amily2_open_neige_tutorial, #amily2_open_table_tutorial, #amily2_open_plot_opt_tutorial, #amily2_open_super_memory_tutorial, #amily2_open_rule_config_tutorial, #amily2_open_time_river_tutorial, #amily2_open_shujuku_tutorial, #amily2_open_shujuku_agent_tutorial", function() {
            if (!pluginAuthStatus.authorized) return;

            const tutorials = {
                "amily2_open_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('shell.tutorial.home') }),
                    url: `${extensionBasePath}/ZhuDian.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('shell.tutorial.home') }),
                    advancedUrl: `${extensionBasePath}/ZhuDian-Advanced.md`,
                },
                "amily2_open_neige_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('nav.summary') }),
                    url: `${extensionBasePath}/NeiGe.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('nav.summary') }),
                    advancedUrl: `${extensionBasePath}/NeiGe-Advanced.md`,
                },
                "amily2_open_table_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('nav.tables') }),
                    url: `${extensionBasePath}/TableModule.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('nav.tables') }),
                    advancedUrl: `${extensionBasePath}/TableModule-Advanced.md`,
                },
                "amily2_open_plot_opt_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('nav.memoryManager') }),
                    url: `${extensionBasePath}/PlotOpt.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('nav.memoryManager') }),
                    advancedUrl: `${extensionBasePath}/PlotOpt-Advanced.md`,
                },
                "amily2_open_super_memory_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('nav.superMemory') }),
                    url: `${extensionBasePath}/SuperMemory.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('nav.superMemory') }),
                    advancedUrl: `${extensionBasePath}/SuperMemory-Advanced.md`,
                },
                "amily2_open_rule_config_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('nav.ruleConfig') }),
                    url: `${extensionBasePath}/RuleConfig.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('nav.ruleConfig') }),
                    advancedUrl: `${extensionBasePath}/RuleConfig-Advanced.md`,
                },
                "amily2_open_time_river_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('nav.timeRiver') }),
                    url: `${extensionBasePath}/TimeRiver.md`,
                },
                "amily2_open_shujuku_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('shell.tutorial.shujuku') }),
                    url: `${extensionBasePath}/TDBCompatibility.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('shell.tutorial.shujuku') }),
                    advancedUrl: `${extensionBasePath}/TDBCompatibility-Advanced.md`,
                },
                "amily2_open_shujuku_agent_tutorial": {
                    title: t('shell.tutorial.beginnerTitle', { module: t('shell.tutorial.shujuku') }),
                    url: `${extensionBasePath}/TDBCompatibility.md`,
                    advancedTitle: t('shell.tutorial.advancedTitle', { module: t('shell.tutorial.shujuku') }),
                    advancedUrl: `${extensionBasePath}/TDBCompatibility-Advanced.md`,
                }
            };
            
            const tutorial = tutorials[this.id];
            if (tutorial) {
                showContentModal(tutorial.title, tutorial.url, {
                    advancedTitle: tutorial.advancedTitle,
                    advancedUrl: tutorial.advancedUrl,
                });
            }
        });

    container
        .off("click.amily2.refresh_auth")
        .on("click.amily2.refresh_auth", "#amily2_refresh_auth", async function() {
            if (!pluginAuthStatus.authorized) return;

            const button = $(this);
            if (button.prop('disabled')) return;
            const icon = button.find('i');
            button.prop('disabled', true);
            icon.addClass('fa-spin');
            try {
                await refreshUserInfo({ interactive: true });
            } catch (error) {
                console.warn('[Amily2] 手动刷新权限信息失败:', error);
                toastr.error(t('shell.auth.refreshFailed'), t('shell.auth.refreshFailedTitle'));
            } finally {
                icon.removeClass('fa-spin');
                button.prop('disabled', false);
            }
        });

    container
        .off("click.amily2.reset_auth")
        .on("click.amily2.reset_auth", "#amily2_reset_auth", function() {
            if (!pluginAuthStatus.authorized) return;
            
            if (confirm(t('shell.auth.resetConfirm'))) {
                const resetResult = resetPluginAuthorizationState('manual-reset');
                if (!resetResult.ok) {
                    toastr.error(t('shell.auth.resetFailed'), t('shell.auth.resetFailedTitle'));
                    return;
                }

                toastr.success(t('shell.auth.resetDone'), t('app.toastTitle'));
                
                setTimeout(() => {
                    location.reload();
                }, 1500);
            }
        });

    container
        .off("click.amily2.update")
        .on("click.amily2.update", "#amily2_update_button", function() {
            $("#amily2_update_indicator").hide();
            const updateInfo = getLatestUpdateInfo();
            if (updateInfo && updateInfo.changelog) {
                const formattedChangelog = messageFormatting(updateInfo.changelog);


                const dialogHtml = `
                <dialog class="popup wide_dialogue_popup">
                  <div class="popup-body">
                    <h3 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;"><i class="fas fa-bell" style="color: #ff9800;"></i> ${escapeHTML(t('shell.news.title'))}</h3>
                    <div class="popup-content" style="height: 60vh; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px;">
                        <div class="mes_text">${formattedChangelog}</div>
                    </div>
                    <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">${escapeHTML(t('shell.read'))}</div></div>
                  </dialog>`;
                const dialogElement = $(dialogHtml).appendTo('body');
                const closeDialog = () => { dialogElement[0].close(); dialogElement.remove(); };
                dialogElement.find('.popup-button-ok').on('click', closeDialog);
                dialogElement[0].showModal();
            } else {
                toastr.info(t('shell.news.missing'), t('shell.news.statusTitle'));
            }
        });

    // 升级箭头由 amily2-updater 绑定（确认更新弹窗）；此处不再劫持为打开扩展页
    // 若 updater 未初始化，保留兜底：打开扩展管理
    container
        .off("click.amily2.update_new")
        .on("click.amily2.update_new", "#amily2_update_button_new", function(e) {
            // updater 已绑 click.amily2Upgrade 时不抢
            if ($(this).data('amily2-upgrade-bound')) return;
            e.preventDefault();
            $('span[data-i18n="Manage extensions"]').first().click();
        });

    container
        .off("click.amily2.manual_command")
        .on(
            "click.amily2.manual_command",
            "#amily2_unhide_all_button, #amily2_manual_hide_confirm, #amily2_manual_unhide_confirm",
            async function () {
                if (!pluginAuthStatus.authorized) return;

                const buttonId = this.id;
                let commandType = '';
                let params = {};

                switch (buttonId) {
                    case 'amily2_unhide_all_button':
                        commandType = 'unhide_all';
                        break;

                    case 'amily2_manual_hide_confirm':
                        commandType = 'manual_hide';
                        params = {
                            from: $('#amily2_manual_hide_from').val(),
                            to: $('#amily2_manual_hide_to').val()
                        };
                        break;

                    case 'amily2_manual_unhide_confirm':
                        commandType = 'manual_unhide';
                        params = {
                            from: $('#amily2_manual_unhide_from').val(),
                            to: $('#amily2_manual_unhide_to').val()
                        };
                        break;
                }

                if (commandType) {
                    await executeManualCommand(commandType, params);
                }
            }
        );	
		
    container
        .off("click.amily2.chamber_nav")
        .on("click.amily2.chamber_nav",
             "#amily2_open_text_optimization, #amily2_open_plot_optimization, #amily2_open_additional_features, #amily2_open_rag_palace, #amily2_open_memorisation_forms, #amily2_open_character_world_book, #amily2_open_world_editor, #amily2_open_glossary, #amily2_open_renderer, #amily2_open_super_memory, #amily2_open_progressive_memory, #amily2_open_time_river, #amily2_open_combat, #amily2_open_auto_char_card, #amily2_open_api_config, #amily2_open_security_audit, #amily2_open_rule_config, #amily2_open_sfigen, #amily2_open_preset_editor, #amily2_back_to_main_settings, #amily2_back_to_main_from_hanlinyuan, #amily2_back_to_main_from_forms, #amily2_back_to_main_from_optimization, #amily2_back_to_main_from_text_optimization, #amily2_back_to_main_from_cwb, #amily2_back_to_main_from_world_editor, #amily2_back_to_main_from_glossary, #amily2_renderer_back_button, #amily2_back_to_main_from_super_memory, #amily2_back_to_main_from_progressive_memory, #amily2_back_to_main_from_time_river, #amily2_back_to_main_from_combat, #amily2_back_to_main_from_api_config, #amily2_back_to_main_from_security_audit, #amily2_back_to_main_from_rule_config, #amily2_sfigen_back_to_main", function () {
        if (!pluginAuthStatus.authorized) return;

        const mainPanel = container.find('.plugin-features');
        const additionalPanel = container.find('#amily2_additional_features_panel');
        const hanlinyuanPanel = container.find('#amily2_hanlinyuan_panel');
        const memorisationFormsPanel = container.find('#amily2_memorisation_forms_panel');
        const plotOptimizationPanel = container.find('#amily2_plot_optimization_panel');
        const textOptimizationPanel = container.find('#amily2_text_optimization_panel');
        const characterWorldBookPanel = container.find('#amily2_character_world_book_panel');
        const worldEditorPanel = container.find('#amily2_world_editor_panel');
        const glossaryPanel = container.find('#amily2_glossary_panel');
        const rendererPanel = container.find('#amily2_renderer_panel');
        const superMemoryPanel = container.find('#amily2_super_memory_panel');
        const progressiveMemoryPanel = container.find('#amily2_progressive_memory_panel');
        const timeRiverPanel = container.find('#amily2_time_river_panel');
        const combatPanel = container.find('#amily2_combat_panel');
        const apiConfigPanel = container.find('#amily2_api_config_panel');
        const securityAuditPanel = container.find('#amily2_security_audit_panel');
        const ruleConfigPanel = container.find('#amily2_rule_config_panel');
        const sfigenPanel = container.find('#amily2_sfigen_panel');

        mainPanel.hide();
        additionalPanel.hide();
        hanlinyuanPanel.hide();
        memorisationFormsPanel.hide();
        plotOptimizationPanel.hide();
        textOptimizationPanel.hide();
        characterWorldBookPanel.hide();
        worldEditorPanel.hide();
        glossaryPanel.hide();
        rendererPanel.hide();
        superMemoryPanel.hide();
        progressiveMemoryPanel.hide();
        timeRiverPanel.hide();
        combatPanel.hide();
        apiConfigPanel.hide();
        securityAuditPanel.hide();
        ruleConfigPanel.hide();
        sfigenPanel.hide();

        switch (this.id) {
            case 'amily2_open_text_optimization':
                textOptimizationPanel.show();
                break;
            case 'amily2_open_super_memory':
                if (!hasSuperMemoryAccess()) {
                    toastr.warning(t('shell.access.superMemory'), t('shell.access.denied'));
                    mainPanel.show();
                    return;
                }
                superMemoryPanel.show();
                // 面板挂载后只渲染过一次，打开时按当前聊天的表格状态重渲染，避免显示上一个聊天的旧列表
                refreshSuperMemoryPanel();
                break;
            case 'amily2_open_progressive_memory': {
                const pmUserType = parseInt(localStorage.getItem("plugin_user_type") || "0");
                if (pmUserType < 3) {
                    toastr.info(t('shell.access.developing'), t('shell.access.developingTitle'));
                    mainPanel.show();
                    return;
                }
                progressiveMemoryPanel.show();
                refreshProgressiveMemorySourceOptions();
                break;
            }
            case 'amily2_open_time_river': {
                const hasTimeRiverAccess = getTimeRiverAccess().allowed;
                if (!hasTimeRiverAccess) {
                    toastr.info(t('shell.access.timeRiver'), t('shell.access.denied'));
                    mainPanel.show();
                    return;
                }
                timeRiverPanel.show();
                void refreshTimeRiverPanel();
                break;
            }
            case 'amily2_open_combat': {
                if (!hasCombatType3Access()) {
                    toastr.info(t('shell.access.combat'), t('shell.access.denied'));
                    mainPanel.show();
                    return;
                }
                combatPanel.show();
                refreshCombatPanel();
                break;
            }
            case 'amily2_open_auto_char_card':
                openAutoCharCardWindow();
                // 自动构建器是独立窗口，不需要隐藏主面板，或者根据需求决定
                // 这里我们保持主面板显示，因为它是全屏覆盖的
                mainPanel.show(); 
                return; 
            case 'amily2_open_renderer':
                rendererPanel.show();
                break;
            case 'amily2_open_plot_optimization':
                plotOptimizationPanel.show();
                break;
            case 'amily2_open_additional_features':
                additionalPanel.show();
                break;
            case 'amily2_open_rag_palace':
                hanlinyuanPanel.show();
                break;
            case 'amily2_open_memorisation_forms':
                memorisationFormsPanel.show();
                break;
            case 'amily2_open_character_world_book':
                showCwbWarningModal(
                    () => characterWorldBookPanel.show(),
                    () => mainPanel.show()
                );
                break;
            case 'amily2_open_world_editor':
                worldEditorPanel.show();
                break;
            case 'amily2_open_glossary':
                glossaryPanel.show();
                break;
            case 'amily2_open_api_config':
                apiConfigPanel.show();
                break;
            case 'amily2_open_security_audit':
                if (!getSecurityAuditAccess().allowed) {
                    toastr.info(t('shell.access.cardAudit'), t('shell.access.denied'));
                    mainPanel.show();
                    return;
                }
                securityAuditPanel.show();
                break;
            case 'amily2_open_rule_config':
                ruleConfigPanel.show();
                break;
            case 'amily2_open_sfigen':
                sfigenPanel.show();
                break;
            case 'amily2_open_preset_editor':
                showPresetSettings();
                mainPanel.show();
                return;
            case 'amily2_back_to_main_settings':
            case 'amily2_back_to_main_from_hanlinyuan':
            case 'amily2_back_to_main_from_forms':
            case 'amily2_back_to_main_from_optimization':
            case 'amily2_back_to_main_from_text_optimization':
            case 'amily2_back_to_main_from_cwb':
            case 'amily2_back_to_main_from_world_editor':
            case 'amily2_back_to_main_from_glossary':
            case 'amily2_renderer_back_button':
            case 'amily2_back_to_main_from_super_memory':
            case 'amily2_back_to_main_from_progressive_memory':
            case 'amily2_back_to_main_from_time_river':
            case 'amily2_back_to_main_from_combat':
            case 'amily2_back_to_main_from_api_config':
            case 'amily2_back_to_main_from_security_audit':
            case 'amily2_back_to_main_from_rule_config':
            case 'amily2_sfigen_back_to_main':
                mainPanel.show();
                break;
        }
    });

    container
        .off("change.amily2.checkbox")
        .on(
            "change.amily2.checkbox",
            'input[type="checkbox"][id^="amily2_"]:not([id^="amily2_wb_enabled"]):not(#amily2_sybd_enabled)',
            function (event) {
                if (!pluginAuthStatus.authorized) return;

                const elementId = this.id;
                const mainToggle = $(this);
                const key = snakeToCamel(elementId.replace("amily2_", ""));

                updateAndSaveSetting(key, mainToggle.prop('checked'));

                if (elementId === 'amily2_optimization_exclusion_enabled' && mainToggle.prop('checked')) {
                    const settings = extension_settings[extensionName];
                    const rules = settings.optimizationExclusionRules || [];

                    const createRuleRowHtml = (rule = { start: '', end: '' }, index) => `
                        <div class="opt-exclusion-rule-row" data-index="${index}">
                            <input type="text" class="text_pole" value="${escapeHTML(rule.start)}" placeholder="${escapeHTML(t('shell.rules.start', { marker: '<!--' }))}">
                            <span>${escapeHTML(t('shell.rules.to'))}</span>
                            <input type="text" class="text_pole" value="${escapeHTML(rule.end)}" placeholder="${escapeHTML(t('shell.rules.end', { marker: '-->' }))}">
                            <button class="delete-rule-btn menu_button danger_button" title="${escapeHTML(t('shell.rules.delete'))}">&times;</button>
                        </div>`;

                    const rulesHtml = rules.map(createRuleRowHtml).join('');
                    const modalHtml = `
                        <div id="optimization-exclusion-rules-container">
                             <p class="notes">${escapeHTML(t('shell.rules.help', { start: '<!--', end: '-->' }))}</p>
                             <div id="optimization-rules-list" style="max-height: 45vh; overflow-y: auto; padding: 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 5px; margin-bottom:10px;">${rulesHtml}</div>
                             <div style="text-align: center; margin-top: 10px;">
                                <button id="optimization-add-rule-btn" class="menu_button amily2-add-rule-btn"><i class="fas fa-plus"></i> ${escapeHTML(t('shell.rules.add'))}</button>
                             </div>
                        </div>`;

                    showHtmlModal(t('shell.rules.title'), modalHtml, {
                        okText: t('shell.confirm'),
                        cancelText: t('actions.cancel'),
                        onOk: (dialog) => {
                            const newRules = [];
                            dialog.find('.opt-exclusion-rule-row').each(function() {
                                const start = $(this).find('input').eq(0).val().trim();
                                const end = $(this).find('input').eq(1).val().trim();
                                if (start && end) newRules.push({ start, end });
                            });
                            updateAndSaveSetting('optimizationExclusionRules', newRules);
                            toastr.success(t('shell.rules.saved'), t('app.toastTitle'));
                        },
                        onCancel: () => {
                        }
                    });
                    
                    const modalContent = $('#optimization-exclusion-rules-container');
                    const rulesList = modalContent.find('#optimization-rules-list');

                    modalContent.find('#optimization-add-rule-btn').on('click', () => {
                        const newIndex = rulesList.children().length;
                        rulesList.append(createRuleRowHtml(undefined, newIndex));
                    });

                    rulesList.on('click', '.delete-rule-btn', function() {
                        $(this).closest('.opt-exclusion-rule-row').remove();
                    });
                }
            },
        );

    container
        .off("change.amily2.radio")
        .on(
            "change.amily2.radio",
            'input[type="radio"][name^="amily2_"]:not([name="amily2_icon_location"]):not([name="amily2_wb_source"])', 
            function () {
                if (!pluginAuthStatus.authorized) return;
                const key = snakeToCamel(this.name.replace("amily2_", ""));
                const value = $(`input[name="${this.name}"]:checked`).val();
                updateAndSaveSetting(key, value);
            },
        );

    container
        .off("change.amily2.api_provider")
        .on("change.amily2.api_provider", "#amily2_api_provider", function () {
            if (!pluginAuthStatus.authorized) return;
            
            const provider = $(this).val();
            console.log(`[Amily2号-UI] API提供商切换为: ${provider}`);

            updateAndSaveSetting('apiProvider', provider);

            const $urlWrapper = $('#amily2_api_url_wrapper');
            const $keyWrapper = $('#amily2_api_key_wrapper');
            const $presetWrapper = $('#amily2_preset_wrapper');

            $urlWrapper.hide();
            $keyWrapper.hide();
            $presetWrapper.hide();

            const $modelWrapper = $('#amily2_model_selector');
            
            switch(provider) {
                case 'openai':
                case 'openai_test':
                    $urlWrapper.show();
                    $keyWrapper.show();
                    $modelWrapper.show();
                    $('#amily2_api_url').attr('placeholder', 'https://api.openai.com/v1').attr('type', 'text');
                    $('#amily2_api_key').attr('placeholder', 'sk-...');
                    break;
                    
                case 'google':

                    $urlWrapper.hide();
                    $keyWrapper.show();
                    $modelWrapper.show();
                    $('#amily2_api_key').attr('placeholder', 'Google API Key');
                    break;
                    
                case 'sillytavern_backend':
                    $urlWrapper.show();
                    $modelWrapper.show();
                    $('#amily2_api_url').attr('placeholder', 'http://localhost:5000/v1').attr('type', 'text');
                    break;
                    
                case 'sillytavern_preset':
                    $presetWrapper.show();
                    $modelWrapper.hide();
                    loadSillyTavernPresets();
                    break;
            }

            $('#amily2_model').empty().append($('<option>', { value: '', text: t('shell.model.refresh') }));
        });

    container
        .off("input.amily2.text change.amily2.text")
        .on("input.amily2.text change.amily2.text", "#amily2_api_url, #amily2_api_key, #amily2_optimization_target_tag", function () {
            if (!pluginAuthStatus.authorized) return;
            const key = snakeToCamel(this.id.replace("amily2_", ""));
            // apiKey 是敏感字段，必须经 configManager 写入 localStorage
            if (key === 'apiKey') {
                configManager.set(key, this.value);
            } else {
                updateAndSaveSetting(key, this.value);
            }
            toastr.success(t('shell.config.saved', { key }), t('app.toastTitle'));
        });
    container
        .off('blur.amily2.api_key')
        .on('blur.amily2.api_key', '#amily2_api_key', function () {
            markSecretInputStored(this, configManager.has('apiKey'));
        });

    container
        .off("change.amily2.select")
        .on("change.amily2.select", "select#amily2_model, select#amily2_preset_selector", function () {
            if (!pluginAuthStatus.authorized) return;
            const key = snakeToCamel(this.id.replace("amily2_", ""));
            let valueToSave = this.value;

            if (this.id === 'amily2_preset_selector') {
                updateAndSaveSetting('tavernProfile', valueToSave);
            } else {
                updateAndSaveSetting(key, valueToSave);
            }

            if (this.id === 'amily2_model') {
                populateModelDropdown();
            }
        });

    container
        .off("input.amily2.range")
        .on(
            "input.amily2.range",
            'input[type="range"][id^="amily2_"]',
            function () {
                if (!pluginAuthStatus.authorized) return;
                const key = snakeToCamel(this.id.replace("amily2_", ""));
                const value = this.id.includes("temperature")
                    ? parseFloat(this.value)
                    : parseInt(this.value, 10);
                $(`#${this.id}_value`).text(value);
                updateAndSaveSetting(key, value);
            },
        );

    container
        .off("input.amily2.number change.amily2.number")
        .on(
            "input.amily2.number change.amily2.number",
            "#amily2_max_tokens, #amily2_temperature, #amily2_context_messages",
            function () {
                if (!pluginAuthStatus.authorized) return;
                const key = snakeToCamel(this.id.replace("amily2_", ""));
                const value = this.id.includes("temperature")
                    ? parseFloat(this.value)
                    : parseInt(this.value, 10);

                if (Number.isNaN(value)) return;

                $(`#${this.id}_value`).text(value);
                updateAndSaveSetting(key, value);
            },
        );

    // main 槽分配 profile 后，这两个参数由 profile 权威控制（T-006 informational 化）
    watchProfileSliderGuard('main', ['#amily2_max_tokens', '#amily2_temperature']);

    const promptMap = {
        mainPrompt: "#amily2_main_prompt",
        systemPrompt: "#amily2_system_prompt",
        outputFormatPrompt: "#amily2_output_format_prompt",
    };
    const selector = "#amily2_prompt_selector";
    const editor = "#amily2_unified_editor";
    const unifiedSaveButton = "#amily2_unified_save_button";

    function updateEditorView() {
        if (!$(selector).length) return;
        const selectedKey = $(selector).val();
        if (!selectedKey) return;
        const content = extension_settings[extensionName][selectedKey] || "";
        $(editor).val(content);
    }

    container
        .off("change.amily2.prompt_selector")
        .on("change.amily2.prompt_selector", selector, updateEditorView);

    container
        .off("input.amily2.unified_editor change.amily2.unified_editor")
        .on("input.amily2.unified_editor change.amily2.unified_editor", editor, function () {
            const selectedKey = $(selector).val();
            if (!selectedKey) return;
            updateAndSaveSetting(selectedKey, $(this).val());
        });

    container
        .off("click.amily2.unified_save")
        .on("click.amily2.unified_save", unifiedSaveButton, function () {
            const selectedKey = $(selector).val();
            if (!selectedKey) return;
            const newContent = $(editor).val();
            updateAndSaveSetting(selectedKey, newContent);
            toastr.success(t('shell.prompt.saved', { key: selectedKey }), t('app.toastTitle'));
        });

    container
        .off("click.amily2.unified_restore")
        .on("click.amily2.unified_restore", "#amily2_unified_restore_button", function () {
            const selectedKey = $(selector).val();
            if (!selectedKey) return;
            const defaultValue = defaultSettings[selectedKey];
            $(editor).val(defaultValue);
            updateAndSaveSetting(selectedKey, defaultValue);
            toastr.success(t('shell.prompt.restored', { key: selectedKey }), t('app.toastTitle'));
        });

    container
        .off("input.amily2.lore_settings change.amily2.lore_settings")
        .on("input.amily2.lore_settings change.amily2.lore_settings",
            'select[id^="amily2_lore_"], input#amily2_lore_depth_input',
            function () {
                if (!pluginAuthStatus.authorized) return;
				


                let key = snakeToCamel(this.id.replace("amily2_", ""));
                if (key === 'loreDepthInput') {
                    key = 'loreDepth';
                }

                const value = (this.type === 'number') ? parseInt(this.value, 10) : this.value;
                updateAndSaveSetting(key, value);


                if (this.id === 'amily2_lore_insertion_position') {
                    const depthContainer = $('#amily2_lore_depth_container');

                    if (this.value === 'at_depth') {
                        depthContainer.slideDown(200);
                    } else {
                        depthContainer.slideUp(200);
                    }
                }
            }
        );

    container
        .off("click.amily2.lore_save")
        .on("click.amily2.lore_save", '#amily2_save_lore_settings', function () {
            if (!pluginAuthStatus.authorized) return;

            const button = $(this);
            const statusElement = $('#amily2_lore_save_status');

            button.prop('disabled', true).html(`<i class="fas fa-check"></i> ${escapeHTML(t('shell.config.confirmed'))}`);
            statusElement.text(t('shell.config.autoSaved')).stop().fadeIn();

            setTimeout(() => {
                button.prop('disabled', false).html(`<i class="fas fa-save"></i> ${escapeHTML(t('shell.config.confirm'))}`);
                statusElement.fadeOut();
            }, 2500);
        });

    setTimeout(updateEditorView, 100);
	    updateModelInputView();

    container.data("events-bound", true);

    // 【V60.0】新增：颜色定制UI事件绑定
    const colorContainer = $("#amily2_drawer_content").length ? $("#amily2_drawer_content") : $("#amily2_chat_optimiser");
    if (colorContainer.length && !colorContainer.data("color-events-bound")) {
        loadAndApplyCustomColors(colorContainer);

        colorContainer.on('input', '#amily2_bg_color, #amily2_button_color, #amily2_text_color', function() {
            applyAndSaveColors(colorContainer);
        });

        // 新增：背景透明度滑块事件
        colorContainer.on('input', '#amily2_bg_opacity', function() {
            const opacityValue = $(this).val();
            $('#amily2_bg_opacity_value').text(opacityValue);
            document.documentElement.style.setProperty('--amily2-bg-opacity', opacityValue);
            
            if (!extension_settings[extensionName]) {
                extension_settings[extensionName] = {};
            }
            extension_settings[extensionName]['bgOpacity'] = opacityValue;
            saveSettingsDebounced();
        });

        colorContainer.on('click', '#amily2_restore_colors', function() {
            const defaultColors = {
                '--amily2-bg-color': '#1e1e1e',
                '--amily2-button-color': '#4a4a4a',
                '--amily2-text-color': '#ffffff'
            };
            
            colorContainer.find('#amily2_bg_color').val(defaultColors['--amily2-bg-color']);
            colorContainer.find('#amily2_button_color').val(defaultColors['--amily2-button-color']);
            colorContainer.find('#amily2_text_color').val(defaultColors['--amily2-text-color']);
            
            applyAndSaveColors(colorContainer);

            // 恢复默认透明度
            const defaultOpacity = 0.85;
            $('#amily2_bg_opacity').val(defaultOpacity);
            $('#amily2_bg_opacity_value').text(defaultOpacity);
            document.documentElement.style.setProperty('--amily2-bg-opacity', defaultOpacity);
            if (extension_settings[extensionName]) {
                extension_settings[extensionName]['bgOpacity'] = defaultOpacity;
                saveSettingsDebounced();
            }

            toastr.success(t('settings.colorsRestored'));
        });

        // 新增：自定义背景图事件绑定
        colorContainer.on('change', '#amily2_custom_bg_image', function(event) {
            const file = event.target.files[0];
            if (file && file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const imageDataUrl = e.target.result;
                    // 检查大小
                    if (imageDataUrl.length > 5 * 1024 * 1024) { // 5MB 限制
                        toastr.error(t('settings.imageTooLarge'));
                        return;
                    }
                    document.documentElement.style.setProperty('--amily2-bg-image', `url("${imageDataUrl}")`);
                    
                    if (!extension_settings[extensionName]) {
                        extension_settings[extensionName] = {};
                    }
                    extension_settings[extensionName]['customBgImage'] = imageDataUrl;
                    saveSettingsDebounced();
                    toastr.success(t('settings.imageApplied'));
                };
                reader.readAsDataURL(file);
            }
        });

        colorContainer.on('click', '#amily2_restore_bg_image', function() {
            document.documentElement.style.setProperty('--amily2-bg-image', `url("${DEFAULT_BG_IMAGE_URL}")`);
            if (extension_settings[extensionName]) {
                delete extension_settings[extensionName]['customBgImage'];
                saveSettingsDebounced();
            }
            $('#amily2_custom_bg_image').val(''); // 清空文件选择框
            toastr.success(t('settings.imageRestored'));
        });

        colorContainer.data("color-events-bound", true);
    }
}



const DEFAULT_BG_IMAGE_URL = "https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/img/Amily-2.png";

function applyAndSaveColors(container) {
    const bgColor = container.find('#amily2_bg_color').val();
    const btnColor = container.find('#amily2_button_color').val();
    const textColor = container.find('#amily2_text_color').val();

    const colors = {
        '--amily2-bg-color': bgColor,
        '--amily2-button-color': btnColor,
        '--amily2-text-color': textColor
    };

    Object.entries(colors).forEach(([key, value]) => {
        document.documentElement.style.setProperty(key, value, 'important');
    });

    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName]['customColors'] = colors;
    saveSettingsDebounced();
}

function loadAndApplyCustomColors(container) {
    const savedColors = extension_settings[extensionName]?.customColors;
    if (savedColors) {
        container.find('#amily2_bg_color').val(savedColors['--amily2-bg-color']);
        container.find('#amily2_button_color').val(savedColors['--amily2-button-color']);
        container.find('#amily2_text_color').val(savedColors['--amily2-text-color']);
        applyAndSaveColors(container);
    }

    const savedOpacity = extension_settings[extensionName]?.bgOpacity;
    if (savedOpacity !== undefined) {
        $('#amily2_bg_opacity').val(savedOpacity);
        $('#amily2_bg_opacity_value').text(savedOpacity);
        document.documentElement.style.setProperty('--amily2-bg-opacity', savedOpacity);
    }

    const savedBgImage = extension_settings[extensionName]?.customBgImage;
    const imageUrl = savedBgImage ? `url("${savedBgImage}")` : `url("${DEFAULT_BG_IMAGE_URL}")`;
    document.documentElement.style.setProperty('--amily2-bg-image', imageUrl);
}
