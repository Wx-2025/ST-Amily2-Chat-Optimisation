
import { createDrawer } from "./ui/drawer.js";
import { registerSlashCommands } from "./core/commands.js";
import { onMessageReceived, onChatChanged } from "./core/events.js";
import { eventSource, event_types } from '/script.js';


function loadPluginStyles() {
  const styleId = "amily2-styles";
  if (document.getElementById(styleId)) return; 

  const extensionName = "ST-Amily2-Chat-Optimisation";
  const stylePath = `scripts/extensions/third-party/${extensionName}/assets/style.css?v=${Date.now()}`; 

  const link = document.createElement("link");
  link.id = styleId;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = stylePath;
  document.head.appendChild(link);
}

window.addEventListener("error", (event) => {
  const stackTrace = event.error?.stack || "";

  if (stackTrace.includes("ST-Amily2-Chat-Optimisation")) {
    console.error("[Amily2-全局卫队] 捕获到严重错误:", event.error);
    toastr.error(
      `Amily2插件错误: ${event.error?.message || "未知错误"}`,
      "严重错误",
      { timeOut: 10000 },
    );
  }
});

window.addEventListener("error", (event) => {
  const stackTrace = event.error?.stack || "";

  if (stackTrace.includes("ST-Amily2-Chat-Optimisation")) {
    console.error("[Amily2-全局错误]", event.error);
    try {
      toastr.error(
        `Amily2插件错误: ${event.error?.message || "未知错误"}`,
        "严重错误",
        { timeOut: 10000 },
      );
    } catch (err) {

      console.error("无法显示错误提示", err);
    }
  }
});

jQuery(async () => {

  let attempts = 0;
  const maxAttempts = 100;
  const checkInterval = 100;
  const targetSelector = "#sys-settings-button";

  const deploymentInterval = setInterval(async () => {
    if ($(targetSelector).length > 0) {
      clearInterval(deploymentInterval);
      console.log(
        `[Amily2号] 目标邻居(${targetSelector})已定位，开始建造府邸...`
      );


      loadPluginStyles();


      await registerSlashCommands();

      createDrawer();

      if (!window.amily2EventsRegistered) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.IMPERSONATE_READY, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        window.amily2EventsRegistered = true;
      }

      console.log("【Amily2号】帝国秩序已建立。恭迎陛下检阅！");
    } else {
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(deploymentInterval);
        console.error(
          `[Amily2号] 部署失败：等待 ${targetSelector} 超时。帝国号角未能吹响。`
        );
        toastr.error("Amily2号UI部署失败。", "部署错误");
      }
    }
  }, checkInterval);
});