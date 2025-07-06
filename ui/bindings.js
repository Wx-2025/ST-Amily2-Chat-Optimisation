import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { defaultSettings, extensionName } from "../utils/settings.js";
import { pluginAuthStatus, activatePluginAuthorization } from "../utils/auth.js";
import { fetchSupportedModels } from "../core/api.js";
import { setAvailableModels, populateModelDropdown } from "./state.js";
import { fixCommand, testReplyChecker } from "../core/commands.js";


export function bindModalEvents() {
  const container = $("#amily2-drawer-content");

  if (container.data("events-bound")) return;


  const snakeToCamel = (s) => s.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
  const updateAndSaveSetting = (key, value) => {

    console.log(`[Amily-谕令确认] 收到指令: 将 [${key}] 设置为 ->`, value);

    if (!extension_settings[extensionName]) {
      extension_settings[extensionName] = {};
    }
    extension_settings[extensionName] = {
      ...extension_settings[extensionName],
      [key]: value,
    };
    saveSettingsDebounced();

    console.log(`[Amily-谕令镌刻] [${key}] 的新状态已保存。`);
  };


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
    .off("change.amily2.checkbox")
    .on(
      "change.amily2.checkbox",
      'input[type="checkbox"][id^="amily2_"]',
      function () {
        if (!pluginAuthStatus.authorized) return;
        const key = snakeToCamel(this.id.replace("amily2_", ""));
        updateAndSaveSetting(key, this.checked);
      },
    );


  container
    .off("change.amily2.radio")
    .on(
      "change.amily2.radio",
      'input[type="radio"][name^="amily2_"]',
      function () {
        if (!pluginAuthStatus.authorized) return;
        const key = snakeToCamel(this.name.replace("amily2_", ""));
        const value = $(`input[name="${this.name}"]:checked`).val();
        updateAndSaveSetting(key, value);
      },
    );

  container
    .off("change.amily2.text")
    .on("change.amily2.text", "#amily2_api_url, #amily2_api_key", function () {
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
    summarizationPrompt: "#amily2_summarization_prompt",
    outputFormatPrompt: "#amily2_output_format_prompt",
  };
  const selector = "#amily2_prompt_selector";
  const editor = "#amily2_unified_editor";
  const unifiedSaveButton = "#amily2_unified_save_button";

  function updateEditorView() {
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

  setTimeout(updateEditorView, 100);

  container.data("events-bound", true);
}