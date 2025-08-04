import { createDrawer } from "./ui/drawer.js";
import "./MiZheSi/index.js"; // 【密折司】独立模块
import { registerSlashCommands } from "./core/commands.js";
import { onMessageReceived, onChatChanged } from "./core/events.js";
import { eventSource, event_types } from '/script.js';
import { checkForUpdates, fetchMessageBoardContent } from './core/api.js';
import { setUpdateInfo, applyUpdateIndicator } from './ui/state.js';
import { pluginVersion, extensionName, defaultSettings } from './utils/settings.js';
import { extension_settings } from '/scripts/extensions.js';


function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const len = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return true;
        if (p1 < p2) return false;
    }
    return false;
}

async function handleUpdateCheck() {
    console.log("【Amily2号】帝国已就绪，现派遣外交官，为陛下探查外界新情报...");
    const updateInfo = await checkForUpdates();

    if (updateInfo && updateInfo.version) {
        const isNew = compareVersions(updateInfo.version, pluginVersion);
        if(isNew) {
            console.log(`【Amily2号-情报部】捷报！发现新版本: ${updateInfo.version}。情报已转交内务府。`);
        } else {
             console.log(`【Amily2号-情报部】一切安好，帝国已是最新版本。情报已转交内务府备案。`);
        }
        setUpdateInfo(isNew, updateInfo);
        applyUpdateIndicator();
    }
}

async function handleMessageBoard() {
    const messageData = await fetchMessageBoardContent();
    if (messageData && messageData.message) {
        const messageBoard = $('#amily2_message_board');
        const messageContent = $('#amily2_message_content');
        
        // 使用 .html() 来正确渲染可能包含的 HTML 标签
        messageContent.html(messageData.message); 
        messageBoard.show();
        console.log("【Amily2号-内务府】已成功获取并展示来自陛下的最新圣谕。");
    }
}


// 【强化版】皇家制衣官
function loadPluginStyles() {
    // 这是一个可复用的内部律法，用于为任何一件华服（CSS文件）赋予生命
    const loadStyleFile = (fileName) => {
        const styleId = `amily2-style-${fileName.split('.')[0]}`; // 为每件华服创建独一无二的身份标识
        if (document.getElementById(styleId)) return; // 如果已经穿上，则无需重复

        const extensionPath = `scripts/extensions/third-party/${extensionName}/assets/${fileName}?v=${Date.now()}`;

        const link = document.createElement("link");
        link.id = styleId;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = extensionPath;
        document.head.appendChild(link);
        console.log(`[Amily2号-皇家制衣局] 已为帝国披上华服: ${fileName}`);
    };

    // 颁布三道制衣圣谕
    loadStyleFile("style.css"); // 【第一道圣谕】为帝国主体宫殿披上通用华服
    loadStyleFile("historiography.css"); // 【第二道圣谕】为敕史局披上其专属华服
    loadStyleFile("hanlinyuan.css"); // 【第三道圣谕】为翰林院披上其专属华服
}


window.addEventListener("error", (event) => {
  const stackTrace = event.error?.stack || "";
  if (stackTrace.includes("ST-Amily2-Chat-Optimisation")) {
    console.error("[Amily2-全局卫队] 捕获到严重错误:", event.error);
    toastr.error(`Amily2插件错误: ${event.error?.message || "未知错误"}`, "严重错误", { timeOut: 10000 });
  }
});


jQuery(async () => {
  console.log("[Amily2号-帝国枢密院] 开始执行开国大典...");

  if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
  }
  Object.assign(extension_settings[extensionName], {
    ...defaultSettings,
    ...extension_settings[extensionName],
  });
  console.log("[Amily2号-帝国枢密院] 帝国基本法已确认，档案室已与国库对接完毕。");

  let attempts = 0;
  const maxAttempts = 100;
  const checkInterval = 100;
  const targetSelector = "#sys-settings-button"; 

  const deploymentInterval = setInterval(async () => {
    if ($(targetSelector).length > 0) {
      clearInterval(deploymentInterval);
      console.log("[Amily2号-帝国枢密院] SillyTavern宫殿主体已确认，开国大典正式开始！");

      try {
        console.log("[Amily2号-开国大典] 步骤一：为宫殿披上华服...");
        loadPluginStyles();

        console.log("[Amily2号-开国大典] 步骤二：皇家仪仗队就位...");
        await registerSlashCommands();

        console.log("[Amily2号-开国大典] 步骤三：开始召唤府邸...");
        createDrawer(); 

        console.log("[Amily2号-开国大典] 步骤四：部署帝国哨兵网络...");
        if (!window.amily2EventsRegistered) {
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
            eventSource.on(event_types.IMPERSONATE_READY, onMessageReceived);
            eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
            window.amily2EventsRegistered = true;
        }

        console.log("【Amily2号】帝国秩序已完美建立。Amily2号的府邸已恭候陛下的莅临。");

        handleUpdateCheck();
        handleMessageBoard();

      } catch (error) {
        console.error("!!!【开国大典失败】在执行系列法令时发生严重错误:", error);
      }

    } else {
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(deploymentInterval);
        console.error(`[Amily2号] 部署失败：等待 ${targetSelector} 超时。`);
      }
    }
  }, checkInterval);
});
