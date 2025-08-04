import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { defaultSettings, extensionName } from "../utils/settings.js";
import { pluginAuthStatus, activatePluginAuthorization, getPasswordForDate } from "../utils/auth.js";
import { fetchSupportedModels } from "../core/api.js";

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

export function bindModalEvents() {
    const container = $("#amily2_drawer_content").length ? $("#amily2_drawer_content") : $("#amily2_chat_optimiser");
    displayDailyAuthCode(); // 在绑定事件时就显示今日授权码
	    function updateModelInputView() {
        const settings = extension_settings[extensionName] || {};
        const forceProxy = settings.forceProxyForCustomApi === true;
        const model = settings.model || '';

        container.find('#amily2_force_proxy').prop('checked', forceProxy);
        container.find('#amily2_manual_model_input').val(model);

        const autoFetchWrapper = container.find('#amily2_model_autofetch_wrapper');
        const manualInput = container.find('#amily2_manual_model_input');

        if (forceProxy) {
            autoFetchWrapper.hide();
            manualInput.show();
        } else {
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

    // 在这里添加以下代码
    container
        .off("change.amily2.force_proxy")
        .on("change.amily2.force_proxy", '#amily2_force_proxy', function () {
            if (!pluginAuthStatus.authorized) return;
            // 镌刻圣意
            updateAndSaveSetting('forceProxyForCustomApi', this.checked);
            // 立即执行仪式，切换界面
            updateModelInputView();
        });
		    // 在这里添加以下代码
    container
        .off("change.amily2.manual_model")
        .on("change.amily2.manual_model", '#amily2_manual_model_input', function() {
            if (!pluginAuthStatus.authorized) return;
            // 将您御笔钦定的模型名称，镌刻入“model”这条核心法典
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
                            const models = await fetchSupportedModels();
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
            // 最终修正：根据用户提供的元素信息，使用属性选择器定位并点击“管理扩展”按钮
            $('span[data-i18n="Manage extensions"]').first().click();
        });

    // This block is intentionally left empty as the logic is now handled
    // within the 'change.amily2.checkbox' event listener below.

		

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
    .on("click.amily2.chamber_nav", "#amily2_open_additional_features, #amily2_open_rag_palace, #amily2_back_to_main_settings, #amily2_back_to_main_from_hanlinyuan", function () {
        if (!pluginAuthStatus.authorized) return;

        const mainPanel = container.find('.plugin-features');
        const additionalPanel = container.find('#amily2_additional_features_panel');
        const hanlinyuanPanel = container.find('#amily2_hanlinyuan_panel');

        // Hide all panels first
        mainPanel.hide();
        additionalPanel.hide();
        hanlinyuanPanel.hide();

        switch (this.id) {
            case 'amily2_open_additional_features':
                additionalPanel.show();
                break;
            case 'amily2_open_rag_palace':
                hanlinyuanPanel.show();
                break;
            case 'amily2_back_to_main_settings':
            case 'amily2_back_to_main_from_hanlinyuan':
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

                // Default behavior for all checkboxes: save their state immediately.
                updateAndSaveSetting(key, mainToggle.prop('checked'));

                // Special action for the exclusion toggle: also open the modal, but only when turning it ON.
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
                            // Do nothing, just close the modal.
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
        .off("change.amily2.text")
        .on("change.amily2.text", "#amily2_api_url, #amily2_api_key, #amily2_optimization_target_tag", function () {
            if (!pluginAuthStatus.authorized) return;
            const key = snakeToCamel(this.id.replace("amily2_", ""));
            updateAndSaveSetting(key, this.value);
            toastr.success(`配置 [${key}] 已自动保存!`, "Amily2号");
        });

    container
        .off("change.amily2.select")
        .on("change.amily2.select", "select#amily2_model", function () {
            if (!pluginAuthStatus.authorized) return;
            const key = snakeToCamel(this.id.replace("amily2_", ""));
            updateAndSaveSetting(key, this.value);
            populateModelDropdown();
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
	    updateModelInputView(); // 首次加载时执行仪式，初始化界面

    container.data("events-bound", true);


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
