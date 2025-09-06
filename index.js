import { createDrawer } from "./ui/drawer.js";
import "./MiZheSi/index.js"; // 【密折司】独立模块
import "./PresetSettings/index.js"; // 【预设设置】独立模块
import "./PreOptimizationViewer/index.js"; // 【优化前文查看器】独立模块
import { registerSlashCommands } from "./core/commands.js";
import { onMessageReceived, handleTableUpdate } from "./core/events.js";
import { processPlotOptimization } from "./core/summarizer.js";
import { getContext } from "/scripts/extensions.js";
import { characters, this_chid } from '/script.js';
import { injectTableData } from "./core/table-system/injector.js"; 
import { initialize as initializeRagProcessor } from "./core/rag-processor.js"; 
import { loadTables, clearHighlights } from './core/table-system/manager.js';
import { renderTables } from './ui/table-bindings.js';
import { log } from './core/table-system/logger.js';
import { eventSource, event_types, saveSettingsDebounced } from '/script.js';
import { checkForUpdates, fetchMessageBoardContent } from './core/api.js';
import { setUpdateInfo, applyUpdateIndicator } from './ui/state.js';
import { pluginVersion, extensionName, defaultSettings } from './utils/settings.js';
import { tableSystemDefaultSettings } from './core/table-system/settings.js';
import { extension_settings } from '/scripts/extensions.js';
import { manageLorebookEntriesForChat } from './core/lore.js';
import { initializeCharacterWorldBook } from './CharacterWorldBook/cwb_index.js';
import { cwbDefaultSettings } from './CharacterWorldBook/src/cwb_config.js';
import './core/amily2-updater.js';

const STYLE_SETTINGS_KEY = 'amily2_custom_styles';
const STYLE_ROOT_SELECTOR = '#amily2_memorisation_forms_panel';
let styleRoot = null;

function getStyleRoot() {
    if (!styleRoot) {
        styleRoot = document.querySelector(STYLE_ROOT_SELECTOR);
    }
    return styleRoot;
}

function applyStyles(styleObject) {
    const root = getStyleRoot();
    if (!root || !styleObject) return;
    delete styleObject._comment;

    for (const [key, value] of Object.entries(styleObject)) {
        if (key.startsWith('--am2-')) {
            root.style.setProperty(key, value);
        }
    }
}

function loadAndApplyStyles() {
    const savedStyles = extension_settings[extensionName]?.[STYLE_SETTINGS_KEY];
    if (savedStyles && typeof savedStyles === 'object' && Object.keys(savedStyles).length > 0) {
        applyStyles(savedStyles);
    }
}

function saveStyles(styleObject) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName][STYLE_SETTINGS_KEY] = styleObject;
    saveSettingsDebounced();
}

function resetToDefaultStyles() {
    const root = getStyleRoot();
    if (!root) return;
    const savedStyles = extension_settings[extensionName]?.[STYLE_SETTINGS_KEY];
    if (savedStyles && typeof savedStyles === 'object') {
        for (const key of Object.keys(savedStyles)) {
            if (key.startsWith('--am2-')) {
                root.style.removeProperty(key);
            }
        }
    }
    saveStyles(null);
    toastr.success('已恢复默认界面样式。');
}

function getDefaultCssVars() {
    return {
        "--am2-font-size-base": "14px", "--am2-gap-main": "10px", "--am2-padding-main": "8px 5px",
        "--am2-container-bg": "rgba(0,0,0,0.1)", "--am2-container-border": "1px solid rgba(255, 255, 255, 0.2)",
        "--am2-container-border-radius": "12px", "--am2-container-padding": "10px", "--am2-container-shadow": "inset 0 0 15px rgba(0,0,0,0.2)",
        "--am2-title-font-size": "1.1em", "--am2-title-font-weight": "bold", "--am2-title-text-shadow": "0 0 5px rgba(200, 200, 255, 0.3)",
        "--am2-title-gradient-start": "#c0bde4", "--am2-title-gradient-end": "#dfdff0", "--am2-title-icon-color": "#9e8aff",
        "--am2-title-icon-margin": "10px", "--am2-table-bg": "rgba(0,0,0,0.2)", "--am2-table-border": "1px solid rgba(255, 255, 255, 0.25)",
        "--am2-table-cell-padding": "6px 8px", "--am2-table-cell-font-size": "0.95em", "--am2-header-bg": "rgba(255, 255, 255, 0.1)",
        "--am2-header-color": "#e0e0e0", "--am2-header-editable-bg": "rgba(172, 216, 255, 0.1)", "--am2-header-editable-focus-bg": "rgba(172, 216, 255, 0.25)",
        "--am2-header-editable-focus-outline": "1px solid #79b8ff", "--am2-cell-editable-bg": "rgba(255, 255, 172, 0.1)",
        "--am2-cell-editable-focus-bg": "rgba(255, 255, 172, 0.25)", "--am2-cell-editable-focus-outline": "1px solid #ffc107",
        "--am2-index-col-bg": "rgba(0, 0, 0, 0.3) !important", "--am2-index-col-color": "#aaa !important", "--am2-index-col-width": "40px",
        "--am2-index-col-padding": "10px 5px !important", "--am2-controls-gap": "5px", "--am2-controls-margin-bottom": "10px",
        "--am2-cell-highlight-bg": "rgba(144, 238, 144, 0.3)"
    };
}

function exportStyles() {
    const root = getStyleRoot();
    if (!root) { toastr.error('无法导出样式：找不到根元素。'); return; }
    const computedStyle = getComputedStyle(root);
    const stylesToExport = {};
    const defaultVars = getDefaultCssVars();
    for (const key of Object.keys(defaultVars)) {
        stylesToExport[key] = computedStyle.getPropertyValue(key).trim();
    }
    const blob = new Blob([JSON.stringify(stylesToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amily2-Theme-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toastr.success('主题文件已开始下载。', '导出成功');
}

function importStyles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';

    const cleanup = () => {
        if (document.body.contains(input)) {
            document.body.removeChild(input);
        }
    };

    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) {
            cleanup();
            return;
        }
        const reader = new FileReader();
        reader.onload = event => {
            try {
                const importedStyles = JSON.parse(event.target.result);
                if (typeof importedStyles !== 'object' || Array.isArray(importedStyles)) {
                    throw new Error('无效的JSON格式。');
                }
                applyStyles(importedStyles);
                saveStyles(importedStyles);
                toastr.success('主题已成功导入并应用！');
            } catch (error) {
                toastr.error(`导入失败：${error.message}`, '错误');
            } finally {
                cleanup();
            }
        };
        reader.readAsText(file);
    };

    document.body.appendChild(input);
    input.click();
}

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
        messageContent.html(messageData.message); 
        messageBoard.show();
        console.log("【Amily2号-内务府】已成功获取并展示来自陛下的最新圣谕。");
    }
}



function loadPluginStyles() {
    const loadStyleFile = (fileName) => {
        const styleId = `amily2-style-${fileName.split('.')[0]}`; 
        if (document.getElementById(styleId)) return; 

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
    loadStyleFile("table.css"); // 【第四道圣谕】为内存储司披上其专属华服
    loadStyleFile("optimization.css"); // 【第五道圣谕】为剧情优化披上其专属华服

    // 【第六道圣谕】为角色世界书披上其专属华服
    const cwbStyleId = 'cwb-feature-style';
    if (!document.getElementById(cwbStyleId)) {
        const cwbLink = document.createElement("link");
        cwbLink.id = cwbStyleId;
        cwbLink.rel = "stylesheet";
        cwbLink.type = "text/css";
        cwbLink.href = `scripts/extensions/third-party/${extensionName}/CharacterWorldBook/cwb_style.css?v=${Date.now()}`;
        document.head.appendChild(cwbLink);
        console.log(`[Amily2号-皇家制衣局] 已为角色世界书披上华服: cwb_style.css`);
    }
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
  const combinedDefaultSettings = { ...defaultSettings, ...tableSystemDefaultSettings, ...cwbDefaultSettings };
  Object.assign(extension_settings[extensionName], {
    ...combinedDefaultSettings,
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

        function waitForCwbPanelAndInitialize() {
            let attempts = 0;
            const maxAttempts = 50; 
            const interval = 100; 

            const checker = setInterval(async () => {
                const $cwbPanel = $('#amily2_character_world_book_panel');

                if ($cwbPanel.length > 0) {
                    clearInterval(checker);
                    try {
                        console.log("[Amily2号-开国大典] 步骤3.5：侦测到角色世界书停泊位，开始构建...");
                        await initializeCharacterWorldBook($cwbPanel);
                        console.log("[Amily2号-开国大典] 角色世界书已成功构建并融入帝国。");
                    } catch (error) {
                        console.error("!!!【角色世界书构建失败】:", error);
                    }
                } else {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        clearInterval(checker);
                        console.error("!!!【角色世界书构建失败】: 等待面板 #amily2_character_world_book_panel 超时。");
                    }
                }
            }, interval);
        }
        
        waitForCwbPanelAndInitialize();



        console.log("[Amily2号-开国大典] 步骤四：部署帝国哨兵网络...");

        let isProcessingPlotOptimization = false;

        async function onPlotGenerationAfterCommands(type, params, dryRun) {
            console.log("[Amily2-剧情优化] Generation after commands triggered", { type, params, dryRun, isProcessing: isProcessingPlotOptimization });

            if (type === 'regenerate' || isProcessingPlotOptimization || dryRun) {
                console.log("[Amily2-剧情优化] Skipping due to conditions:", { type, isProcessing: isProcessingPlotOptimization, dryRun });
                return;
            }
        
            const globalSettings = extension_settings[extensionName];
            if (globalSettings?.plotOpt_enabled === false) {
                return;
            }

            const isJqyhEnabled = globalSettings?.jqyhEnabled === true;
            const isMainApiConfigured = !!globalSettings?.apiUrl || !!globalSettings?.tavernProfile;

            if (!isJqyhEnabled && !isMainApiConfigured) {
                console.log("[Amily2-剧情优化] 优化已启用，但Jqyh API已禁用且主页API未配置。");
                return;
            }
        
            isProcessingPlotOptimization = true;
            let plotOptimizationToast = null;
            const cancellationState = { isCancelled: false };

            try {
                const userMessage = $('#send_textarea').val();
                if (!userMessage) {
                    isProcessingPlotOptimization = false;
                    return false; 
                }

                const toastMessage = `
                    <div>
                        正在进行剧情优化...
                        <button id="amily2-cancel-optimization-btn" class="menu_button danger_button" style="margin-left: 10px; padding: 2px 8px; font-size: 0.8em;">中止</button>
                    </div>
                `;
                
                let cancellationReject;
                const cancellationPromise = new Promise((_, reject) => {
                    cancellationReject = reject;
                });

                plotOptimizationToast = toastr.info(toastMessage, '剧情优化', {
                    timeOut: 0,
                    extendedTimeOut: 0,
                    tapToDismiss: false,
                    onclick: null,
                    escapeHtml: false,
                    onShown: function() {
                       $('#amily2-cancel-optimization-btn').one('click', function(event) {
                           event.stopPropagation();
                           
                           if (plotOptimizationToast) {
                               plotOptimizationToast.remove(); 
                               plotOptimizationToast = null;
                           }
                           
                           cancellationState.isCancelled = true;
                           cancellationReject(new Error("Optimization cancelled by user"));
                       });
                    }
                });

                const context = getContext();
                const contextTurnCount = globalSettings.plotOpt_contextLimit || 10;
                let slicedContext = [];
                if (contextTurnCount > 0) {
                    slicedContext = context.chat.slice(-contextTurnCount);
                }
                
                const optimizationPromise = processPlotOptimization({ mes: userMessage }, slicedContext, cancellationState);

                const result = await Promise.race([optimizationPromise, cancellationPromise]);

                if (result && result.contentToAppend) {
                    const currentUserInput = $('#send_textarea').val();
                    const finalMessage = currentUserInput + '\n' + result.contentToAppend;
                    $('#send_textarea').val(finalMessage).trigger('input');
                    toastr.success('剧情优化已完成并注入。', '操作成功');
                } else {
                    console.log("[Amily2-剧情优化] Plot optimization returned no result. Sending original message.");
                }
                
                return false;

            } catch (error) {
                if (error.message === "Optimization cancelled by user") {
                    console.log("[Amily2-剧情优化] 优化流程已被用户中止。发送原始消息。");
                    toastr.warning('剧情优化任务已中止...', '操作取消', { timeOut: 2000 });
                } else {
                    console.error(`[Amily2-剧情优化] 处理发送前事件时出错:`, error);
                    toastr.error('剧情优化处理失败。', '错误');
                }
                return false;
            } finally {
                isProcessingPlotOptimization = false;
                if (plotOptimizationToast) {
                    toastr.clear(plotOptimizationToast);
                    plotOptimizationToast = null;
                }
            }
        }
        if (!window.amily2EventsRegistered) {
            eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onPlotGenerationAfterCommands);
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
            eventSource.on(event_types.IMPERSONATE_READY, onMessageReceived);
            eventSource.on(event_types.MESSAGE_RECEIVED, (chat_id) => handleTableUpdate(chat_id));
            eventSource.on(event_types.MESSAGE_SWIPED, (chat_id) => {
                clearHighlights();
                handleTableUpdate(chat_id);
            });
            eventSource.on(event_types.MESSAGE_EDITED, (mes_id) => handleTableUpdate(mes_id));

            eventSource.on(event_types.CHAT_CHANGED, () => {
                manageLorebookEntriesForChat();
                setTimeout(() => {
                    log("【监察系统】检测到“朝代更迭”(CHAT_CHANGED)，开始重修史书并刷新宫殿...", 'info');
                    clearHighlights();
                    loadTables();
                    renderTables();
                }, 100);
            });

            eventSource.on(event_types.MESSAGE_DELETED, (message, index) => {
                log(`【监察系统】检测到消息 ${index} 被删除，开始精确回滚UI状态。`, 'warn');
                clearHighlights();
                loadTables(index);
                renderTables();
            });
            
            window.amily2EventsRegistered = true;
        }
        
        console.log("[Amily2号-开国大典] 步骤五：初始化RAG处理器...");

        try {
            initializeRagProcessor();
            console.log('[Amily2-翰林院] RAG处理器已成功初始化');
        } catch (error) {
            console.error('[Amily2-翰林院] RAG处理器初始化失败:', error);
        }
        
        console.log("[Amily2号-开国大典] 步骤六：智能冲突检测与注入策略...");

        async function executeAmily2Injection(...args) {
            console.log('[Amily2-核心引擎] 开始执行统一注入 (聊天长度:', args[0]?.length || 0, ')');

            try {
                injectTableData(...args);
            } catch (error) {
                console.error('[Amily2-内存储司] 表格注入失败:', error);
            }
            
            if (window.hanlinyuanRagProcessor && typeof window.hanlinyuanRagProcessor.rearrangeChat === 'function') {
                try {
                    console.log('[Amily2-核心引擎] 执行内置RAG注入。');
                    await window.hanlinyuanRagProcessor.rearrangeChat(...args);
                } catch (error) {
                    console.error('[Amily2-翰林院] RAG注入失败:', error);
                }
            }
        }

        console.log('[Amily2-策略] 采用“完全主导”策略，覆盖 `vectors_rearrangeChat`。');
        window['vectors_rearrangeChat'] = executeAmily2Injection;

        if (window['amily2HanlinyuanInjector']) {
            window['amily2HanlinyuanInjector'] = null;
        }

        console.log("【Amily2号】帝国秩序已完美建立。Amily2号的府邸已恭候陛下的莅临。");

        // 初始化版本检测功能
        console.log("[Amily2号-开国大典] 步骤七：初始化版本显示系统...");
        if (typeof window.amily2Updater !== 'undefined') {
            setTimeout(() => {
                console.log("[Amily2号-版本系统] 正在启动版本检测器...");
                window.amily2Updater.initialize();
            }, 2000);
        } else {
            console.warn("[Amily2号-版本系统] 版本检测器未找到，可能加载失败");
        }

        handleUpdateCheck();
        handleMessageBoard();

        setTimeout(() => {
            try {
                loadAndApplyStyles();
                
                const importThemeBtn = document.getElementById('amily2-import-theme-btn');
                const exportThemeBtn = document.getElementById('amily2-export-theme-btn');
                const resetThemeBtn = document.getElementById('amily2-reset-theme-btn');

                if (importThemeBtn) importThemeBtn.addEventListener('click', importStyles);
                if (exportThemeBtn) exportThemeBtn.addEventListener('click', exportStyles);
                if (resetThemeBtn) resetThemeBtn.addEventListener('click', resetToDefaultStyles);

                log('【凤凰阁】内联主题系统已通过延迟加载成功初始化并绑定事件。', 'success');
            } catch (error) {
                log(`【凤凰阁】内联主题系统初始化失败: ${error}`, 'error');
            }
        }, 500); 

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
