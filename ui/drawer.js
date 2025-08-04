import { getSlideToggleOptions } from '/script.js';
import { slideToggle } from '/lib.js';
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
  applyUpdateIndicator,
} from "./state.js";
import { bindModalEvents } from "./bindings.js";
import { fetchSupportedModels } from "../core/api.js";
import { bindHistoriographyEvents } from "./historiography-bindings.js";
import { bindHanlinyuanEvents } from "./hanlinyuan-bindings.js";
import { showContentModal } from "./page-window.js";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;


async function loadSettings() {
  extension_settings[extensionName] = {
    ...defaultSettings,
    ...(extension_settings[extensionName] || {}),
  };


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
  const settings = extension_settings[extensionName];
  const location = settings.iconLocation || 'topbar'; 

  if (location === 'topbar') {
    if ($("#amily2_main_drawer").length > 0) return; 


    const amily2DrawerHtml = `
      <div id="amily2_main_drawer" class="drawer">
          <div id="amily2_drawer_icon" class="drawer-toggle drawer-header closedIcon interactable" title="Amily2号优化助手" tabindex="0">
              <i class="drawer-icon fa-solid fa-magic fa-fw"></i>
          </div>
          <div id="amily2_drawer_content" class="drawer-content closedDrawer" style="display: none;">
          </div>
      </div>
    `;
    $("#sys-settings-button").after(amily2DrawerHtml);

    $(document).off("mousedown.amily2Drawer").on(
      "mousedown.amily2Drawer",
      "#amily2_drawer_icon",
      async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const drawerIcon = $(this);
        const contentPanel = $("#amily2_drawer_content");

        $('.openDrawer').not(contentPanel).not('.pinnedOpen').addClass('resizing').each((_, el) => {
            slideToggle(el, {
                ...getSlideToggleOptions(),
                onAnimationEnd: function (el) {
                    el.closest('.drawer-content').classList.remove('resizing');
                },
            });
        });
        $('.openIcon').not(drawerIcon).not('.drawerPinnedOpen').toggleClass('closedIcon openIcon');
        $('.openDrawer').not(contentPanel).not('.pinnedOpen').toggleClass('closedDrawer openDrawer');
        drawerIcon.toggleClass('closedIcon openIcon');
        contentPanel.toggleClass('closedDrawer openDrawer');
        contentPanel.addClass('resizing').each((_, el) => {
            slideToggle(el, {
                ...getSlideToggleOptions(),
                onAnimationEnd: function (el) {
                    el.closest('.drawer-content').classList.remove('resizing');
                },
            });
        });

        const isInitialized = contentPanel.data("initialized");
        if (drawerIcon.hasClass("openIcon") && !isInitialized) {
          try {
            const modalContent = await $.get(`${extensionFolderPath}/assets/amily2-modal.html`);
            contentPanel.html(modalContent);
            const mainContainer = contentPanel.find('#amily2_chat_optimiser');

            if (mainContainer.length) {
                // 加载内阁密室
                const additionalFeaturesContent = await $.get(`${extensionFolderPath}/assets/Amily2-AdditionalFeatures.html`);
                const additionalPanelHtml = `<div id="amily2_additional_features_panel" style="display: none;">${additionalFeaturesContent}</div>`;
                mainContainer.append(additionalPanelHtml);

                // 加载翰林院
                const hanlinyuanContent = await $.get(`${extensionFolderPath}/assets/hanlinyuan.html`);
                const hanlinyuanPanelHtml = `<div id="amily2_hanlinyuan_panel" style="display: none;">${hanlinyuanContent}</div>`;
                mainContainer.append(hanlinyuanPanelHtml);
            }

            await loadSettings();
            bindModalEvents();
            bindHistoriographyEvents();
            bindHanlinyuanEvents(); // 【圣谕】召唤翰林院工匠
            contentPanel.data("initialized", true);
            console.log("[Amily-重构] 顶栏宫殿已按模块化蓝图竣工。");
            applyUpdateIndicator();
          } catch (error) {
            console.error("[Amily-建设部] 紧急报告：加载模块化蓝图时发生意外:", error);
            contentPanel.html('<p style="color:red; padding: 20px;">紧急报告：无法加载Amily2号府邸内饰。</p>');
          }
        }
      },
    );

  } else if (location === 'extensions') {
    if ($("#extensions_settings2 #amily2_chat_optimiser").length > 0) return; 
    const amilyFrameHtml = `
      <div id="amily2_extension_frame">
          <div class="inline-drawer">
              <div class="inline-drawer-toggle inline-drawer-header">
                  <b><i class="fas fa-crown" style="color: #ffc107;"></i> Amily2号 优化中枢</b>
                  <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
              </div>
              <div class="inline-drawer-content" style="display: none;">
                  <!-- 宫殿的真正内室将在这里安家 -->
              </div>
          </div>
      </div>
    `;

    $('#extensions_settings2').append(amilyFrameHtml);

    (async () => {
      try {
        console.log("[Amily-重构] 收到指令，开始在'扩展'官方区域模块化建造宫殿。");
        const contentPanel = $('#amily2_extension_frame .inline-drawer-content');
        const modalContent = await $.get(`${extensionFolderPath}/assets/amily2-modal.html`);
        contentPanel.html(modalContent);
        const mainContainer = contentPanel.find('#amily2_chat_optimiser');

        if (mainContainer.length) {
            // 加载内阁密室
            const additionalFeaturesContent = await $.get(`${extensionFolderPath}/assets/Amily2-AdditionalFeatures.html`);
            const additionalPanelHtml = `<div id="amily2_additional_features_panel" style="display: none;">${additionalFeaturesContent}</div>`;
            mainContainer.append(additionalPanelHtml);

            // 加载翰林院
            const hanlinyuanContent = await $.get(`${extensionFolderPath}/assets/hanlinyuan.html`);
            const hanlinyuanPanelHtml = `<div id="amily2_hanlinyuan_panel" style="display: none;">${hanlinyuanContent}</div>`;
            mainContainer.append(hanlinyuanPanelHtml);
        }

        await loadSettings();
        bindModalEvents();
        bindHistoriographyEvents();
        bindHanlinyuanEvents(); // 【圣谕】再次召唤，以适应不同宫殿
        applyUpdateIndicator();
      } catch (error) {
        console.error("[Amily-建设部] 紧急报告：加载模块化蓝图时发生意外:", error);
        $('#extensions_settings2').append('<p style="color:red; padding:10px; border:1px solid red; border-radius:5px;">紧急报告：在扩展区域建造Amily2号府邸时发生意外。</p>');
      }
    })();
  }
}
