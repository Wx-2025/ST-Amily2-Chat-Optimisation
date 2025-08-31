import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { defaultSettings, extensionName } from "../utils/settings.js";
import { pluginAuthStatus, activatePluginAuthorization, getPasswordForDate } from "../utils/auth.js";
import { fetchModels } from "../core/api.js";
import { safeLorebooks, safeCharLorebooks, safeLorebookEntries, isTavernHelperAvailable } from "../core/tavernhelper-compatibility.js";

import { setAvailableModels, populateModelDropdown, getLatestUpdateInfo } from "./state.js";
import { fixCommand, testReplyChecker } from "../core/commands.js";
import { createDrawer } from '../ui/drawer.js';
import { messageFormatting } from '/script.js';
import { executeManualCommand } from '../core/autoHideManager.js';
import { showContentModal, showHtmlModal } from './page-window.js';

function displayDailyAuthCode() {
    const displayEl = document.getElementById('amily2_daily_code_display');
    const copyBtn = document.getElementById('amily2_copy_daily_code');

    if (displayEl && copyBtn) {
        const todayCode = getPasswordForDate(new Date());
        displayEl.textContent = todayCode;

        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(todayCode).then(() => {
                toastr.success('授权码已复制到剪贴板！');
            }, () => {
                toastr.error('复制失败，请手动复制。');
            });
        });
    }
}


async function loadSillyTavernPresets() {
    console.log('[Amily2号-UI] 正在加载SillyTavern预设列表');
    
    const select = $('#amily2_preset_selector');
    const settings = extension_settings[extensionName] || {};
    const currentProfileId = settings.selectedPreset;

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
                const option = $('<option>', {
                    value: profile.id,
                    text: profile.name || profile.id,
                    selected: profile.id === currentProfileId
                });
                select.append(option);
                if (profile.id === currentProfileId) {
                    foundCurrentProfile = true;
                }
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
        } else if (foundCurrentProfile) {
            select.val(currentProfileId);
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

export function bindModalEvents() {

    initializePlotOptimizationBindings();

    const container = $("#amily2_drawer_content").length ? $("#amily2_drawer_content") : $("#amily2_chat_optimiser");
    
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
        extension_settings[extensionName] = { ...extension_settings[extensionName], [key]: value };
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
            "#amily2_refresh_models, #amily2_test, #amily2_fix_now",
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
                    url: "scripts/extensions/third-party/ST-Amily2-Chat-Optimisation/ZhuDian.md"
                },
                "amily2_open_neige_tutorial": {
                    title: "内阁使用教程",
                    url: "scripts/extensions/third-party/ST-Amily2-Chat-Optimisation/NeiGe.md"
                }
            };
            
            const tutorial = tutorials[this.id];
            if (tutorial) {
                showContentModal(tutorial.title, tutorial.url);
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
         "#amily2_open_plot_optimization, #amily2_open_additional_features, #amily2_open_rag_palace, #amily2_open_memorisation_forms, #amily2_back_to_main_settings, #amily2_back_to_main_from_hanlinyuan, #amily2_back_to_main_from_forms, #amily2_back_to_main_from_optimization", function () {
        if (!pluginAuthStatus.authorized) return;

        const mainPanel = container.find('.plugin-features');
        const additionalPanel = container.find('#amily2_additional_features_panel');
        const hanlinyuanPanel = container.find('#amily2_hanlinyuan_panel');
        const memorisationFormsPanel = container.find('#amily2_memorisation_forms_panel');
        const plotOptimizationPanel = container.find('#amily2_plot_optimization_panel');

        mainPanel.hide();
        additionalPanel.hide();
        hanlinyuanPanel.hide();
        memorisationFormsPanel.hide();
        plotOptimizationPanel.hide();

        switch (this.id) {
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
            case 'amily2_back_to_main_settings':
            case 'amily2_back_to_main_from_hanlinyuan':
            case 'amily2_back_to_main_from_forms':
            case 'amily2_back_to_main_from_optimization':
                mainPanel.show();
                break;
        }
    });

    container
        .off("change.amily2.checkbox")
        .on(
            "change.amily2.checkbox",
            'input[type="checkbox"][id^="amily2_"]',
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
            'input[type="radio"][name^="amily2_"]:not([name="amily2_icon_location"])', 
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
        .off("change.amily2.text")
        .on("change.amily2.text", "#amily2_api_url, #amily2_api_key, #amily2_optimization_target_tag", function () {
            if (!pluginAuthStatus.authorized) return;
            const key = snakeToCamel(this.id.replace("amily2_", ""));
            updateAndSaveSetting(key, this.value);
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
        .off("change.amily2.lore_settings")
        .on("change.amily2.lore_settings",
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


}

export function opt_saveAllSettings() {
    const panel = $('#amily2_plot_optimization_panel');
    if (panel.length === 0) return;

    console.log(`[${extensionName}] 手动触发所有剧情优化设置的保存...`);
    panel.find('input[type="checkbox"], input[type="radio"], input[type="text"], input[type="password"], textarea, select').trigger('change.amily2_opt');

    panel.find('input[type="range"]').trigger('change.amily2_opt');

    opt_saveEnabledEntries();
    
    toastr.info('剧情优化设置已自动保存。');
}


function opt_toCamelCase(str) {
    return str.replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
}

function opt_updateApiUrlVisibility(panel, apiMode) {
    const customApiSettings = panel.find('#amily2_opt_custom_api_settings_block');
    const tavernProfileSettings = panel.find('#amily2_opt_tavern_api_profile_block');
    const apiUrlInput = panel.find('#amily2_opt_api_url');

    customApiSettings.hide();
    tavernProfileSettings.hide();

    if (apiMode === 'tavern') {
        tavernProfileSettings.show();
    } else {
        customApiSettings.show();
        if (apiMode === 'google') {
            panel.find('#amily2_opt_api_url_block').hide();
            const googleUrl = 'https://generativelanguage.googleapis.com';
            if (apiUrlInput.val() !== googleUrl) {
                apiUrlInput.val(googleUrl).attr('type', 'text').trigger('change');
            }
        } else {
            panel.find('#amily2_opt_api_url_block').show();
        }
    }
}

function opt_updateWorldbookSourceVisibility(panel, source) {
    const manualSelectionWrapper = panel.find('#amily2_opt_worldbook_select_wrapper');
    if (source === 'manual') {
        manualSelectionWrapper.show();
        const selectBox = manualSelectionWrapper.find('#amily2_opt_selected_worldbooks');
        selectBox.css({
            'height': 'auto',
            'background-color': 'var(--bg1)',
            'appearance': 'none',
            '-webkit-appearance': 'none'
        });
    } else {
        manualSelectionWrapper.hide();
    }
}

async function opt_loadTavernApiProfiles(panel) {
    const select = panel.find('#amily2_opt_tavern_api_profile_select');
    const apiSettings = opt_getMergedSettings();
    const currentProfileId = apiSettings.plotOpt_tavernProfile;

    const currentValue = select.val();
    select.empty().append(new Option('-- 请选择一个酒馆预设 --', ''));

    try {
        const tavernProfiles = getContext().extensionSettings?.connectionManager?.profiles || [];
        if (!tavernProfiles || tavernProfiles.length === 0) {
            select.append($('<option>', { value: '', text: '未找到酒馆预设', disabled: true }));
            return;
        }

        let foundCurrentProfile = false;
        tavernProfiles.forEach(profile => {
            if (profile.api && profile.preset) {
                const option = $('<option>', {
                    value: profile.id,
                    text: profile.name || profile.id,
                    selected: profile.id === currentProfileId
                });
                select.append(option);
                if (profile.id === currentProfileId) {
                    foundCurrentProfile = true;
                }
            }
        });

        if (currentProfileId && !foundCurrentProfile) {
            toastr.warning(`之前选择的酒馆预设 "${currentProfileId}" 已不存在，请重新选择。`);
            opt_saveSetting('tavernProfile', '');
        } else if (foundCurrentProfile) {
             select.val(currentProfileId);
        }

    } catch (error) {
        console.error(`[${extensionName}] 加载酒馆API预设失败:`, error);
        toastr.error('无法加载酒馆API预设列表，请查看控制台。');
    }
}


const opt_characterSpecificSettings = [
    'plotOpt_worldbookSource',
    'plotOpt_selectedWorldbooks',
    'plotOpt_enabledWorldbookEntries'
];


async function opt_saveSetting(key, value) {
    if (opt_characterSpecificSettings.includes(key)) {
        const character = characters[this_chid];
        if (!character) return;

        if (!character.data.extensions) character.data.extensions = {};
        if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};
        
        character.data.extensions[extensionName][key] = value;
        
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: character.data.extensions[extensionName] } }
                })
            });

            if (!response.ok) throw new Error(`API call failed with status: ${response.status}`);
            console.log(`[${extensionName}] 角色卡设置已更新: ${key} ->`, value);
        } catch (error) {
            console.error(`[${extensionName}] 保存角色数据失败:`, error);
            toastr.error('无法保存角色卡设置，请检查控制台。');
        }
    } else {
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName][key] = value;
        saveSettingsDebounced();
    }
}


function opt_getMergedSettings() {
    const character = characters[this_chid];
    const globalSettings = extension_settings[extensionName] || defaultSettings;
    const characterSettings = character?.data?.extensions?.[extensionName] || {};
    
    return { ...globalSettings, ...characterSettings };
}



function opt_bindSlider(panel, sliderId, displayId) {
    const slider = panel.find(sliderId);
    const display = panel.find(displayId);

    display.text(slider.val());

    slider.on('input', function() {
        display.text($(this).val());
    });
}

async function opt_loadWorldbooks(panel) {
    const container = panel.find('#amily2_opt_worldbook_checkbox_list');
    const settings = opt_getMergedSettings();
    const currentSelection = settings.plotOpt_selectedWorldbooks || [];
    container.empty();

    try {
        const lorebooks = await safeLorebooks();
        if (!lorebooks || lorebooks.length === 0) {
            container.html('<p class="notes">未找到世界书。</p>');
            return;
        }

        lorebooks.forEach(name => {
            const bookId = `amily2-opt-wb-check-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const isChecked = currentSelection.includes(name);
            const item = $(`
                <div class="amily2_opt_worldbook_entry_item">
                    <input type="checkbox" id="${bookId}" value="${name}" ${isChecked ? 'checked' : ''}>
                    <label for="${bookId}">${name}</label>
                </div>
            `);
            container.append(item);
        });
    } catch (error) {
        console.error(`[${extensionName}] 加载世界书失败:`, error);
        container.html('<p class="notes" style="color:red;">加载世界书列表失败。</p>');
        toastr.error('无法加载世界书列表，请查看控制台。');
    }
}

async function opt_loadWorldbookEntries(panel) {
    const container = panel.find('#amily2_opt_worldbook_entry_list_container');
    const countDisplay = panel.find('#amily2_opt_worldbook_entry_count');
    container.html('<p>加载条目中...</p>');
    countDisplay.text('');

    const settings = opt_getMergedSettings(); 
    const currentSource = settings.plotOpt_worldbookSource || 'character';
    let bookNames = [];

    if (currentSource === 'manual') {
        bookNames = settings.plotOpt_selectedWorldbooks || [];
    } else {

        if (this_chid === -1 || !characters[this_chid]) {
            container.html('<p class="notes">未选择角色。</p>');
            countDisplay.text('');
            return;
        }
        try {
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        } catch (error) {

            console.error(`[${extensionName}] 获取角色世界书失败:`, error);
            toastr.error('获取角色世界书失败。');
            container.html('<p class="notes" style="color:red;">获取角色世界书失败。</p>');
            return;
        }
    }

    const selectedBooks = bookNames;
    let enabledEntries = settings.plotOpt_enabledWorldbookEntries || {};
    let totalEntries = 0;
    let visibleEntries = 0;

    if (selectedBooks.length === 0) {
        container.html('<p class="notes">请选择一个或多个世界书以查看其条目。</p>');
        return;
    }

    try {
        const allEntries = [];
        for (const bookName of selectedBooks) {
            const entries = await safeLorebookEntries(bookName);
            entries.forEach(entry => {
                allEntries.push({ ...entry, bookName });
            });
        }

        container.empty();
        totalEntries = allEntries.length;

        if (totalEntries === 0) {
            container.html('<p class="notes">所选世界书没有条目。</p>');
            countDisplay.text('0 条目.');
            return;
        }

        allEntries.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')).forEach(entry => {
            const entryId = `amily2-opt-entry-${entry.bookName.replace(/[^a-zA-Z0-9]/g, '-')}-${entry.uid}`;
            const isEnabled = enabledEntries[entry.bookName]?.includes(entry.uid) ?? true;

            const item = $(`
                <div class="amily2_opt_worldbook_entry_item">
                    <input type="checkbox" id="${entryId}" data-book="${entry.bookName}" data-uid="${entry.uid}" ${isEnabled ? 'checked' : ''}>
                    <label for="${entryId}" title="世界书: ${entry.bookName}\nUID: ${entry.uid}">${entry.comment || '无标题条目'}</label>
                </div>
            `);
            container.append(item);
        });
        
        visibleEntries = container.children().length;
        countDisplay.text(`显示 ${visibleEntries} / ${totalEntries} 条目.`);

    } catch (error) {
        console.error(`[${extensionName}] 加载世界书条目失败:`, error);
        container.html('<p class="notes" style="color:red;">加载条目失败。</p>');
    }
}


function opt_saveEnabledEntries() {
    const panel = $('#amily2_plot_optimization_panel');
    let enabledEntries = {};

    panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').each(function() {
        const bookName = $(this).data('book');
        const uid = parseInt($(this).data('uid'));

        if (!enabledEntries[bookName]) {
            enabledEntries[bookName] = [];
        }

        if ($(this).is(':checked')) {
            enabledEntries[bookName].push(uid);
        }
    });
    
    const settings = opt_getMergedSettings();
    
    if (settings.plotOpt_worldbookSource === 'manual') {
        const selectedBooks = settings.plotOpt_selectedWorldbooks || [];
        Object.keys(enabledEntries).forEach(bookName => {
            if (!selectedBooks.includes(bookName)) {
                delete enabledEntries[bookName];
            }
        });
    }

    opt_saveSetting('plotOpt_enabledWorldbookEntries', enabledEntries);
}


function opt_loadPromptPresets(panel) {
    const presets = extension_settings[extensionName]?.promptPresets || [];
    const select = panel.find('#amily2_opt_prompt_preset_select');

    const currentValue = select.val();
    select.empty().append(new Option('-- 选择一个预设 --', ''));

    presets.forEach(preset => {
        select.append(new Option(preset.name, preset.name));
    });

    if (currentValue && presets.some(p => p.name === currentValue)) {
        select.val(currentValue);
    }
}


function opt_saveCurrentPromptsAsPreset(panel) {
    const presetName = prompt("请输入预设名称：");
    if (!presetName) return;

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === presetName);

    const newPresetData = {
        name: presetName,
        mainPrompt: panel.find('#amily2_opt_main_prompt').val(),
        systemPrompt: panel.find('#amily2_opt_system_prompt').val(),
        finalSystemDirective: panel.find('#amily2_opt_final_system_directive').val(),
        rateMain: parseFloat(panel.find('#amily2_opt_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#amily2_opt_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#amily2_opt_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#amily2_opt_rate_cuckold').val())
    };

    if (existingPresetIndex !== -1) {
        if (confirm(`名为 "${presetName}" 的预设已存在。是否要覆盖它？`)) {
            presets[existingPresetIndex] = newPresetData;
            toastr.success(`预设 "${presetName}" 已被覆盖。`);
        } else {
            toastr.info('保存操作已取消。');
            return;
        }
    } else {
        presets.push(newPresetData);
        toastr.success(`预设 "${presetName}" 已保存。`);
    }
    opt_saveSetting('promptPresets', presets);

    opt_loadPromptPresets(panel);
    setTimeout(() => {
        panel.find('#amily2_opt_prompt_preset_select').val(presetName).trigger('change');
    }, 0);
}

function opt_deleteSelectedPreset(panel) {
    const select = panel.find('#amily2_opt_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.warning('没有选择任何预设。');
        return;
    }

    if (!confirm(`确定要删除预设 "${selectedName}" 吗？`)) {
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const indexToDelete = presets.findIndex(p => p.name === selectedName);

    if (indexToDelete > -1) {
        presets.splice(indexToDelete, 1);
        opt_saveSetting('promptPresets', presets);
        toastr.success(`预设 "${selectedName}" 已被删除。`);
    } else {
        toastr.error('找不到要删除的预设，操作可能已过期。');
    }

    opt_loadPromptPresets(panel);
    select.trigger('change');
}

function opt_exportPromptPresets() {
    const select = $('#amily2_opt_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.info('请先从下拉菜单中选择一个要导出的预设。');
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const selectedPreset = presets.find(p => p.name === selectedName);

    if (!selectedPreset) {
        toastr.error('找不到选中的预设，请刷新页面后重试。');
        return;
    }

    const dataToExport = [selectedPreset];
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `amily2_opt_preset_${selectedName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`预设 "${selectedName}" 已成功导出。`);
}


function opt_importPromptPresets(file, panel) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedPresets = JSON.parse(e.target.result);

            if (!Array.isArray(importedPresets)) {
                throw new Error('JSON文件格式不正确，根节点必须是一个数组。');
            }

            let currentPresets = extension_settings[extensionName]?.promptPresets || [];
            let importedCount = 0;
            let overwrittenCount = 0;

            importedPresets.forEach(preset => {
                if (preset && typeof preset.name === 'string' && preset.name.length > 0) {
                    const presetData = {
                        name: preset.name,
                        mainPrompt: preset.mainPrompt || '',
                        systemPrompt: preset.systemPrompt || '',
                        finalSystemDirective: preset.finalSystemDirective || '',
                        rateMain: preset.rateMain ?? 1.0,
                        ratePersonal: preset.ratePersonal ?? 1.0,
                        rateErotic: preset.rateErotic ?? 1.0,
                        rateCuckold: preset.rateCuckold ?? 1.0
                    };

                    const existingIndex = currentPresets.findIndex(p => p.name === preset.name);

                    if (existingIndex !== -1) {
                        currentPresets[existingIndex] = presetData;
                        overwrittenCount++;
                    } else {
                        currentPresets.push(presetData);
                        importedCount++;
                    }
                }
            });

            if (importedCount > 0 || overwrittenCount > 0) {
                const selectedPresetBeforeImport = panel.find('#amily2_opt_prompt_preset_select').val();
                
                opt_saveSetting('promptPresets', currentPresets);
                opt_loadPromptPresets(panel);
                panel.find('#amily2_opt_prompt_preset_select').val(selectedPresetBeforeImport);
                panel.find('#amily2_opt_prompt_preset_select').trigger('change');

                let messages = [];
                if (importedCount > 0) messages.push(`成功导入 ${importedCount} 个新预设。`);
                if (overwrittenCount > 0) messages.push(`成功覆盖 ${overwrittenCount} 个同名预设。`);
                toastr.success(messages.join(' '));
            } else {
                toastr.warning('未找到可导入的有效预设。');
            }

        } catch (error) {
            console.error(`[${extensionName}] 导入预设失败:`, error);
            toastr.error(`导入失败: ${error.message}`, '错误');
        } finally {
            panel.find('#amily2_opt_preset_file_input').val('');
        }
    };
    reader.readAsText(file);
}

function opt_loadSettings(panel) {
    const settings = opt_getMergedSettings();

    panel.find('#amily2_opt_enabled').prop('checked', settings.plotOpt_enabled);
    panel.find('#amily2_opt_table_enabled').prop('checked', settings.plotOpt_tableEnabled);
    panel.find(`input[name="amily2_opt_api_mode"][value="${settings.plotOpt_apiMode}"]`).prop('checked', true);
    panel.find('#amily2_opt_tavern_api_profile_select').val(settings.plotOpt_tavernProfile);
    panel.find(`input[name="amily2_opt_worldbook_source"][value="${settings.plotOpt_worldbookSource || 'character'}"]`).prop('checked', true);
    panel.find('#amily2_opt_worldbook_enabled').prop('checked', settings.plotOpt_worldbookEnabled);
    panel.find('#amily2_opt_api_url').val(settings.plotOpt_apiUrl);
    panel.find('#amily2_opt_api_key').val(settings.plotOpt_apiKey);
    
    const modelInput = panel.find('#amily2_opt_model');
    const modelSelect = panel.find('#amily2_opt_model_select');
    
    modelInput.val(settings.plotOpt_model);
    modelSelect.empty();
    if (settings.plotOpt_model) {
        modelSelect.append(new Option(settings.plotOpt_model, settings.plotOpt_model, true, true));
    } else {
        modelSelect.append(new Option('<-请先获取模型', '', true, true));
    }

    panel.find('#amily2_opt_max_tokens').val(settings.plotOpt_max_tokens);
    panel.find('#amily2_opt_temperature').val(settings.plotOpt_temperature);
    panel.find('#amily2_opt_top_p').val(settings.plotOpt_top_p);
    panel.find('#amily2_opt_presence_penalty').val(settings.plotOpt_presence_penalty);
    panel.find('#amily2_opt_frequency_penalty').val(settings.plotOpt_frequency_penalty);
    panel.find('#amily2_opt_context_turn_count').val(settings.plotOpt_contextTurnCount);
    panel.find('#amily2_opt_worldbook_char_limit').val(settings.plotOpt_worldbookCharLimit);
    panel.find('#amily2_opt_context_limit').val(settings.plotOpt_contextLimit);

    panel.find('#amily2_opt_rate_main').val(settings.plotOpt_rateMain);
    panel.find('#amily2_opt_rate_personal').val(settings.plotOpt_ratePersonal);
    panel.find('#amily2_opt_rate_erotic').val(settings.plotOpt_rateErotic);
    panel.find('#amily2_opt_rate_cuckold').val(settings.plotOpt_rateCuckold);

    panel.find('#amily2_opt_main_prompt').val(settings.plotOpt_mainPrompt);
    panel.find('#amily2_opt_system_prompt').val(settings.plotOpt_systemPrompt);
    panel.find('#amily2_opt_final_system_directive').val(settings.plotOpt_finalSystemDirective);

    opt_updateApiUrlVisibility(panel, settings.plotOpt_apiMode);
    opt_updateWorldbookSourceVisibility(panel, settings.plotOpt_worldbookSource || 'character');
    
    opt_bindSlider(panel, '#amily2_opt_max_tokens', '#amily2_opt_max_tokens_value');
    opt_bindSlider(panel, '#amily2_opt_temperature', '#amily2_opt_temperature_value');
    opt_bindSlider(panel, '#amily2_opt_top_p', '#amily2_opt_top_p_value');
    opt_bindSlider(panel, '#amily2_opt_presence_penalty', '#amily2_opt_presence_penalty_value');
    opt_bindSlider(panel, '#amily2_opt_frequency_penalty', '#amily2_opt_frequency_penalty_value');
    opt_bindSlider(panel, '#amily2_opt_context_turn_count', '#amily2_opt_context_turn_count_value');
    opt_bindSlider(panel, '#amily2_opt_worldbook_char_limit', '#amily2_opt_worldbook_char_limit_value');
    opt_bindSlider(panel, '#amily2_opt_context_limit', '#amily2_opt_context_limit_value');

    opt_loadPromptPresets(panel);

    const lastUsedPresetName = settings.plotOpt_lastUsedPresetName;
    if (lastUsedPresetName && (settings.plotOpt_promptPresets || []).some(p => p.name === lastUsedPresetName)) {

        setTimeout(() => {
            panel.find('#amily2_opt_prompt_preset_select').val(lastUsedPresetName).trigger('change', { isAutomatic: true });
        }, 0);
    }

    opt_loadWorldbooks(panel).then(() => {
        opt_loadWorldbookEntries(panel);
    });

    opt_loadTavernApiProfiles(panel);
}


export function initializePlotOptimizationBindings() {
    const panel = $('#amily2_plot_optimization_panel');
    if (panel.length === 0 || panel.data('events-bound')) {
        return;
    }
    
    opt_loadSettings(panel);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log(`[${extensionName}] 检测到角色/聊天切换，正在刷新剧情优化设置UI...`);
        opt_loadSettings(panel);
    });

    const handleSettingChange = function(element) {
        const el = $(element);
        const key_part = (element.name || element.id).replace('amily2_opt_', '');
        const key = 'plotOpt_' + key_part.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
        
        let value = element.type === 'checkbox' ? element.checked : el.val();

        if (key === 'plotOpt_selected_worldbooks' && !Array.isArray(value)) {
            value = el.val() || [];
        }
        
        const floatKeys = ['plotOpt_temperature', 'plotOpt_top_p', 'plotOpt_presence_penalty', 'plotOpt_frequency_penalty', 'plotOpt_rateMain', 'plotOpt_ratePersonal', 'plotOpt_rateErotic', 'plotOpt_rateCuckold'];
        if (floatKeys.includes(key) && value !== '') {
            value = parseFloat(value);
        } else if (element.type === 'range' || element.type === 'number') {
            if (value !== '') value = parseInt(value, 10);
        }
        
        if (value !== '' || element.type === 'checkbox') {
             opt_saveSetting(key, value);
        }

        if (key === 'plotOpt_api_mode') {
            opt_updateApiUrlVisibility(panel, value);
        }
        
        if (element.name === 'amily2_opt_worldbook_source') {
            opt_updateWorldbookSourceVisibility(panel, value);
            opt_loadWorldbookEntries(panel);
        }
    };
    const allInputSelectors = [
        'input[type="checkbox"]', 'input[type="radio"]', 'select:not(#amily2_opt_model_select)',
        'input[type="text"]', 'input[type="password"]', 'textarea',
        'input[type="range"]', 'input[type="number"]'
    ].join(', ');

    panel.on('input.amily2_opt change.amily2_opt', allInputSelectors, function() {
        handleSettingChange(this);
    });

    panel.on('change.amily2_opt', '#amily2_opt_model_select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            panel.find('#amily2_opt_model').val(selectedModel).trigger('change');
        }
    });


    panel.on('click.amily2_opt', '#amily2_opt_refresh_tavern_api_profiles', () => {
        opt_loadTavernApiProfiles(panel);
    });

    panel.on('change.amily2_opt', '#amily2_opt_tavern_api_profile_select', function() {
        const value = $(this).val();
        opt_saveSetting('tavernProfile', value);
    });


    panel.find('#amily2_opt_import_prompt_presets').on('click', () => panel.find('#amily2_opt_preset_file_input').click());
    panel.find('#amily2_opt_export_prompt_presets').on('click', () => opt_exportPromptPresets());
    panel.find('#amily2_opt_save_prompt_preset').on('click', () => opt_saveCurrentPromptsAsPreset(panel));
    panel.find('#amily2_opt_delete_prompt_preset').on('click', () => opt_deleteSelectedPreset(panel));

    panel.on('change.amily2_opt', '#amily2_opt_preset_file_input', function(e) {
        opt_importPromptPresets(e.target.files[0], panel);
    });

    panel.on('change.amily2_opt', '#amily2_opt_prompt_preset_select', function(event, data) {
        const selectedName = $(this).val();
        const deleteBtn = panel.find('#amily2_opt_delete_prompt_preset');
        const isAutomatic = data && data.isAutomatic; 

        opt_saveSetting('lastUsedPresetName', selectedName);

        if (!selectedName) {
            deleteBtn.hide();
            opt_saveSetting('lastUsedPresetName', '');
            return;
        }

        const presets = extension_settings[extensionName]?.promptPresets || [];
        const selectedPreset = presets.find(p => p.name === selectedName);

        if (selectedPreset) {
            panel.find('#amily2_opt_main_prompt').val(selectedPreset.mainPrompt).trigger('change');
            panel.find('#amily2_opt_system_prompt').val(selectedPreset.systemPrompt).trigger('change');
            panel.find('#amily2_opt_final_system_directive').val(selectedPreset.finalSystemDirective).trigger('change');

            panel.find('#amily2_opt_rate_main').val(selectedPreset.rateMain ?? 1.0).trigger('change');
            panel.find('#amily2_opt_rate_personal').val(selectedPreset.ratePersonal ?? 1.0).trigger('change');
            panel.find('#amily2_opt_rate_erotic').val(selectedPreset.rateErotic ?? 1.0).trigger('change');
            panel.find('#amily2_opt_rate_cuckold').val(selectedPreset.rateCuckold ?? 1.0).trigger('change');

            if (!isAutomatic) {
                toastr.success(`已加载预设 "${selectedName}"。`);
            }
            deleteBtn.show();
        } else {
            deleteBtn.hide();
        }
    });


    panel.find('#amily2_opt_reset_main_prompt').on('click', function() {
        panel.find('#amily2_opt_main_prompt').val(defaultSettings.plotOpt_mainPrompt).trigger('change');
        toastr.success('主提示词已重置为默认值。');
    });

    panel.find('#amily2_opt_reset_system_prompt').on('click', function() {
        panel.find('#amily2_opt_system_prompt').val(defaultSettings.plotOpt_systemPrompt).trigger('change');
        toastr.success('拦截任务指令已重置为默认值。');
    });

    panel.find('#amily2_opt_reset_final_system_directive').on('click', function() {
        panel.find('#amily2_opt_final_system_directive').val(defaultSettings.plotOpt_finalSystemDirective).trigger('change');
        toastr.success('最终注入指令已重置为默认值。');
    });

    panel.data('events-bound', true);
    console.log(`[${extensionName}] 剧情优化UI事件已成功绑定，自动保存已激活。`);

    panel.on('click.amily2_opt', '#amily2_opt_refresh_worldbooks', () => {
        opt_loadWorldbooks(panel).then(() => {
            opt_loadWorldbookEntries(panel);
        });
    });


    panel.on('change.amily2_opt', '#amily2_opt_worldbook_checkbox_list input[type="checkbox"]', async function() {
        const selected = [];
        panel.find('#amily2_opt_worldbook_checkbox_list input:checked').each(function() {
            selected.push($(this).val());
        });

        await opt_saveSetting('plotOpt_selectedWorldbooks', selected);
        await opt_loadWorldbookEntries(panel);
    });

    panel.on('change.amily2_opt', '#amily2_opt_worldbook_entry_list_container input[type="checkbox"]', () => {
        opt_saveEnabledEntries();
    });

    panel.on('click.amily2_opt', '#amily2_opt_worldbook_entry_select_all', () => {
        panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').prop('checked', true);
        opt_saveEnabledEntries();
    });

    panel.on('click.amily2_opt', '#amily2_opt_worldbook_entry_deselect_all', () => {
        panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').prop('checked', false);
        opt_saveEnabledEntries();
    });
}

$(document).on('change', 'input[name="amily2_icon_location"]', function() {
    if (!pluginAuthStatus.authorized) return;
    const newLocation = $(this).val();
    extension_settings[extensionName]['iconLocation'] = newLocation;
    saveSettingsDebounced();
    console.log(`[Amily-禁卫军] 收到迁都指令 -> ${newLocation}。圣意已存档。`);
    toastr.info(`正在将帝国徽记迁往 [${newLocation === 'topbar' ? '顶栏' : '扩展区'}]...`, "迁都令", { timeOut: 2000 });
    $('#amily2_main_drawer').remove(); 
    $(document).off("mousedown.amily2Drawer"); 
    $('#amily2_extension_frame').remove();

    setTimeout(createDrawer, 50); 
});
