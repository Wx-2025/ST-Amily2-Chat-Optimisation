
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
if ($("#amily2_main_drawer").length > 0) return;

const amily2DrawerHtml = `
      <div id="amily2_main_drawer" class="drawer">
          <div id="amily2_drawer_icon" class="drawer-toggle drawer-header closedIcon interactable" title="Amily2号优化助手" tabindex="0">
              <i class="drawer-icon fa-solid fa-magic fa-fw"></i>
          </div>
          <div id="amily2_drawer_content" class="drawer-content closedDrawer" style="display: none;">
              <!-- 王座将在此处动态加载 -->
          </div>
      </div>
  `;
  $("#sys-settings-button").after(amily2DrawerHtml);


$(document).on(
  "mousedown",
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
        const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
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
