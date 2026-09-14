import { getSlideToggleOptions, saveSettingsDebounced, eventSource, event_types } from '/script.js';
import { slideToggle } from '/lib.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from "/scripts/extensions.js";
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
import { applyTranslations, t } from '../utils/i18n/index.js';
import { showInitialLocaleChoice } from '../utils/i18n/onboarding.js';
import { mountHomeStatus } from './home-status.js';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
let disposeHomeStatus = () => {};

function bindHomeStatus(mainContainer) {
    disposeHomeStatus();
    const slot = document.createElement('div');
    slot.id = 'amily2_home_status';
    const diagnostics = mainContainer.querySelector('#amily2_diagnostics');
    const auth = mainContainer.querySelector('#auth_panel');
    const place = () => {
        const target = pluginAuthStatus.authorized ? diagnostics : auth;
        if (target && slot.parentElement !== target) target.appendChild(slot);
    };
    place();
    const controller = mountHomeStatus(slot, { getContext, eventSource, eventTypes: event_types });
    const refresh = () => {
        if (!slot.isConnected) return;
        place();
        controller.refresh();
    };
    const onOpen = event => {
        if (event.target?.closest?.('#amily2_drawer_icon, #amily2_extension_frame .inline-drawer-toggle, [id^="amily2_back_to_main"], #amily2_renderer_back_button, #amily2_sfigen_back_to_main')) refresh();
    };
    document.addEventListener('amily2-ui-updated', refresh);
    document.addEventListener('click', onOpen);
    disposeHomeStatus = () => {
        controller.dispose();
        slot.remove();
        document.removeEventListener('amily2-ui-updated', refresh);
        document.removeEventListener('click', onOpen);
    };
    if (!document.getElementById('amily2-home-status-style')) {
        const link = document.createElement('link');
        link.id = 'amily2-home-status-style';
        link.rel = 'stylesheet';
        link.href = new URL('./home-status.css?v=diagnostics-1', import.meta.url).href;
        document.head.appendChild(link);
    }
}


async function loadSettings() {
  const settings = extension_settings[extensionName] ??= {};
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (settings[key] === undefined) settings[key] = value;
  }


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
      toastr.info(t('models.loading'), t('app.toastTitle'));
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
        disposeHomeStatus();
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
        try {
            bindHomeStatus(mainContainer[0]);
        } catch (error) {
            disposeHomeStatus();
            console.warn('[Amily2] Home status panel unavailable:', error);
        }
        applyTranslations(mainContainer[0]);

        contentPanel.data("initialized", true);
        console.log("[Amily-重构] 模块注册式架构已就绪，已挂载模块:", registry.names().join(', '));
        applyUpdateIndicator();
        showInitialLocaleChoice(() => extension_settings[extensionName], {
            save: saveSettingsDebounced,
        });
    } catch (error) {
        disposeHomeStatus();
        console.error("[Amily-建设部] 紧急报告：加载模块化蓝图时发生意外:", error);
        const errorMessage = errorContainer
            ? `<p style="color:red; padding:10px; border:1px solid red; border-radius:5px;">${t('drawer.loadPanelError')}</p>`
            : `<p style="color:red; padding: 20px;">${t('drawer.loadContentError')}</p>`;

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
              <div id="amily2_drawer_icon" class="drawer-icon fa-solid fa-magic fa-fw closedIcon interactable" title="Amily2号优化助手" data-amily-i18n-title="app.name" tabindex="0"></div>
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
                  <b><i class="fas fa-crown" style="color: #ffc107;"></i> <span data-amily-i18n="app.extensionTitle">Amily2号 优化中枢</span></b>
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
    applyTranslations(frame[0]);
    await initializePanel(contentPanel, frame);
  }
}
