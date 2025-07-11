import { extension_settings } from "/scripts/extensions.js";
import { extensionName } from "../utils/settings.js";
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
    } else {
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

    $("#amily2_enabled").prop("checked", settings.enabled);
    $("#amily2_api_url").val(settings.apiUrl);
    $("#amily2_api_key").val(settings.apiKey);
    $("#amily2_model").val(settings.model);


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
    $("#amily2_show_optimization_toast").prop(
      "checked",
      settings.showOptimizationToast,
    );
    $("#amily2_suppress_toast").prop("checked", settings.suppressToast);


    $("#amily2_system_prompt").val(settings.systemPrompt);
    $("#amily2_main_prompt").val(settings.mainPrompt);
    $("#amily2_output_format_prompt").val(settings.outputFormatPrompt);
    $("#amily2_summarization_prompt").val(settings.summarizationPrompt);


    $("#amily2_worldbook_enabled").prop("checked", settings.worldbookEnabled);
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
    populateModelDropdown(); 
  }
}
