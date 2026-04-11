import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, this_chid, saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { defaultSettings, extensionName, saveSettings, extensionBasePath } from "../utils/settings.js";
import { pluginAuthStatus, activatePluginAuthorization, getPasswordForDate } from "../utils/auth.js";
import { fetchModels, testApiConnection } from "../core/api.js";
import { safeLorebooks, safeCharLorebooks, safeLorebookEntries } from "../core/tavernhelper-compatibility.js";
import { configManager } from '../utils/config/ConfigManager.js';

import { setAvailableModels, populateModelDropdown, getLatestUpdateInfo } from "./state.js";
import { fixCommand, testReplyChecker } from "../core/commands.js";
import { messageFormatting } from '/script.js';
import { executeManualCommand } from '../core/autoHideManager.js';
import { showContentModal, showHtmlModal } from './page-window.js';
import { openAutoCharCardWindow } from '../core/auto-char-card/ui-bindings.js';

function displayDailyAuthCode() {
    const displayEl = document.getElementById('amily2_daily_code_display');
    const copyBtn = document.getElementById('amily2_copy_daily_code');

    if (displayEl && copyBtn) {
        const todayCode = getPasswordForDate(new Date());
        displayEl.textContent = todayCode;

        if(copyBtn) copyBtn.style.display = 'inline-block';

        copyBtn.onclick = () => {
            navigator.clipboard.writeText(todayCode).then(() => {
                toastr.success('授权码已复制到剪贴板！');
            }, () => {
                toastr.error('复制失败，请手动复制。');
            });
        };
    }
}


async function loadSillyTavernPresets() {
    console.log('[Amily2号-UI] 正在加载SillyTavern预设列表');
    
    const select = $('#amily2_preset_selector');
    const settings = extension_settings[extensionName] || {};
    const currentProfileId = settings.tavernProfile || settings.selectedPreset;

    select.empty().append(new Option('-- 请选择一个酒馆预设 --', ''));

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];
        
        if (!tavernProfiles || tavernProfiles.length === 0) {
            select.append($('<option>', { value: '', text: '未找到酒馆预设', disabled: true }));
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
            toastr.warning(`之前选择的酒馆预设 "${currentProfileId}" 已不存在，请重新选择。`, "Amily2号");
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
        select.append($('<option>', { value: '', text: '加载预设失败', disabled: true }));
        toastr.error('无法加载酒馆API预设列表，请查看控制台。', 'Amily2号');
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

        entryListContainer.innerHTML = '<p class="notes">Loading entries...</p>';
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
                    entryListContainer.innerHTML = '<p class="notes" style="color:red;">Failed to get character world books.</p>';
                    return;
                }
            } else {
                entryListContainer.innerHTML = '<p class="notes">Please load a character first.</p>';
                return;
            }
        }

        if (bookNames.length === 0) {
            entryListContainer.innerHTML = '<p class="notes">No world book selected or linked.</p>';
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
                entryListContainer.innerHTML = '<p class="notes">No entries in the selected world book(s).</p>';
                return;
            }

            allEntries.forEach(entry => {
                const div = document.createElement('div');
                div.className = 'checkbox-item';
                div.title = `World Book: ${entry.bookName}\nUID: ${entry.uid}`;
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
                label.textContent = entry.comment || 'Untitled Entry';

                div.appendChild(checkbox);
                div.appendChild(label);
                entryListContainer.appendChild(div);
            });
        } catch (error) {
            console.error(`[Amily2 Modal] Failed to load world book entries:`, error);
            entryListContainer.innerHTML = '<p class="notes" style="color:red;">Failed to load entries.</p>';
        }
    };

    const renderWorldBookList = async () => {
        bookListContainer.innerHTML = '<p class="notes">Loading world books...</p>';
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
                bookListContainer.innerHTML = '<p class="notes">No world books found.</p>';
            }
        } catch (error) {
            console.error(`[Amily2 Modal] Failed to load world book list:`, error);
            bookListContainer.innerHTML = '<p class="notes" style="color:red;">Failed to load world book list.</p>';
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
        testButton.innerHTML = '<i class="fas fa-plug"></i> 测试连接';
        refreshButton.insertAdjacentElement('afterend', testButton);
    }

    bindAmily2ModalWorldBookSettings();

    const container = $("#amily2_drawer_content").length ? $("#amily2_drawer_content") : $("#amily2_chat_optimiser");

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
            
            const sectionId = legend.text().trim();
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
            toastr.success(`模型ID [${this.value}] 已自动保存!`, "Amily2号");
        });


    container
        .off("click.amily2.auth")
        .on("click.amily2.auth", "#auth_submit", async function () {
            const authCode = $("#amily2_auth_code").val().trim();
            if (authCode) {
                await activatePluginAuthorization(authCode);
            } else {
                toastr.warning("请输入授权码", "Amily2号");
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
                    .html('<i class="fas fa-spinner fa-spin"></i> 处理中');
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
                    toastr.error(`操作失败: ${error.message}`, "Amily2号");
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
                toastr.warning("请输入有效的楼层号");
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
                        toastr.info(`已临时展开 ${unhiddenCount} 条被隐藏的消息以显示上下文。`);
                    }
                }

                targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
                targetElement.classList.add('highlight_message'); 
                setTimeout(() => targetElement.classList.remove('highlight_message'), 2000);
                toastr.success(`已跳转到楼层 ${targetId}`);
            } else {
                // 2. DOM 中未找到，尝试从内存中获取并弹窗显示
                const context = getContext();
                if (context && context.chat && context.chat[targetId]) {
                    const msg = context.chat[targetId];
                    const sender = msg.name;
                    let formattedContent = msg.mes;
                    
                    // 尝试使用 SillyTavern 的格式化函数
                    if (typeof messageFormatting === 'function') {
                        formattedContent = messageFormatting(msg.mes, sender, false, false);
                    } else {
                        formattedContent = msg.mes.replace(/\n/g, '<br>');
                    }
                    
                    const html = `
                        <div style="padding: 10px;">
                            <div style="margin-bottom: 10px; font-size: 1.1em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                                <strong style="color: var(--smart-theme-color, #ffcc00);">${sender}</strong> 
                                <span style="opacity: 0.6; font-size: 0.8em;">(楼层 #${targetId})</span>
                            </div>
                            <div class="mes_text" style="max-height: 60vh; overflow-y: auto;">
                                ${formattedContent}
                            </div>
                            <div style="margin-top: 15px; font-size: 0.9em; opacity: 0.7; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 5px;">
                                <i class="fas fa-info-circle"></i> 该楼层未在当前页面渲染（可能已被清理以节省内存），无法直接跳转，已为您在弹窗中显示。
                            </div>
                        </div>
                    `;
                    
                    showHtmlModal(`查看历史记录`, html);
                    toastr.info(`楼层 ${targetId} 未渲染，已在弹窗中显示内容。`);
                } else {
                    toastr.error(`未找到楼层 ${targetId}，聊天记录中不存在该索引。`);
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
                    <h4 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">正在编辑: ${selectedKey}</h4>
                    <div class="popup-content" style="height: 70vh;"><div class="height100p wide100p flex-container"><textarea id="amily2_dialog_editor" class="height100p wide100p maximized_textarea text_pole"></textarea></div></div>
                    <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">保存并关闭</div><div class="popup-button-cancel menu_button interactable" style="margin-left: 10px;">取消</div></div>
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
                toastr.success(`谕令 [${selectedKey}] 已镌刻！`, "Amily2号");
                closeDialog();
            });
            dialogElement.find('.popup-button-cancel').on('click', closeDialog);
            dialogElement[0].showModal();
        });

    container
        .off("click.amily2.tutorial")
        .on("click.amily2.tutorial", "#amily2_open_tutorial, #amily2_open_neige_tutorial", function() {
            if (!pluginAuthStatus.authorized) return;

            const tutorials = {
                "amily2_open_tutorial": {
                    title: "主殿使用教程",
                    url: `${extensionBasePath}/ZhuDian.md`
                },
                "amily2_open_neige_tutorial": {
                    title: "内阁使用教程",
                    url: `${extensionBasePath}/NeiGe.md`
                }
            };
            
            const tutorial = tutorials[this.id];
            if (tutorial) {
                showContentModal(tutorial.title, tutorial.url);
            }
        });

    container
        .off("click.amily2.reset_auth")
        .on("click.amily2.reset_auth", "#amily2_reset_auth", function() {
            if (!pluginAuthStatus.authorized) return;
            
            if (confirm("确定要清除本地授权码吗？\n这将使您的授权失效，需要重新验证。\n\n这通常用于：\n1. 升级为高级用户\n2. 解决授权异常问题")) {
                localStorage.removeItem("plugin_auth_code");
                localStorage.removeItem("plugin_activated");
                localStorage.removeItem("plugin_auto_login");
                localStorage.removeItem("plugin_user_type");
                localStorage.removeItem("plugin_valid_until");
                
                toastr.success("授权已清除，即将重新加载以生效...", "Amily2号");
                
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
                    <h3 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;"><i class="fas fa-bell" style="color: #ff9800;"></i> 帝国最新情报</h3>
                    <div class="popup-content" style="height: 60vh; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px;">
                        <div class="mes_text">${formattedChangelog}</div>
                    </div>
                    <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">朕已阅</div></div>
                  </dialog>`;
                const dialogElement = $(dialogHtml).appendTo('body');
                const closeDialog = () => { dialogElement[0].close(); dialogElement.remove(); };
                dialogElement.find('.popup-button-ok').on('click', closeDialog);
                dialogElement[0].showModal();
            } else {
                toastr.info("未能获取到云端情报，请稍后再试。", "情报部回报");
            }
        });

    container
        .off("click.amily2.update_new")
        .on("click.amily2.update_new", "#amily2_update_button_new", function() {
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
             "#amily2_open_text_optimization, #amily2_open_plot_optimization, #amily2_open_additional_features, #amily2_open_rag_palace, #amily2_open_memorisation_forms, #amily2_open_character_world_book, #amily2_open_world_editor, #amily2_open_glossary, #amily2_open_renderer, #amily2_open_super_memory, #amily2_open_auto_char_card, #amily2_open_api_config, #amily2_open_sfigen, #amily2_back_to_main_settings, #amily2_back_to_main_from_hanlinyuan, #amily2_back_to_main_from_forms, #amily2_back_to_main_from_optimization, #amily2_back_to_main_from_text_optimization, #amily2_back_to_main_from_cwb, #amily2_back_to_main_from_world_editor, #amily2_back_to_main_from_glossary, #amily2_renderer_back_button, #amily2_back_to_main_from_super_memory, #amily2_back_to_main_from_api_config, #amily2_sfigen_back_to_main", function () {
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
        const apiConfigPanel = container.find('#amily2_api_config_panel');
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
        apiConfigPanel.hide();
        sfigenPanel.hide();

        switch (this.id) {
            case 'amily2_open_text_optimization':
                textOptimizationPanel.show();
                break;
            case 'amily2_open_super_memory':
                const userType = parseInt(localStorage.getItem("plugin_user_type") || "0");
                if (userType < 2) {
                    toastr.warning("此功能为内测功能，仅限我看顺眼的用户使用。", "权限不足");
                    mainPanel.show();
                    return;
                }
                superMemoryPanel.show();
                break;
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
                characterWorldBookPanel.show();
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
            case 'amily2_open_sfigen':
                sfigenPanel.show();
                break;
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
            case 'amily2_back_to_main_from_api_config':
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
                            <input type="text" class="text_pole" value="${rule.start}" placeholder="开始字符, 如 <!--">
                            <span>到</span>
                            <input type="text" class="text_pole" value="${rule.end}" placeholder="结束字符, 如 -->">
                            <button class="delete-rule-btn menu_button danger_button" title="删除此规则">&times;</button>
                        </div>`;

                    const rulesHtml = rules.map(createRuleRowHtml).join('');
                    const modalHtml = `
                        <div id="optimization-exclusion-rules-container">
                             <p class="notes">在这里定义需要从优化内容中排除的文本片段。例如，排除HTML注释，可以设置开始字符为 \`<!--\`，结束字符为 \`-->\`。</p>
                             <div id="optimization-rules-list" style="max-height: 45vh; overflow-y: auto; padding: 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 5px; margin-bottom:10px;">${rulesHtml}</div>
                             <div style="text-align: center; margin-top: 10px;">
                                <button id="optimization-add-rule-btn" class="menu_button amily2-add-rule-btn"><i class="fas fa-plus"></i> 添加新规则</button>
                             </div>
                        </div>`;

                    showHtmlModal('编辑内容排除规则', modalHtml, {
                        okText: '确认',
                        cancelText: '取消',
                        onOk: (dialog) => {
                            const newRules = [];
                            dialog.find('.opt-exclusion-rule-row').each(function() {
                                const start = $(this).find('input').eq(0).val().trim();
                                const end = $(this).find('input').eq(1).val().trim();
                                if (start && end) newRules.push({ start, end });
                            });
                            updateAndSaveSetting('optimizationExclusionRules', newRules);
                            toastr.success('排除规则已更新。', 'Amily2号');
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

            $('#amily2_model').empty().append('<option value="">请刷新模型列表</option>');
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
            toastr.success(`配置 [${key}] 已自动保存!`, "Amily2号");
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
            toastr.success(`谕令 [${selectedKey}] 已镌刻!`, "Amily2号");
        });

    container
        .off("click.amily2.unified_restore")
        .on("click.amily2.unified_restore", "#amily2_unified_restore_button", function () {
            const selectedKey = $(selector).val();
            if (!selectedKey) return;
            const defaultValue = defaultSettings[selectedKey];
            $(editor).val(defaultValue);
            updateAndSaveSetting(selectedKey, defaultValue);
            toastr.success(`谕令 [${selectedKey}] 已成功恢复为帝国初始蓝图。`, "Amily2号");
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

            button.prop('disabled', true).html('<i class="fas fa-check"></i> 已确认');
            statusElement.text('圣意已在您每次更改时自动镌刻。').stop().fadeIn();

            setTimeout(() => {
                button.prop('disabled', false).html('<i class="fas fa-save"></i> 确认敕令');
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

            toastr.success('界面颜色与透明度已恢复为默认设置。');
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
                        toastr.error('图片文件过大，请选择小于5MB的图片。');
                        return;
                    }
                    document.documentElement.style.setProperty('--amily2-bg-image', `url("${imageDataUrl}")`);
                    
                    if (!extension_settings[extensionName]) {
                        extension_settings[extensionName] = {};
                    }
                    extension_settings[extensionName]['customBgImage'] = imageDataUrl;
                    saveSettingsDebounced();
                    toastr.success('自定义背景图已应用。');
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
            toastr.success('背景图已恢复为默认。');
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
