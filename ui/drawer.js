import { extension_settings } from "/scripts/extensions.js";
import { extensionName, defaultSettings } from "../utils/settings.js";
import {
  checkAuthorization,
  displayExpiryInfo,
  pluginAuthStatus,
} from "../utils/auth.js";
import {
  updateUI,
  setAvailableModels,
  populateModelDropdown,
} from "./state.js";
import { bindModalEvents } from "./bindings.js";
import { fetchSupportedModels } from "../core/api.js";

const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

async function loadSettings() {
  if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
  }
  Object.assign(extension_settings[extensionName], {
    ...defaultSettings,
    ...extension_settings[extensionName],
  });

  checkAuthorization();


  const autoLogin = localStorage.getItem("plugin_auto_login") === "true";
  console.log(
    `[Amily2-调试] 授权状态: ${pluginAuthStatus.authorized}, 自动登录标志: ${autoLogin}`,
  );
  if (autoLogin && pluginAuthStatus.authorized) {
    console.log("[Amily2号] 检测到有效授权，将执行自动UI更新。");
  }

  $("#expiry_info").html(displayExpiryInfo());
  updateUI();

  if (pluginAuthStatus.authorized && extension_settings[extensionName].apiUrl) {
    const cachedModels = localStorage.getItem("cached_models_amily2");
    if (cachedModels) {
      const models = JSON.parse(cachedModels);
      console.log(`[Amily2号] 从缓存加载模型列表 (${models.length}个)`);
      setAvailableModels(models);
      populateModelDropdown();
    } else {
      toastr.info("正在自动加载模型列表...", "Amily2号");
      setTimeout(async () => {
        const models = await fetchSupportedModels();
        if (models.length > 0) {
          setAvailableModels(models);
          localStorage.setItem("cached_models_amily2", JSON.stringify(models));
          populateModelDropdown();
        }
      }, 500);
    }
  }
}

export function createDrawer() {
  if ($("#amily2-main-drawer").length > 0) return;

  const amily2DrawerHtml = `
        <div id="amily2-main-drawer" class="drawer">
            <div class="drawer-toggle drawer-header" title="Amily2号优化助手">
                <div id="amily2-drawer-icon" class="drawer-icon fa-solid fa-magic fa-fw closedIcon interactable" tabindex="0"></div>
            </div>
            <div id="amily2-drawer-content" class="drawer-content" style="display: none;">
                <!-- 王座将在此处动态加载 -->
            </div>
        </div>
    `;
  $("#sys-settings-button").after(amily2DrawerHtml);


  $(document).on(
    "mousedown",
    "#amily2-main-drawer .drawer-toggle",
    async function (e) {
      e.preventDefault(); 
      e.stopPropagation(); 

      const drawerIcon = $("#amily2-drawer-icon");
      const contentPanel = $("#amily2-drawer-content");
      const isOpening = drawerIcon.hasClass("closedIcon");


      $(".openIcon")
        .not(drawerIcon)
        .removeClass("openIcon")
        .addClass("closedIcon");
      $(".openDrawer")
        .not(contentPanel)
        .removeClass("openDrawer")
        .slideUp({ duration: 200, easing: "swing" });


      drawerIcon.toggleClass("closedIcon openIcon");
      contentPanel.toggleClass("openDrawer");
      contentPanel.slideToggle({
        duration: 200,
        easing: "swing",
      });


      const isInitialized = contentPanel.data("initialized");
      if (isOpening && !isInitialized) {
        try {
          const modalContent = await $.get(
            `${extensionFolderPath}/assets/amily2-modal.html`,
          );
          contentPanel.html(modalContent);
          await loadSettings();
          bindModalEvents();
          contentPanel.data("initialized", true);

          console.log("[Amily2号-建设部] 宫殿内室已根据最高指令激活。");
        } catch (error) {

          console.error("[Amily2号-建设部] 加载宫殿内部HTML失败:", error);
          contentPanel.html(
            '<p style="color:red; padding: 20px;">紧急报告：无法加载Amily2号府邸内饰。</p>',
          );
        }
      }

    },
  );
}
