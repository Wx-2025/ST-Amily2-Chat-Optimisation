import { getSlideToggleOptions } from '/script.js';
import { slideToggle } from '/lib.js';
import { extension_settings, renderExtensionTemplateAsync } from "/scripts/extensions.js";
import { extensionName, extensionBasePath, defaultSettings } from "../utils/settings.js";
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
import { fetchModels } from "../core/api.js";
import registry from '../SL/module/ModuleRegistry.js';
import { registerAllModules } from '../SL/module/register-all.js';
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
        const models = await fetchModels();
        if (models.length > 0) {
          setAvailableModels(models);
          localStorage.setItem("cached_models_amily2", JSON.stringify(models));
          populateModelDropdown();
        }
      }, 500);
    }
  }
}

async function initializePanel(contentPanel, errorContainer) {
    if (contentPanel.data("initialized")) return;

    try {
        // 1. 加载主面板外壳
        const modalContent = await $.get(`${extensionFolderPath}/assets/amily2-modal.html`);
        contentPanel.html(modalContent);
        const mainContainer = contentPanel.find('#amily2_chat_optimiser');

        if (mainContainer.length) {
            // 2. 注册所有模块 → 统一 init + mount
            registerAllModules();
            await registry.mountAll({
                baseUrl: extensionFolderPath + '/',
                root:    mainContainer[0],   // 所有模块挂载到此 DOM 元素下
            });
        }

        // 3. 主面板跨模块绑定（导航、授权、API provider 切换等）
        bindModalEvents();

        // 4. 加载设置（模型列表等）
        await loadSettings();

        contentPanel.data("initialized", true);
        console.log("[Amily-重构] 模块注册式架构已就绪，已挂载模块:", registry.names().join(', '));
        applyUpdateIndicator();
    } catch (error) {
        console.error("[Amily-建设部] 紧急报告：加载模块化蓝图时发生意外:", error);
        const errorMessage = errorContainer
            ? '<p style="color:red; padding:10px; border:1px solid red; border-radius:5px;">紧急报告：在扩展区域建造Amily2号府邸时发生意外。</p>'
            : '<p style="color:red; padding: 20px;">紧急报告：无法加载Amily2号府邸内饰。</p>';

        if (errorContainer) {
            errorContainer.append(errorMessage);
        } else {
            contentPanel.html(errorMessage);
        }
    }
}

function toggleDrawerFallback() {
    const drawerIcon = $('#amily2_drawer_icon');
    const contentPanel = $('#amily2_drawer_content');
    if (drawerIcon.hasClass('openIcon') && !contentPanel.is(':visible')) {
        drawerIcon.removeClass('openIcon').addClass('closedIcon');
    }
    if (drawerIcon.hasClass('closedIcon')) {
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
    } else {
        drawerIcon.toggleClass('openIcon closedIcon');
        contentPanel.toggleClass('openDrawer closedDrawer');

        contentPanel.addClass('resizing').each((_, el) => {
            slideToggle(el, {
                ...getSlideToggleOptions(),
                onAnimationEnd: function (el) {
                    el.closest('.drawer-content').classList.remove('resizing');
                },
            });
        });
    }
}


export async function createDrawer() {
  const settings = extension_settings[extensionName];
  const location = settings.iconLocation || 'topbar'; 

  if (location === 'topbar') {
    if ($("#amily2_main_drawer").length > 0) return; 

    const amily2DrawerHtml = `
      <div id="amily2_main_drawer" class="drawer">
          <div class="drawer-toggle" data-drawer="amily2_drawer_content">
              <div id="amily2_drawer_icon" class="drawer-icon fa-solid fa-magic fa-fw closedIcon interactable" title="Amily2号优化助手" tabindex="0"></div>
          </div>
          <div id="amily2_drawer_content" class="drawer-content closedDrawer">
          </div>
      </div>
    `;
    $("#sys-settings-button").after(amily2DrawerHtml);

    const contentPanel = $("#amily2_drawer_content");
    await initializePanel(contentPanel);

    try {
        const { doNavbarIconClick } = await import('/script.js');
        if (typeof doNavbarIconClick === 'function') {
            $('#amily2_main_drawer .drawer-toggle').on('click', doNavbarIconClick);
            console.log('[Amily2-兼容性] 检测到新版环境，已绑定官方点击事件。');
        } else {
            throw new Error('doNavbarIconClick is not a function');
        }
    } catch (error) {
        $('#amily2_main_drawer .drawer-toggle').on('click', toggleDrawerFallback);
        console.log('[Amily2-兼容性] 检测到旧版环境 (无法导入 doNavbarIconClick)，已绑定后备点击事件。');
    }

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
              </div>
          </div>
      </div>
    `;

    const frame = $(amilyFrameHtml);
    $('#extensions_settings2').append(frame);
    const contentPanel = frame.find('.inline-drawer-content');
    initializePanel(contentPanel, frame);
  }
}
