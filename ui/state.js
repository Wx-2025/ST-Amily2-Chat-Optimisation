import { extension_settings } from "/scripts/extensions.js";
import { characters, this_chid } from '/script.js';
import { extensionName, defaultSettings } from "../utils/settings.js";
import { pluginAuthStatus } from "../utils/auth.js";



let availableModels = [];
let latestUpdateInfo = null;
let newVersionAvailable = false;

export function setUpdateInfo(isNew, updateInfo) {
    newVersionAvailable = isNew;
    latestUpdateInfo = updateInfo;
}


export function applyUpdateIndicator() {
    if (newVersionAvailable) {
        $('#amily2_update_indicator').show();
        $('#amily2_update_button_new').show();
    } else {
        $('#amily2_update_indicator').hide();
        $('#amily2_update_button_new').hide();
    }
}

export function getLatestUpdateInfo() {
    return latestUpdateInfo;
}

export function setAvailableModels(models) {
  availableModels = models;
}


export function populateModelDropdown() {
  const modelSelect = $("#amily2_model");
  const modelNotes = $("#amily2_model_notes");

  modelSelect.empty();
  const currentModel = extension_settings[extensionName]?.model || "";

  if (availableModels.length === 0) {
    modelSelect.append('<option value="">无可用模型，请刷新</option>');
    modelNotes.html(
      '<span style="color: #ff9800;">请检查API配置后点击"刷新模型"</span>',
    );
    return;
  }

  const defaultOption = $("<option></option>").val("").text("-- 选择模型 --");
  modelSelect.append(defaultOption);

  availableModels.forEach((model) => {
    const option = $("<option></option>").val(model).text(model);
    if (model === currentModel) {
      option.attr("selected", "selected");
    }
    modelSelect.append(option);
  });

  if (currentModel && modelSelect.val() === currentModel) {
    modelNotes.html(`已选择: <strong>${currentModel}</strong>`);
  } else {
    modelNotes.html(`已加载 ${availableModels.length} 个可用模型`);
  }
}


export function updateUI() {
  if (!pluginAuthStatus.authorized) {
    $("#auth_panel").show();
    $(".plugin-features").hide();
  } else {
    $("#auth_panel").hide();
    $(".plugin-features").show();

    const settings = extension_settings[extensionName];
    if (!settings) return; 

    $("#amily2_api_provider").val(settings.apiProvider || 'openai');
    $("#amily2_api_url").val(settings.apiUrl);
    $("#amily2_api_url").attr('type', 'text');
    $("#amily2_api_key").val(settings.apiKey);
    $("#amily2_model").val(settings.model);
    $("#amily2_preset_selector").val(settings.tavernProfile);

    $("#amily2_api_provider").trigger('change');


    $("#amily2_max_tokens").val(settings.maxTokens);
    $("#amily2_max_tokens_value").text(settings.maxTokens);
    $("#amily2_temperature").val(settings.temperature);
    $("#amily2_temperature_value").text(settings.temperature);
    $("#amily2_context_messages").val(settings.contextMessages);
    $("#amily2_context_messages_value").text(settings.contextMessages);
	$("#amily2_optimization_target_tag").val(settings.optimizationTargetTag);


    $(
      `input[name="amily2_optimization_mode"][value="${settings.optimizationMode}"]`,
    ).prop("checked", true);
    $("#amily2_optimization_enabled").prop(
      "checked",
      settings.optimizationEnabled,
    );
    $("#amily2_optimization_exclusion_enabled").prop(
      "checked",
      settings.optimizationExclusionEnabled,
    );
    $("#amily2_show_optimization_toast").prop(
      "checked",
      settings.showOptimizationToast,
    );
    $("#amily2_suppress_toast").prop("checked", settings.suppressToast);


    $("#amily2_system_prompt").val(settings.systemPrompt);
    $("#amily2_main_prompt").val(settings.mainPrompt);
    $("#amily2_output_format_prompt").val(settings.outputFormatPrompt);
    $("#amily2_summarization_prompt").val(settings.summarizationPrompt);


    $("#amily2_summarization_enabled").prop(
      "checked",
      settings.summarizationEnabled,
    );
    $(
      `input[name="amily2_lorebook_target"][value="${settings.lorebookTarget}"]`,
    ).prop("checked", true);

    $(`input[name="amily2_icon_location"][value="${settings.iconLocation}"]`).prop("checked", true);
    $("#amily2_auto_hide_enabled").prop("checked", settings.autoHideEnabled);
    $("#amily2_auto_hide_threshold").val(settings.autoHideThreshold);
    $("#amily2_auto_hide_threshold_value").text(settings.autoHideThreshold);
        $('#amily2_lore_activation_mode').val(settings.loreActivationMode);
        $('#amily2_lore_insertion_position').val(settings.loreInsertionPosition);
        $('#amily2_lore_depth_input').val(settings.loreDepth);
        if (settings.loreInsertionPosition === 'at_depth') {
            $('#amily2_lore_depth_container').show();
        } else {
            $('#amily2_lore_depth_container').hide(); 
        }
    if (settings.historiographySmallAutoEnable !== undefined) {
        $('#amily2_mhb_small_auto_enabled').prop('checked', settings.historiographySmallAutoEnable);
    }
    if (settings.historiographySmallTriggerThreshold !== undefined) {
        $('#amily2_mhb_small_trigger_count').val(settings.historiographySmallTriggerThreshold);
    }
    populateModelDropdown();
    updatePlotOptimizationUI(); 
  }
}


// =====================================================================
// ======== 【剧情优化】 - UI状态管理 ========
// =====================================================================

function getMergedPlotOptSettings() {
    const character = (characters && typeof this_chid !== 'undefined' && characters[this_chid]) ? characters[this_chid] : null;
    const globalSettings = extension_settings[extensionName] || defaultSettings;
    const characterSettings = character?.data?.extensions?.[extensionName] || {};
    
    return { ...globalSettings, ...characterSettings };
}


export function updatePlotOptimizationUI() {
    const settings = getMergedPlotOptSettings();
    if (!settings) return;

    $('#amily2_opt_enabled').prop('checked', settings.plotOpt_enabled);
    $('#amily2_opt_ejs_enabled').prop('checked', settings.plotOpt_ejsEnabled);
    $('#amily2_opt_worldbook_enabled').prop('checked', settings.plotOpt_worldbook_enabled);
    $('#amily2_opt_table_enabled').prop('checked', settings.plotOpt_tableEnabled);

    $('#amily2_opt_main_prompt').val(settings.plotOpt_mainPrompt);
    $('#amily2_opt_system_prompt').val(settings.plotOpt_systemPrompt);
    $('#amily2_opt_final_system_directive').val(settings.plotOpt_finalSystemDirective);

    $('#amily2_opt_rate_main').val(settings.plotOpt_rateMain);
    $('#amily2_opt_rate_personal').val(settings.plotOpt_ratePersonal);
    $('#amily2_opt_rate_erotic').val(settings.plotOpt_rateErotic);
    $('#amily2_opt_rate_cuckold').val(settings.plotOpt_rateCuckold);

    const sliders = {
        '#amily2_opt_context_limit': 'plotOpt_contextLimit',
        '#amily2_opt_worldbook_char_limit': 'plotOpt_worldbookCharLimit',
    };

    for (const sliderId in sliders) {
        const key = sliders[sliderId];
        const value = settings[key];
        const valueDisplayId = `${sliderId}_value`;

        if (value !== undefined) {
            $(sliderId).val(value);
            $(valueDisplayId).text(value);
        }
    }

    const worldbookSource = settings.plotOpt_worldbookSource || 'character';
    $(`input[name="amily2_opt_worldbook_source"][value="${worldbookSource}"]`).prop('checked', true);

    const lastUsedPresetName = settings.plotOpt_lastUsedPresetName;
    if (lastUsedPresetName && $('#amily2_opt_prompt_preset_select option[value="' + lastUsedPresetName + '"]').length > 0) {
        $('#amily2_opt_prompt_preset_select').val(lastUsedPresetName);
    }
    
    console.log(`[${extensionName}] (state.js) 剧情优化UI已根据合并设置更新。`);
}
