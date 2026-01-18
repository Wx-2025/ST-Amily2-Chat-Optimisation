import {
    createDrawer,
    showPlotOptimizationProgress, updatePlotOptimizationProgress, hidePlotOptimizationProgress,
    registerSlashCommands,
    onMessageReceived, handleTableUpdate,
    processPlotOptimization,
    getContext, extension_settings,
    characters, this_chid, eventSource, event_types, saveSettingsDebounced,
    injectTableData, generateTableContent,
    initializeRagProcessor,
    loadTables, clearHighlights, rollbackAndRefill, rollbackState, commitPendingDeletions, saveStateToMessage, getMemoryState, clearUpdatedTables,
    fillWithSecondaryApi,
    renderTables,
    log,
    checkForUpdates, fetchMessageBoardContent,
    setUpdateInfo, applyUpdateIndicator,
    pluginVersion, extensionName, defaultSettings,
    checkAuthorization, refreshUserInfo,
    tableSystemDefaultSettings,
    manageLorebookEntriesForChat,
    initializeCharacterWorldBook,
    cwbDefaultSettings,
    bindGlossaryEvents,
    updateOrInsertTableInChat, startContinuousRendering, stopContinuousRendering,
    initializeRenderer,
    initializeApiListener, registerApiHandler, amilyHelper, initializeAmilyHelper,
    registerContextOptimizerMacros, resetContextBuffer,
    initializeSuperMemory
} from './imports.js';
import { initializeAmilyBus } from './SL/bus/Amily2Bus.js';

const DOMPURIFY_CDN = "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.7/purify.min.js";

function loadExternalScript(url, globalName) {
    return new Promise((resolve, reject) => {
        if (window[globalName]) {
            resolve(window[globalName]);
            return;
        }
        const existingScript = document.querySelector(`script[src="${url}"]`);
        if (existingScript) {
            existingScript.addEventListener('load', () => resolve(window[globalName]));
            existingScript.addEventListener('error', reject);
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            console.log(`[Amily2-核心] 外部库加载成功: ${globalName}`);
            resolve(window[globalName]);
        };
        script.onerror = (err) => {
            console.error(`[Amily2-核心] 外部库加载失败: ${globalName}`, err);
            reject(err);
        };
        document.head.appendChild(script);
    });
}

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

function sanitizeHTML(html) {
    if (window.DOMPurify) {
        return window.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['b', 'i', 'u', 'em', 'strong', 'a', 'p', 'br', 'span', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'font', 'blockquote', 'code', 'pre', 'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
            ALLOWED_ATTR: ['href', 'target', 'style', 'class', 'color', 'size', 'src', 'alt', 'title', 'width', 'height', 'align'],
            FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'select', 'option'],
            FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout', 'onmousedown', 'onmouseup', 'ondblclick', 'onkeydown', 'onkeypress', 'onkeyup', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onreset', 'onselect', 'oncontextmenu'],
            ADD_ATTR: ['target'],
        });
    }
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    const allowedTags = ['b', 'i', 'u', 'em', 'strong', 'a', 'p', 'br', 'span', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'font'];
    const allowedAttrs = ['href', 'target', 'style', 'class', 'color', 'size'];

    const elements = tempDiv.querySelectorAll('*');
    const allElements = tempDiv.getElementsByTagName('*');
    for (let i = allElements.length - 1; i >= 0; i--) {
        const el = allElements[i];
        const tagName = el.tagName.toLowerCase();
        
        if (!allowedTags.includes(tagName)) {
            el.parentNode.removeChild(el);
            continue;
        }

        // 移除所有属性，只保留允许的
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
            const attrName = attr.name.toLowerCase();
            if (!allowedAttrs.includes(attrName)) {
                el.removeAttribute(attr.name);
            } else if (attrName === 'href') {
                // 检查 href 是否包含 javascript:
                if (attr.value.toLowerCase().trim().startsWith('javascript:')) {
                    el.removeAttribute('href');
                }
            } else if (attrName.startsWith('on')) { // 双重保险，移除所有事件处理器
                el.removeAttribute(attr.name);
            }
        }
    }
    return tempDiv.innerHTML;
}

async function handleMessageBoard() {
    const updateMessage = async () => {
        try {
            const messageData = await fetchMessageBoardContent();
            if (messageData && messageData.message) {
                const messageBoard = $('#amily2_message_board');
                const messageContent = $('#amily2_message_content');
                // 使用净化后的 HTML，防止 XSS 攻击
                const safeContent = sanitizeHTML(messageData.message);
                messageContent.html(safeContent); 
                messageBoard.show();
                console.log("【Amily2号-内务府】已成功获取并展示来自陛下的最新圣谕。");
            }
        } catch (error) {
            console.error("【Amily2号-内务府】获取留言板失败:", error);
        }
    };
    await updateMessage();
    setInterval(updateMessage, 300000); // 5分钟刷新一次（从60秒改为300秒）
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
    loadStyleFile("amily-hanlinyuan-system/hanlinyuan.css"); // 【第三道圣谕】为翰林院披上其专属华服
    loadStyleFile("amily-glossary-system/amily2-glossary.css"); // 【新圣谕】为术语表披上其专属华服
    loadStyleFile("amily-data-table/table.css"); // 【第四道圣谕】为内存储司披上其专属华服
    loadStyleFile("optimization.css"); // 【第五道圣谕】为剧情优化披上其专属华服
    loadStyleFile("renderer.css"); // 【新圣谕】为渲染器披上其专属华服
    // loadStyleFile("iframe-renderer.css"); // 【新圣谕】为iframe渲染内容披上其专属华服
    loadStyleFile("renderer.css"); // 【新圣谕】为iframe渲染内容披上其专属华服
    loadStyleFile("super-memory.css"); // 【新圣谕】为超级记忆披上其专属华服

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

    // 【第七道圣谕】为世界编辑器披上其专属华服
    const worldEditorStyleId = 'world-editor-style';
    if (!document.getElementById(worldEditorStyleId)) {
        const worldEditorLink = document.createElement("link");
        worldEditorLink.id = worldEditorStyleId;
        worldEditorLink.rel = "stylesheet";
        worldEditorLink.type = "text/css";
        worldEditorLink.href = `scripts/extensions/third-party/${extensionName}/WorldEditor/WorldEditor.css?v=${Date.now()}`;
        document.head.appendChild(worldEditorLink);
        console.log(`[Amily2号-皇家制衣局] 已为世界编辑器披上华服: WorldEditor.css`);
    }

}


window.addEventListener('message', function (event) {
    // 处理头像获取请求
    if (event.data && event.data.type === 'getAvatars') {
        // 【兼容性修复】如果 LittleWhiteBox 激活，则不处理此消息，避免冲突
        if (window.isXiaobaixEnabled) {
            return;
        }
        const userAvatar = `/characters/${getContext().userCharacter?.avatar ?? ''}`;
        const charAvatar = `/characters/${getContext().characters[this_chid]?.avatar ?? ''}`;
        event.source.postMessage({
            source: 'amily2-host',
            type: 'avatars',
            urls: { user: userAvatar, char: charAvatar }
        }, '*');
        return;
    }

    // 处理来自 iframe 的交互事件
    if (event.data && event.data.source === 'amily2-iframe') {
        const { action, detail } = event.data;
        console.log(`[Amily2-主窗口] 收到来自iframe的动作: ${action}`, detail);

        switch (action) {
            case 'sendMessage':
                if (detail && detail.message) {
                    $('#send_textarea').val(detail.message).trigger('input');
                    $('#send_but').trigger('click');
                    console.log(`[Amily2-主窗口] 已发送消息: ${detail.message}`);
                }
                break;

            case 'showToast':
                if (detail && detail.message && window.toastr) {
                    const toastType = detail.type || 'info';
                    if (typeof window.toastr[toastType] === 'function') {
                        window.toastr[toastType](detail.message, detail.title || '通知');
                    }
                }
                break;

            case 'buttonClick':
                console.log(`[Amily2-主窗口] 按钮被点击:`, detail);
                if (window.toastr) {
                    window.toastr.info(`按钮 "${detail.buttonId || '未知'}" 被点击`, 'iframe交互');
                }
                break;

            default:
                console.warn(`[Amily2-主窗口] 未知的动作类型: ${action}`);
        }
    }
});

window.addEventListener("error", (event) => {
  const stackTrace = event.error?.stack || "";
  if (stackTrace.includes("ST-Amily2-Chat-Optimisation")) {
    console.error("[Amily2-全局卫队] 捕获到严重错误:", event.error);
    toastr.error(`Amily2插件错误: ${event.error?.message || "未知错误"}`, "严重错误", { timeOut: 10000 });
  }
});


let isProcessingPlotOptimization = false;

/**
 * 加载必要的外部库（如 DOMPurify）。
 * 如果加载失败，会回退到内置的简单净化器。
 */
function loadExternalLibraries() {
    loadExternalScript(DOMPURIFY_CDN, 'DOMPurify').catch(e => console.warn("[Amily2] DOMPurify 加载失败，将使用内置净化器:", e));
}

/**
 * 初始化上下文优化器模块。
 * 优先注册宏，确保其在其他处理之前生效。
 */
function initializeContextOptimizer() {
    try {
        console.log("[Amily2号-开国大典] 步骤0：优先注册上下文优化器...");
        registerContextOptimizerMacros();
    } catch (e) {
        console.error("[Amily2号-开国大典] 上下文优化器注册失败:", e);
    }
}

/**
 * 异步初始化“密折司”模块。
 * 该模块通常用于处理机密或特殊的后台逻辑。
 */
async function initializeMiZheSi() {
    try {
        await import("./MiZheSi/index.js");
        console.log("[Amily2号-开国大典] 密折司模块已就位。");
    } catch (e) {
        console.error("[Amily2号-开国大典] 密折司加载失败:", e);
    }
}

/**
 * 注册所有与 SillyTavern 交互的 API 处理器。
 * 包括消息获取、设置、删除，以及 Lorebook 管理等功能。
 */
function registerAllApiHandlers() {
    initializeApiListener();

    registerApiHandler('getChatMessages', async (data) => amilyHelper.getChatMessages(data.range, data.options));
    registerApiHandler('setChatMessages', async (data) => amilyHelper.setChatMessages(data.messages, data.options));
    registerApiHandler('setChatMessage', async (data) => {
        const field_values = data.field_values || data.content;
        const message_id = data.message_id !== undefined ? data.message_id : data.index;
        const options = data.options || {};
        console.log('[Amily2-API] setChatMessage 收到参数:', { field_values, message_id, options, raw_data: data });
        return await amilyHelper.setChatMessage(field_values, message_id, options);
    });
    registerApiHandler('createChatMessages', async (data) => amilyHelper.createChatMessages(data.messages, data.options));
    registerApiHandler('deleteChatMessages', async (data) => amilyHelper.deleteChatMessages(data.ids, data.options));
    registerApiHandler('getLorebooks', async (data) => amilyHelper.getLorebooks());
    registerApiHandler('getCharLorebooks', async (data) => amilyHelper.getCharLorebooks(data.options));
    registerApiHandler('getLorebookEntries', async (data) => amilyHelper.getLorebookEntries(data.bookName));
    registerApiHandler('setLorebookEntries', async (data) => amilyHelper.setLorebookEntries(data.bookName, data.entries));
    registerApiHandler('createLorebookEntries', async (data) => amilyHelper.createLorebookEntries(data.bookName, data.entries));
    registerApiHandler('createLorebook', async (data) => amilyHelper.createLorebook(data.bookName));
    registerApiHandler('triggerSlash', async (data) => amilyHelper.triggerSlash(data.command));
    registerApiHandler('getLastMessageId', async (data) => amilyHelper.getLastMessageId());
    registerApiHandler('toastr', async (data) => {
        if (window.toastr && typeof window.toastr[data.type] === 'function') {
            window.toastr[data.type](data.message, data.title);
        }
        return true;
    });
    registerApiHandler('switchSwipe', async (data) => {
        const { messageIndex, swipeIndex } = data;
        const messages = await amilyHelper.getChatMessages(messageIndex, { include_swipes: true });
        if (messages && messages.length > 0 && messages[0].swipes) {
            const content = messages[0].swipes[swipeIndex];
            if (content !== undefined) {
                await amilyHelper.setChatMessages([{
                    message_id: messageIndex,
                    message: content
                }], { refresh: 'affected' });
                const context = getContext();
                if (context.chat[messageIndex]) {
                    context.chat[messageIndex].swipe_id = swipeIndex;
                }
                return { success: true, message: `已切换至开场白 ${swipeIndex}` };
            }
        }
        throw new Error(`无法切换到开场白 ${swipeIndex}`);
    });
}

/**
 * 合并插件的默认设置与用户设置。
 * 确保即使在升级后，新增加的设置项也有默认值。
 */
function mergePluginSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const combinedDefaultSettings = { ...defaultSettings, ...tableSystemDefaultSettings, ...cwbDefaultSettings, render_on_every_message: false, amily_render_enabled: false };
    for (const key in combinedDefaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = combinedDefaultSettings[key];
        }
    }
    console.log("[Amily2号-帝国枢密院] 帝国基本法已确认，档案室已与国库对接完毕。");
}

/**
 * 等待术语表面板加载完毕并绑定事件。
 * 包含重试机制，防止面板尚未渲染导致绑定失败。
 */
function waitForGlossaryPanelAndBindEvents() {
    let attempts = 0;
    const maxAttempts = 50;
    const interval = 100; 

    const checker = setInterval(() => {
        const glossaryPanel = document.getElementById('amily2_glossary_panel');

        if (glossaryPanel) {
            clearInterval(checker);
            try {
                console.log("[Amily2号-开国大典] 步骤3.6：侦测到术语表停泊位，开始绑定事件...");
                bindGlossaryEvents();
                console.log("[Amily2号-开国大典] 术语表事件已成功绑定。");
            } catch (error) {
                console.error("!!!【术语表事件绑定失败】:", error);
            }
        } else {
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(checker);
                console.error("!!!【术语表事件绑定失败】: 等待面板 #amily2_glossary_panel 超时。");
            }
        }
    }, interval);
}

/**
 * 等待角色世界书面板加载完毕并进行初始化。
 * 包含重试机制。
 */
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

/**
 * 注册用于表格内容的 SillyTavern 宏。
 * 允许在 Prompt 中使用 {{Amily2EditContent}} 来插入动态生成的表格数据。
 */
function registerTableMacros() {
    console.log("[Amily2号-开国大典] 步骤3.8：注册表格占位符宏...");
    try {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            resetContextBuffer();
            if (isProcessingPlotOptimization) {
                console.warn("[Amily2-剧情优化] 检测到生成开始，但优化标志位仍为 true。这可能是并发生成或状态未及时重置。");
            }
        });

        const context = getContext();
        if (context && typeof context.registerMacro === 'function') {
            context.registerMacro('Amily2EditContent', () => {
                const content = generateTableContent();
                if (content) {
                    window.AMILY2_MACRO_REPLACED = true;
                }
                return content;
            });
            console.log('[Amily2-核心引擎] 已成功注册表格占位符宏: {{Amily2EditContent}}');
        } else {
            console.warn('[Amily2-核心引擎] 无法注册表格宏，可能是 SillyTavern 版本不兼容。');
        }
    } catch (error) {
        console.error('[Amily2-核心引擎] 注册表格宏时发生错误:', error);
    }
}

/**
 * 处理用户发送消息前的逻辑（剧情优化）。
 * 拦截消息发送，进行剧情梳理和总结，然后注入到 Prompt 中。
 * 
 * @param {string} type - 触发类型 (例如 'send')
 * @param {object} params - 参数对象
 * @param {boolean} dryRun - 是否为试运行
 * @returns {Promise<boolean>} - 返回 false 以阻止默认行为（如果已异步处理），或不做阻拦。
 */
async function onPlotGenerationAfterCommands(type, params, dryRun) {
    clearUpdatedTables();
    if (isProcessingPlotOptimization) {
        console.log("[Amily2-剧情优化] 优化正在进行中，拦截重复触发。");
        return;
    }
    console.log("[Amily2-剧情优化] Generation after commands triggered", { type, params, dryRun });
    if (type === 'regenerate' || dryRun) {
        console.log("[Amily2-剧情优化] Skipping due to regenerate or dryRun.");
        return false;
    }
    const globalSettings = extension_settings[extensionName];
    if (globalSettings?.plotOpt_enabled === false) return false;

    const isJqyhEnabled = globalSettings?.jqyhEnabled === true;
    const isMainApiConfigured = !!globalSettings?.apiUrl || !!globalSettings?.tavernProfile;

    if (!isJqyhEnabled && !isMainApiConfigured) {
        console.log("[Amily2-剧情优化] 优化已启用，但Jqyh API已禁用且主页API未配置。");
        return false;
    }

    let userMessage = $('#send_textarea').val();
    let isFromTextarea = true;
    const context = getContext();
    if (!userMessage) {
        if (context.chat && context.chat.length > 0) {
            const lastMsg = context.chat[context.chat.length - 1];
            if (lastMsg.is_user) {
                userMessage = lastMsg.mes;
                isFromTextarea = false;
                console.log("[Amily2-剧情优化] Detected empty textarea, processing last user message.");
            }
        }
    }
    if (!userMessage) return false;

    isProcessingPlotOptimization = true;
    const cancellationState = { isCancelled: false };
    showPlotOptimizationProgress(cancellationState);

    const onProgress = (message, isDone = false, isSkipped = false) => {
        updatePlotOptimizationProgress(message, isDone, isSkipped);
    };

    try {
        const cancellationPromise = new Promise((_, reject) => {
            const checkCancel = setInterval(() => {
                if (cancellationState.isCancelled) {
                    clearInterval(checkCancel);
                    reject(new Error("Optimization cancelled by user"));
                }
            }, 100);
        });

        const contextTurnCount = globalSettings.plotOpt_contextLimit || 10;
        const contextSource = isFromTextarea ? context.chat : context.chat.slice(0, -1);
        const slicedContext = contextTurnCount > 0 ? contextSource.slice(-contextTurnCount) : contextSource;

        const optimizationPromise = processPlotOptimization({ mes: userMessage }, slicedContext, cancellationState, onProgress);
        const result = await Promise.race([optimizationPromise, cancellationPromise]);

        if (cancellationState.isCancelled) throw new Error("Optimization cancelled by user");

        if (result && result.contentToAppend) {
            const finalMessage = userMessage + '\n' + result.contentToAppend;
            if (params && typeof params === 'object') {
                try {
                    if (params.prompt) params.prompt = finalMessage;
                    if (Array.isArray(params.messages)) {
                        const lastMsg = params.messages[params.messages.length - 1];
                        if (lastMsg && lastMsg.role === 'user') {
                            lastMsg.content = finalMessage;
                        }
                    }
                } catch (e) {
                    console.warn("[Amily2-剧情优化] 尝试修改 params 失败:", e);
                }
            }
            if (isFromTextarea) {
                $('#send_textarea').val(finalMessage).trigger('input');
            } else {
                const targetMessageId = context.chat.length - 1;
                await amilyHelper.setChatMessage(finalMessage, targetMessageId, { refresh: 'none' });
            }
            toastr.success('剧情优化已完成并注入，继续生成...', '操作成功');
            isProcessingPlotOptimization = false;
            hidePlotOptimizationProgress();
            return false;
        } else {
            console.log("[Amily2-剧情优化] Plot optimization returned no result. Sending original message.");
            isProcessingPlotOptimization = false;
            hidePlotOptimizationProgress();
            return false;
        }

    } catch (error) {
        if (cancellationState.isCancelled || error.message === "Optimization cancelled by user") {
            console.log("[Amily2-剧情优化] 优化流程已被用户中止。发送原始消息。");
            toastr.warning('记忆管理任务已中止。', '操作取消', { timeOut: 2000 });
        } else {
            console.error(`[Amily2-剧情优化] 处理发送前事件时出错:`, error);
            toastr.error('记忆管理处理失败，将发送原始消息。', '错误');
        }
        isProcessingPlotOptimization = false;
        hidePlotOptimizationProgress();
        return false;
    }
}

/**
 * 注册核心事件监听器。
 * 包含对消息接收、编辑、删除、滑动等事件的处理，以及剧情优化的触发。
 */
function registerEventListeners() {
    console.log("[Amily2号-开国大典] 步骤四：部署帝国哨兵网络...");
    if (!window.amily2EventsRegistered) {
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onPlotGenerationAfterCommands);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.IMPERSONATE_READY, onMessageReceived);
        eventSource.on(event_types.MESSAGE_RECEIVED, (chat_id) => handleTableUpdate(chat_id));
        eventSource.on(event_types.MESSAGE_SWIPED, async (chat_id) => {
            const context = getContext();
            if (context.chat.length < 2) {
                log('【监察系统】检测到消息滑动，但聊天记录不足，已跳过状态回退。', 'info');
                return;
            }
            log('【监察系统】检测到消息滑动 (SWIPED)，开始执行状态回退...', 'warn');
            rollbackState();
            const latestMessage = context.chat[chat_id] || context.chat[context.chat.length - 1];
            if (latestMessage.is_user) {
                log('【监察系统】滑动后最新消息是用户，跳过填表。', 'info');
                renderTables();
                return;
            }
            const settings = extension_settings[extensionName];
            const fillingMode = settings.filling_mode || 'main-api';
            if (fillingMode === 'main-api') {
                log(`【监察系统】主填表模式，回退后强制刷新消息ID: ${chat_id}。`, 'info');
                await handleTableUpdate(chat_id, true);
            } else if (fillingMode === 'secondary-api' || fillingMode === 'optimized') {
                log('【监察系统】分步/优化模式，回退后强制二次填表最新消息。', 'info');
                await fillWithSecondaryApi(latestMessage, true);
            } else {
                log('【监察系统】未配置填表模式，跳过填表。', 'info');
            }
            renderTables();
            log('【监察系统】滑动后填表完成，UI 已刷新。', 'success');
        });
        eventSource.on(event_types.MESSAGE_EDITED, (mes_id) => {
            handleTableUpdate(mes_id);
            updateOrInsertTableInChat();
        });
        eventSource.on(event_types.CHAT_CHANGED, () => {
            window.lastPreOptimizationResult = null;
            document.dispatchEvent(new CustomEvent('preOptimizationTextUpdated'));
            manageLorebookEntriesForChat();
            setTimeout(() => {
                log("【监察系统】检测到“朝代更迭”(CHAT_CHANGED)，开始重修史书并刷新宫殿...", 'info');
                clearHighlights();
                clearUpdatedTables();
                loadTables();
                renderTables();
                if (extension_settings[extensionName].render_on_every_message) {
                    startContinuousRendering();
                } else {
                    stopContinuousRendering();
                }
            }, 100);
        });
        eventSource.on(event_types.MESSAGE_DELETED, (message, index) => {
            log(`【监察系统】检测到消息 ${index} 被删除，开始精确回滚UI状态。`, 'warn');
            clearHighlights();
            loadTables(index);
            renderTables();
        });
        eventSource.on(event_types.MESSAGE_RECEIVED, updateOrInsertTableInChat);
        eventSource.on(event_types.chat_updated, updateOrInsertTableInChat);

        window.amily2EventsRegistered = true;
    }
}

/**
 * 执行 Amily2 的统一注入逻辑。
 * 同时兼容表格数据注入和 RAG 上下文重排。
 * @param {...any} args - 传递给 injectTableData 和 rearrangeChat 的参数
 */
async function executeAmily2Injection(...args) {
    console.log('[Amily2-核心引擎] 开始执行统一注入 (聊天长度:', args[0]?.length || 0, ')');
    try {
        await injectTableData(...args);
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

/**
 * 初始化 RAG 处理器并设置注入策略。
 * 覆盖 `vectors_rearrangeChat` 以确保 Amily2 的注入逻辑优先执行。
 */
function initializeRagAndInjection() {
    console.log("[Amily2号-开国大典] 步骤五：初始化RAG处理器...");
    try {
        initializeRagProcessor();
        console.log('[Amily2-翰林院] RAG处理器已成功初始化');
    } catch (error) {
        console.error('[Amily2-翰林院] RAG处理器初始化失败:', error);
    }

    console.log("[Amily2号-开国大典] 步骤六：智能冲突检测与注入策略...");
    console.log('[Amily2-策略] 采用“完全主导”策略，覆盖 `vectors_rearrangeChat`。');
    window['vectors_rearrangeChat'] = executeAmily2Injection;
    if (window['amily2HanlinyuanInjector']) {
        window['amily2HanlinyuanInjector'] = null;
    }
}

/**
 * 执行部署完成后的后续任务。
 * 包括：版本检查、在线人数统计、本地联动、超级记忆初始化、渲染器启动和主题应用。
 */
function performPostDeploymentTasks() {
    console.log("【Amily2号】帝国秩序已完美建立。Amily2号的府邸已恭候陛下的莅临。");
    if (checkAuthorization()) {
        const userType = localStorage.getItem("plugin_user_type") || "未知";
        const userNote = localStorage.getItem("plugin_user_note");
        const displayNote = userNote || userType;
        toastr.success(`欢迎回来！授权状态有效 (用户: ${displayNote})`, "Amily2 插件已就绪");
        refreshUserInfo().then(data => {
            if (data && data.note && data.note !== userNote) {
                console.log("[Amily2] 用户信息已更新:", data.note);
            }
        }).catch(e => console.warn("[Amily2] 后台刷新用户信息失败:", e));
    }

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
    initializeOnlineTracker();
    initializeLocalLinkage();

    setTimeout(() => initializeSuperMemory(), 3000);

    initializeRenderer(); 

    if (extension_settings[extensionName].render_on_every_message) {
        startContinuousRendering();
    }

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
}

/**
 * Amily2 核心部署流程（开国大典）。
 * 只有当 SillyTavern 基础 UI 加载完成后才会执行此函数。
 * 负责按顺序初始化插件的各个子系统。
 */
async function runAmily2Deployment() {
    console.log("[Amily2号-帝国枢密院] SillyTavern宫殿主体已确认，开国大典正式开始！");
    try {
        console.log("[Amily2号-开国大典] 步骤一：为宫殿披上华服...");
        loadPluginStyles();

        console.log("[Amily2号-开国大典] 步骤二：皇家仪仗队就位...");
        await registerSlashCommands();

        console.log("[Amily2号-开国大典] 步骤三：开始召唤府邸...");
        createDrawer();

        waitForGlossaryPanelAndBindEvents();
        waitForCwbPanelAndInitialize();
        registerTableMacros();

        registerEventListeners();
        initializeRagAndInjection();
        performPostDeploymentTasks();

    } catch (error) {
        console.error("!!!【开国大典失败】在执行系列法令时发生严重错误:", error);
    }
}

jQuery(async () => {
    console.log("[Amily2号-帝国枢密院] 开始执行开国大典...");

    initializeAmilyBus();
    loadExternalLibraries();
    initializeContextOptimizer();
    await initializeMiZheSi();

    registerAllApiHandlers();
    initializeAmilyHelper();
    mergePluginSettings();

    let attempts = 0;
    const maxAttempts = 100;
    const checkInterval = 100;
    const targetSelector = "#sys-settings-button"; 

    const deploymentInterval = setInterval(async () => {
        if ($(targetSelector).length > 0) {
            clearInterval(deploymentInterval);
            await runAmily2Deployment();
        } else {
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(deploymentInterval);
                console.error(`[Amily2号] 部署失败：等待 ${targetSelector} 超时。`);
            }
        }
    }, checkInterval);
});

function applyMessageLimit() {
    const limit = window.amily2MaxMessages;
    if (!limit) return;

    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    const messages = Array.from(chatContainer.getElementsByClassName('mes'));
    const total = messages.length;
    
    if (total <= limit) {
        // 如果消息数未超标，确保所有消息可见
        messages.forEach(el => el.style.display = '');
        return;
    }

    // 隐藏旧消息，保留最后 limit 条
    const hideCount = total - limit;
    for (let i = 0; i < total; i++) {
        if (i < hideCount) {
            messages[i].style.setProperty('display', 'none', 'important');
        } else {
            messages[i].style.removeProperty('display');
        }
    }
    console.log(`[Amily2-性能优化] 已隐藏 ${hideCount} 条旧消息，仅显示最近 ${limit} 条。`);
}

// 监听聊天更新事件以应用限制
eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(applyMessageLimit, 100));
eventSource.on(event_types.chat_updated, () => setTimeout(applyMessageLimit, 100));

function initializeOnlineTracker() {
    const wsUrl = 'wss://amilyservice.amily49.cc';
    
    let ws = null;
    let reconnectTimer = null;
    let isConnecting = false;
    
    function mountTracker() {
        const $drawerContent = $('#amily2_drawer_content');
        if ($drawerContent.length === 0 || !$drawerContent.data('initialized')) {
            setTimeout(mountTracker, 1000); 
            return;
        }
        if ($('#amily2-online-tracker').length > 0) return;
        const $container = $('<div id="amily2-online-tracker" style="text-align: center; padding: 8px; font-size: 13px; color: rgba(255,255,255,0.7); border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 10px; background: rgba(0,0,0,0.1); border-radius: 5px;"></div>');
        $container.html('<i class="fas fa-users" style="color: #4caf50; font-size: 12px; vertical-align: middle; margin-right: 6px;"></i><span id="amily2-online-count" style="vertical-align: middle; font-weight: bold;">Connecting...</span>');

        $drawerContent.prepend($container);
        
        connect();
    }

    function connect() {
        // 单例模式检查：如果已有连接且处于连接中或打开状态，则不重复创建
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            console.log('[Amily2-在线统计] 连接已存在，跳过创建');
            return;
        }

        // 防止短时间内重复调用
        if (isConnecting) return;
        isConnecting = true;

        // 清理旧连接
        if (ws) {
            try {
                ws.close();
            } catch (e) {}
            ws = null;
        }

        try {
            console.log('[Amily2-在线统计] 开始建立连接...');
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('[Amily2-在线统计] 已连接到服务器');
                isConnecting = false;
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'online_count') {
                        $('#amily2-online-count').text(`${data.count} 人在线`);
                    }
                } catch (e) {
                    console.error('[Amily2-在线统计] 解析消息失败:', e);
                }
            };

            ws.onclose = () => {
                console.log('[Amily2-在线统计] 连接断开');
                $('#amily2-online-count').text('离线');
                isConnecting = false;
                ws = null;
                
                // 延迟重连，而不是立即循环
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connect();
                    }, 5000);
                }
            };
            
            ws.onerror = (err) => {
                console.warn('[Amily2-在线统计] 连接错误:', err);
                // onerror 通常会触发 onclose，所以这里不需要额外的重连逻辑，交给 onclose 处理
            };
        } catch (e) {
            console.error('[Amily2-在线统计] 初始化失败:', e);
            isConnecting = false;
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    connect();
                }, 5000);
            }
        }
    }

    // 启动挂载流程
    mountTracker();
}

function initializeLocalLinkage() {
    const wsUrl = 'ws://127.0.0.1:2086';
    let ws = null;
    let retryCount = 0;
    const maxRetries = 5;

    function connect() {
        if (retryCount >= maxRetries) {
            console.log('[Amily2-本地联动] 达到最大重试次数，停止连接本地服务。');
            return;
        }

        console.log('[Amily2-本地联动] 尝试连接本地联动服务...');
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('[Amily2-本地联动] 已连接到启动器服务');
            if (window.toastr) toastr.success('已连接到 Amily 启动器', '本地联动');
            retryCount = 0; // 连接成功，重置计数
        };

        ws.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'command') {
                    console.log('[Amily2-本地联动] 收到指令:', data.command, data.args);
                    if (data.command === 'triggerSlash') {
                        if (window.AmilyHelper) {
                            await window.AmilyHelper.triggerSlash(data.args.content);
                        }
                    } else if (data.command === 'cleanOldMessages') {
                        const keep = parseInt(data.args.keep) || 50;
                        if (window.AmilyHelper) {
                            const total = window.AmilyHelper.getLastMessageId() + 1;
                            if (total > keep) {
                                const deleteCount = total - keep;
                                // 生成要删除的 ID 列表 (0 到 deleteCount - 1)
                                const idsToDelete = Array.from({length: deleteCount}, (_, i) => i);
                                await window.AmilyHelper.deleteChatMessages(idsToDelete, { refresh: 'all' });
                                if (window.toastr) window.toastr.success(`已清理 ${deleteCount} 条旧消息，保留最近 ${keep} 条`, '清理完成');
                            } else {
                                if (window.toastr) window.toastr.info('消息数量未超过保留限制，无需清理', '无需清理');
                            }
                        }
                    } else if (data.command === 'setMaxMessages') {
                        const limit = parseInt(data.args.limit);
                        if (!isNaN(limit) && limit > 0) {
                            window.amily2MaxMessages = limit;
                            applyMessageLimit();
                            if (window.toastr) window.toastr.success(`已限制显示最近 ${limit} 条消息`, '性能优化');
                        }
                    }
                    // 这里可以扩展更多指令
                }
            } catch (e) {
                console.error('[Amily2-本地联动] 处理消息失败:', e);
            }
        };

        ws.onclose = () => {
            console.log('[Amily2-本地联动] 连接断开');
            retryCount++;
            if (retryCount < maxRetries) {
                console.log(`[Amily2-本地联动] ${5}秒后尝试重连 (${retryCount}/${maxRetries})`);
                setTimeout(connect, 5000);
            } else {
                console.log('[Amily2-本地联动] 已停止重连尝试。');
            }
        };

        ws.onerror = (err) => {
            // console.warn('[Amily2-本地联动] 连接错误:', err);
        };
    }

    connect();
}
