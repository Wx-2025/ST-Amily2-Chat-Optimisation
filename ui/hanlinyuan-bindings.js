/**
 * =====================================================================
 * =========== 【翰林院】中枢机要室 - 负责政令传达 v4.0 ===========
 * ===========        Amily 奉旨重铸，确保政令畅通       =============
 * =====================================================================
 */

import { getContext } from '/scripts/extensions.js';
// 废除 extension_prompt_types，我们直接使用正确的数字值
import * as HanlinyuanCore from '../core/rag-processor.js';
import * as Historiographer from '../core/historiographer.js';
import * as ContextUtils from '../core/utils/context-utils.js';
import * as IngestionManager from '../core/ingestion-manager.js'; // 【新增】导入任务总管
import { showContentModal, showHtmlModal } from './page-window.js';
import { extractBlocksByTags, applyExclusionRules } from '../core/utils/rag-tag-extractor.js';

'use strict';

// 将UI交互函数暴露到全局，供HTML的onclick调用
function setupGlobalEventHandlers() {
    // 【重构】手动保存和重置现在由新的事件绑定器处理，但保留全局函数以防万一
    window.saveHLYSettings = () => saveSettingsFromUI(false); // false表示非自动保存
    window.resetHLYSettings = resetSettingsToUI;
    window.testHLYApi = testApi;
    window.fetchHLYEmbeddingModels = fetchHLYEmbeddingModels;
    window.fetchHLYRerankModels = fetchHLYRerankModels; // 新增
    window.updateHLYMemoryCount = updatePanelStatus;
    window.purgeHLYStorage = purgeStorage;
    window.startHLYCondensation = startCondensation;
    window.previewHLYCondensation = previewCondensation;
    window.ingestHLYManualText = ingestManualText;
    window.hlyLog = log;
    window.showHLYStats = showStats;
    // 【新增】书库编纂相关
    window.startHLYHistoriography = startHistoriography;
}

/**
 * 【全新】核心函数：更新单个设置项，保存并记录日志
 * @param {string} key - 设置键，例如 'retrieval.enabled'
 * @param {*} value - 新的设置值
 */
function updateAndSaveSetting(key, value) {
    const settings = HanlinyuanCore.getSettings();
    if (!settings) return;

    // 使用 lodash-like set a value in a nested object
    const keys = key.split('.');
    let current = settings;
    for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]] = current[keys[i]] || {};
    }
    current[keys[keys.length - 1]] = value;

    HanlinyuanCore.saveSettings();
    log(`[自动保存] 设置项 '${key}' 已更新为: ${JSON.stringify(value)}`, 'success');
}

/**
 * 【全新】绑定所有带 data-setting-key 属性的控件的自动保存事件
 */
function bindAutoSaveEvents() {
    const container = document.getElementById('hly-modal-container');
    if (!container) return;

    container.addEventListener('change', (event) => {
        const target = event.target;
        const key = target.dataset.settingKey;
        if (!key) return;

        let value;
        const type = target.dataset.type || 'string';

        if (target.type === 'checkbox') {
            value = target.checked;
        } else if (target.type === 'radio') {
            if (target.checked) {
                const radioGroup = container.querySelectorAll(`input[name="${target.name}"]`);
                const checkedRadio = Array.from(radioGroup).find(r => r.checked);
                value = checkedRadio.value;
            } else {
                return; // 如果不是选中的那个radio，则不处理
            }
        } else {
            value = target.value;
        }

        // 类型转换
        switch (type) {
            case 'integer':
                value = parseInt(value, 10);
                break;
            case 'float':
                value = parseFloat(value);
                break;
            case 'boolean':
                // Checkbox value is already a boolean
                if (typeof value !== 'boolean') {
                    value = value === 'true';
                }
                break;
        }
        
        // 对于radio按钮，我们需要确保只处理一次
        if (target.type === 'radio' && !target.checked) return;

        updateAndSaveSetting(key, value);
    });
}


/**
 * 主初始化函数
 */
export function bindHanlinyuanEvents() {
    const context = getContext();
    if (!context) {
        console.error('[翰林院-枢纽] 未能获取SillyTavern上下文，绑定失败。');
        return;
    }

    setupGlobalEventHandlers();
    bindPanelToggleEvents();
    bindInternalUIEvents();
    bindTutorialEvents(); // 【新增】绑定教程按钮事件
    bindAutoSaveEvents(); // 【新增】激活自动保存机制
    bindSessionLockEvent(); // 【新增】绑定会话锁定事件

    // 确保核心已经初始化
    if (HanlinyuanCore.initialize) {
        HanlinyuanCore.initialize();
    } else {
        console.error('[翰林院-枢纽] 核心法典未能提供初始化圣旨！');
        return;
    }
    
    loadSettingsToUI();
    loadWorldbookList(); // 【新增】加载书库列表
    log('[翰林院-枢纽] 已成功连接各部，政令畅通。', 'info');

    // 【新增】为“整本录入”按钮绑定事件 (V2 - 带进度条和中止功能)
    // const startNovelIngestionBtn_old = document.getElementById('hanlin_start_novel_ingestion');
    // if (startNovelIngestionBtn_old) { ... } // 旧逻辑已被完全替换

    const fileInput = document.getElementById('hanlinyuan-ingest-novel-file-input');
    const fileNameSpan = document.getElementById('hanlinyuan-ingest-novel-file-name');
    const startBtn = document.getElementById('hanlinyuan-ingest-novel-start');
    const abortBtn = document.getElementById('hanlinyuan-ingest-abort');
    const progressContainer = document.getElementById('hanlinyuan-ingest-progress-container');
    const progressBar = document.getElementById('hanlinyuan-ingest-progress-bar');
    const statusText = document.getElementById('hanlinyuan-ingest-status');
    const controlsContainer = document.getElementById('hanlinyuan-ingest-novel-controls');

    let selectedFile = null;
    let abortController = null;

    fileInput.addEventListener('change', (event) => {
        selectedFile = event.target.files[0];
        if (selectedFile) {
            fileNameSpan.textContent = selectedFile.name;
            fileNameSpan.title = selectedFile.name;
        } else {
            fileNameSpan.textContent = '未选择文件';
        }
    });

    startBtn.addEventListener('click', async () => {
        if (!selectedFile) {
            toastr.warning('请先选择一个 .txt 文件');
            return;
        }

        let resumeFromIndex = 0;
        const jobId = IngestionManager.generateJobId(selectedFile);
        const savedState = IngestionManager.loadProgress(jobId);

        if (savedState) {
            const progressPercentage = ((savedState.processedChunks / savedState.totalChunks) * 100).toFixed(1);
            const userChoice = confirm(`启禀大人，发现此书上次录入已完成 ${progressPercentage}%。是否从上次中断之处继续？`);

            if (userChoice) {
                resumeFromIndex = savedState.processedChunks;
                toastr.info(`遵命，将从第 ${resumeFromIndex + 1} 块继续录入。`, '圣旨已达');
                log(`[断点续传] 用户选择继续任务 ${jobId}，从第 ${resumeFromIndex} 块开始。`, 'info');
            } else {
                IngestionManager.clearJob(jobId);
                toastr.info('遵命，将从头开始录入此书。', '圣旨已达');
                log(`[断点续传] 用户选择放弃旧任务 ${jobId}，重新开始。`, 'warn');
            }
        }

        abortController = new AbortController();
        const signal = abortController.signal;

        controlsContainer.style.display = 'none';
        progressContainer.style.display = 'block';
        statusText.textContent = '正在读取文件...';
        progressBar.value = 0;

        try {
            const text = await selectedFile.text();
            
            const progressCallback = (progress) => {
                statusText.textContent = `处理中: ${progress.message} (${progress.processed}/${progress.total})`;
                progressBar.value = (progress.processed / progress.total) * 100;
            };

            const batchCompleteCallback = () => {
                updatePanelStatus();
                log('[实时刷新] 批次完成，忆识总数已更新。', 'info');
            };

            const result = await HanlinyuanCore.ingestTextToHanlinyuan(
                text, 
                'novel', 
                selectedFile.name,
                progressCallback,
                signal,
                log,
                batchCompleteCallback,
                jobId,
                resumeFromIndex
            );

            if (result.success) {
                toastr.success(`成功录入 ${result.count} 个知识块`);
                statusText.textContent = `任务完成！成功录入 ${result.count} 个知识块。`;
                progressBar.value = 100;
                updatePanelStatus();
            } else {
                throw new Error(result.error || '未知错误');
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                toastr.info('任务已由用户中止。进度已保存，可随时继续。');
                statusText.textContent = '任务已中止。';
            } else {
                toastr.error(`录入失败: ${error.message}。进度已保存，可稍后重试。`);
                statusText.textContent = `错误: ${error.message}`;
            }
        } finally {
            setTimeout(() => {
                controlsContainer.style.display = 'flex';
                progressContainer.style.display = 'none';
                fileInput.value = '';
                selectedFile = null;
                fileNameSpan.textContent = '未选择文件';
            }, 3000);
        }
    });

    abortBtn.addEventListener('click', () => {
        if (abortController) {
            abortController.abort();
        }
    });
}

/**
 * 【新增】为会话锁定按钮绑定事件和逻辑
 */
function bindSessionLockEvent() {
    const lockButton = document.getElementById('hly-session-lock-btn');
    if (!lockButton) return;

    lockButton.addEventListener('click', () => {
        const isNowLocked = HanlinyuanCore.toggleSessionLock();
        updateSessionLockUI(isNowLocked);
        
        if (isNowLocked) {
            const lockedInfo = HanlinyuanCore.getLockedSessionInfo();
            toastr.success(`会话已锁定到: ${lockedInfo.id}`, '圣旨已下');
            log(`会话已锁定到宝库: ${lockedInfo.id}`, 'success');
        } else {
            toastr.info('会话已解锁，将跟随当前角色。', '诏曰');
            log('会话已解锁。', 'info');
        }
        // 锁定/解锁后，立即刷新状态面板以反映正确的ID和数量
        updatePanelStatus();
    });

    // 初始化时也更新一次UI
    updateSessionLockUI(HanlinyuanCore.isSessionLocked());
}

/**
 * 【新增】根据锁定状态更新UI元素
 * @param {boolean} isLocked - 当前是否处于锁定状态
 */
function updateSessionLockUI(isLocked) {
    const lockButton = document.getElementById('hly-session-lock-btn');
    if (!lockButton) return;

    const icon = lockButton.querySelector('i');
    const text = lockButton.querySelector('span');

    if (isLocked) {
        lockButton.classList.add('active');
        icon.className = 'fas fa-lock';
        text.textContent = '解锁会话';
        lockButton.title = '点击以解锁，让翰林院跟随当前角色';
    } else {
        lockButton.classList.remove('active');
        icon.className = 'fas fa-lock-open';
        text.textContent = '锁定会话';
        lockButton.title = '点击以锁定，让翰林院固定操作当前角色的宝库';
    }
}

function bindPanelToggleEvents() {
    // 【最终版】权力回归中央
    // “返回主殿”按钮的逻辑已由 ui/bindings.js 中的中央导航系统统一处理。
    // 我们只需处理“打开翰林院”的按钮即可。
    const openButton = document.getElementById('amily2_open_rag_palace');
    if (openButton) {
        // 这个按钮的逻辑依然由中央导航系统处理，我们无需在此添加监听器。
        // 保留此函数结构以备将来可能的扩展，但目前它无需执行任何操作。
    }

    // 我们自己的返回按钮 (hly-back-to-main) 已被赋予新的ID，并由中央接管。
    // 此处不再需要为它绑定任何事件。
}

function bindTutorialEvents() {
    const tutorialButton = document.getElementById('amily2_open_hanlin_tutorial');
    if (tutorialButton) {
        tutorialButton.addEventListener('click', () => {
            // 我们需要从Amily2主模块获取授权状态，但为解耦，此处暂不检查
            // if (!pluginAuthStatus.authorized) return;
            showContentModal("翰林院使用教程", "scripts/extensions/third-party/ST-Amily2-Chat-Optimisation/HanLin.md");
        });
    }
}

function bindInternalUIEvents() {
    const tabs = document.querySelectorAll('.hly-nav-item');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTabId = tab.dataset.tab;
            // 修正选择器以匹配新的 'historiography' ID
            const targetPaneId = `hly-${targetTabId}-tab`;
            document.querySelectorAll('.hly-tab-pane').forEach(pane => {
                pane.classList.toggle('active', pane.id === targetPaneId);
            });
            tabs.forEach(t => t.classList.toggle('active', t === tab));
        });
    });

    const apiEndpointSelect = document.getElementById('hly-api-endpoint');
    if (apiEndpointSelect) {
        apiEndpointSelect.addEventListener('change', toggleCustomEndpointDocket);
    }

    // 为最终版注入位置单选框绑定事件
    const positionRadios = document.querySelectorAll('input[name="hly-injection-position"]');
    positionRadios.forEach(radio => {
        radio.addEventListener('change', toggleInjectionDetails);
    });

    // 【新增】为“标签提取”复选框绑定事件
    const tagExtractionToggle = document.getElementById('hly-tag-extraction-toggle');
    const tagInputContainer = document.getElementById('hly-tag-input-container');
    if (tagExtractionToggle && tagInputContainer) {
        tagExtractionToggle.addEventListener('change', () => {
            tagInputContainer.style.display = tagExtractionToggle.checked ? 'block' : 'none';
        });
    }

    // 【新增】为“书库选择”下拉框绑定联动事件
    const librarySelect = document.getElementById('hly-hist-select-library');
    if (librarySelect) {
        librarySelect.addEventListener('change', handleWorldbookSelectionChange);
    }

    // 【新增】为“内容排除”按钮绑定事件
    const exclusionRulesBtn = document.getElementById('hly-exclusion-rules-btn');
    if (exclusionRulesBtn) {
        exclusionRulesBtn.addEventListener('click', showExclusionRulesModal);
    }
}

/**
 * 新增：根据注入位置启用/禁用详细设置
 */
function toggleInjectionDetails() {
    const position = document.querySelector('input[name="hly-injection-position"]:checked').value;
    const depthInput = document.getElementById('hly-injection-depth');
    const roleSelect = document.getElementById('hly-injection-role');
    
    // 只有当 position 为 "1" (聊天内) 时，才启用详细设置
    const isChatMode = (position === '1');
    depthInput.disabled = !isChatMode;
    roleSelect.disabled = !isChatMode;
}

function toggleCustomEndpointDocket() {
    const endpoint = document.getElementById('hly-api-endpoint').value;
    const docket = document.getElementById('hly-custom-endpoint-docket');
    if (docket) {
        docket.style.display = (endpoint === 'custom' || endpoint === 'azure') ? 'block' : 'none';
    }
}

function loadSettingsToUI() {
    const settings = HanlinyuanCore.getSettings();
    if (!settings) return;

    // 检索设置
    document.getElementById('hly-retrieval-enabled').checked = settings.retrieval.enabled;
    document.getElementById('hly-api-endpoint').value = settings.retrieval.apiEndpoint;
    document.getElementById('hly-custom-api-url').value = settings.retrieval.customApiUrl;
    document.getElementById('hly-api-key').value = settings.retrieval.apiKey;
    // 对于下拉框，我们只设置初始值，但不清空列表
    const modelSelect = document.getElementById('hly-embedding-model');
    if (modelSelect.options.length === 0) {
        const currentModel = settings.retrieval.embeddingModel;
        const option = new Option(currentModel, currentModel, true, true);
        modelSelect.add(option);
    }
    modelSelect.value = settings.retrieval.embeddingModel;
    document.getElementById('hly-retrieval-notify').checked = settings.retrieval.notify;

    // 高级设定
    document.getElementById('hly-chunk-size').value = settings.advanced.chunkSize;
    document.getElementById('hly-overlap-size').value = settings.advanced.overlap;
    document.getElementById('hly-match-threshold').value = settings.advanced.matchThreshold;
    document.getElementById('hly-query-message-count').value = settings.advanced.queryMessageCount;
    document.getElementById('hly-max-results').value = settings.advanced.maxResults;
    document.getElementById('hly-batch-size').value = settings.retrieval.batchSize;

    // 注入设定 (最终版逻辑)
    document.getElementById('hly-injection-template').value = settings.injection.template;
    const positionRadio = document.querySelector(`input[name="hly-injection-position"][value="${settings.injection.position}"]`);
    if (positionRadio) {
        positionRadio.checked = true;
    }
    document.getElementById('hly-injection-depth').value = settings.injection.depth;
    document.getElementById('hly-injection-role').value = settings.injection.depth_role;
    
    // 根据加载的设置，更新UI显示状态
    toggleInjectionDetails();

    // 凝识设置
    document.getElementById('hly-condensation-enabled').checked = settings.condensation.enabled;
    document.getElementById('hly-layer-start').value = settings.condensation.layerStart;
    document.getElementById('hly-layer-end').value = settings.condensation.layerEnd;
    document.getElementById('hly-include-user').checked = settings.condensation.messageTypes.user;
    document.getElementById('hly-include-ai').checked = settings.condensation.messageTypes.ai;
    
    // 新增：加载标签提取设置
    const tagExtractionToggle = document.getElementById('hly-tag-extraction-toggle');
    const tagInput = document.getElementById('hly-tag-input');
    const tagInputContainer = document.getElementById('hly-tag-input-container');

    tagExtractionToggle.checked = settings.condensation.tagExtractionEnabled;
    tagInput.value = settings.condensation.tags; // 直接使用从核心获取的值
    tagInputContainer.style.display = tagExtractionToggle.checked ? 'block' : 'none';

    // Rerank 设置
    document.getElementById('hly-rerank-enabled').checked = settings.rerank.enabled;
    document.getElementById('hly-rerank-url').value = settings.rerank.url;
    document.getElementById('hly-rerank-api-key').value = settings.rerank.apiKey;
    const rerankModelSelect = document.getElementById('hly-rerank-model');
    if (rerankModelSelect.options.length === 0) {
        const currentModel = settings.rerank.model;
        if (currentModel) {
            const option = new Option(currentModel, currentModel, true, true);
            rerankModelSelect.add(option);
        }
    }
    rerankModelSelect.value = settings.rerank.model;
    document.getElementById('hly-rerank-top-n').value = settings.rerank.top_n;
    document.getElementById('hly-rerank-hybrid-alpha').value = settings.rerank.hybrid_alpha;
    document.getElementById('hly-rerank-notify').checked = settings.rerank.notify;


    toggleCustomEndpointDocket();
}

/**
 * 【重构】手动从UI保存所有设置。主要用于“存档封印”按钮，作为一种保险机制。
 * @param {boolean} isAutoSave - 标记是否为自动保存调用
 */
function saveSettingsFromUI(isAutoSave = true) {
    const container = document.getElementById('hly-modal-container');
    if (!container) return;

    const inputs = container.querySelectorAll('[data-setting-key]');
    
    inputs.forEach(target => {
        const key = target.dataset.settingKey;
        if (!key) return;

        let value;
        const type = target.dataset.type || 'string';

        if (target.type === 'checkbox') {
            value = target.checked;
        } else if (target.type === 'radio') {
            if (!target.checked) return; // 只处理选中的radio
            value = target.value;
        } else {
            value = target.value;
        }

        // 类型转换
        switch (type) {
            case 'integer':
                value = parseInt(value, 10);
                break;
            case 'float':
                value = parseFloat(value);
                break;
            case 'boolean':
                if (typeof value !== 'boolean') value = (value === 'true');
                break;
        }
        
        // 直接调用核心更新函数，但不在这里重复记录日志
        const settings = HanlinyuanCore.getSettings();
        const keys = key.split('.');
        let current = settings;
        for (let i = 0; i < keys.length - 1; i++) {
            current = current[keys[i]] = current[keys[i]] || {};
        }
        current[keys[keys.length - 1]] = value;
    });

    HanlinyuanCore.saveSettings();
    
    if (!isAutoSave) {
        log('【手动存档】所有设定已存档封印。', 'success');
        toastr.success('翰林院设定已存档封印。', '圣旨已达');
    }
    // 自动保存的日志已在 updateAndSaveSetting 中处理，此处不再重复
}

function resetSettingsToUI() {
    if (confirm('您确定要将所有设定恢复为出厂默认值吗？')) {
        HanlinyuanCore.resetSettings();
        loadSettingsToUI();
        toastr.info('翰林院设定已重置为初始状态。', '诏曰');
    }
}

async function updatePanelStatus() {
    // 【V5.1 改造】根据锁定状态更新显示
    const isLocked = HanlinyuanCore.isSessionLocked();
    const charNameEl = document.getElementById('hly-current-character-name');
    const chatIdEl = document.getElementById('hly-current-chat-id');

    if (isLocked) {
        const lockedInfo = HanlinyuanCore.getLockedSessionInfo();
        charNameEl.textContent = '会话已锁定';
        chatIdEl.textContent = lockedInfo.id;
        chatIdEl.title = `当前所有操作都将指向这个锁定的宝库：${lockedInfo.id}`;
        charNameEl.classList.add('hly-locked-status');
        chatIdEl.classList.add('hly-locked-status');
    } else {
        charNameEl.textContent = ContextUtils.getCharacterName();
        chatIdEl.textContent = ContextUtils.getChatId() || '无';
        chatIdEl.title = '';
        charNameEl.classList.remove('hly-locked-status');
        chatIdEl.classList.remove('hly-locked-status');
    }
    
    const countEl = document.getElementById('hly-current-vector-count');
    countEl.textContent = '...';
    try {
        const count = await HanlinyuanCore.getVectorCount();
        countEl.textContent = count;
    } catch (error) {
        console.error('[翰林院-枢纽] 更新忆识数量失败:', error);
        countEl.textContent = 'N/A';
        countEl.title = `无法获取总数: ${error.message}`;
    }

    // 【V5.3 新增】显示上次凝识记录
    const recordEl = document.getElementById('hly-condensation-results');
    // 只有在没有进行中的预览时才更新记录
    if (recordEl && !recordEl.dataset.finalText) {
        const settings = HanlinyuanCore.getSettings();
        const collectionId = HanlinyuanCore.getCollectionId();
        
        if (settings.condensationHistory && settings.condensationHistory[collectionId]) {
            const record = settings.condensationHistory[collectionId];
            // V5.4 - record.end is now always a number, so the text is simpler.
            recordEl.innerHTML = `<p class="hly-record-hint"><i>上次已从第 ${record.start} 楼凝识至第 ${record.end} 楼。</i></p>`;
        } else {
            recordEl.innerHTML = `<p class="hly-record-hint">可在此预览凝识结果。</p>`;
        }
    }
}

async function testApi() {
    toastr.info('正在测试神力连接...', '圣旨');
    try {
        await HanlinyuanCore.testApiConnection();
        toastr.success('神力连接通畅！', '圣意');
    } catch (error) {
        toastr.error(`神力连接失败: ${error.message}`, '警报');
    }
}

/**
 * 新增：获取并填充嵌入模型列表
 */
async function fetchHLYEmbeddingModels() {
    const modelSelect = document.getElementById('hly-embedding-model');
    const currentModel = modelSelect.value; // 保存当前选中的模型
    modelSelect.innerHTML = '<option>正在获取...</option>';
    modelSelect.disabled = true;

    try {
        log('开始获取模型列表...', 'info');
        const models = await HanlinyuanCore.fetchEmbeddingModels();
        modelSelect.innerHTML = ''; // 清空

        if (models.length === 0) {
            modelSelect.innerHTML = '<option>未找到模型</option>';
            toastr.warn('未能获取到任何模型。', '翰林院启奏');
            log('未能获取到任何模型。', 'warn');
            return;
        }

        models.forEach(modelId => {
            const option = new Option(modelId, modelId);
            modelSelect.add(option);
        });

        // 尝试恢复之前的选择
        if (models.includes(currentModel)) {
            modelSelect.value = currentModel;
        } else {
            // 如果之前的模型不在新列表中，则默认选中第一个
            modelSelect.selectedIndex = 0;
        }
        
        toastr.success(`成功获取 ${models.length} 个模型。`, '圣意');
        log(`成功获取 ${models.length} 个模型。`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 获取模型列表失败:', error);
        toastr.error(`获取模型失败: ${error.message}`, '严重错误');
        log(`获取模型失败: ${error.message}`, 'error');
        modelSelect.innerHTML = `<option>获取失败</option>`;
    } finally {
        modelSelect.disabled = false;
    }
}

/**
 * 新增：获取并填充Rerank模型列表
 */
async function fetchHLYRerankModels() {
    const modelSelect = document.getElementById('hly-rerank-model');
    const currentModel = modelSelect.value;
    modelSelect.innerHTML = '<option>正在获取...</option>';
    modelSelect.disabled = true;

    try {
        log('开始获取Rerank模型列表...', 'info');
        const models = await HanlinyuanCore.fetchRerankModels();
        modelSelect.innerHTML = '';

        if (models.length === 0) {
            modelSelect.innerHTML = '<option>未找到模型</option>';
            toastr.warn('未能获取到任何Rerank模型。', '翰林院启奏');
            log('未能获取到任何Rerank模型。', 'warn');
            return;
        }

        models.forEach(modelId => {
            const option = new Option(modelId, modelId);
            modelSelect.add(option);
        });

        if (models.includes(currentModel)) {
            modelSelect.value = currentModel;
        } else {
            modelSelect.selectedIndex = 0;
        }
        
        toastr.success(`成功获取 ${models.length} 个Rerank模型。`, '圣意');
        log(`成功获取 ${models.length} 个Rerank模型。`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 获取Rerank模型列表失败:', error);
        toastr.error(`获取Rerank模型失败: ${error.message}`, '严重错误');
        log(`获取Rerank模型失败: ${error.message}`, 'error');
        modelSelect.innerHTML = `<option>获取失败</option>`;
    } finally {
        modelSelect.disabled = false;
    }
}

async function purgeStorage() {
    if (confirm('此操作将彻底清空当前角色的所有忆识（向量），且无法恢复。您确定要继续吗？')) {
        toastr.info('正在清空宝库...', '圣旨');
        const success = await HanlinyuanCore.purgeStorage();
        if (success) {
            toastr.success('宝库已清空。', '圣意');
        } else {
            toastr.error('清空宝库失败。', '警报');
        }
        await updatePanelStatus();
    }
}

async function startCondensation() {
    const resultsEl = document.getElementById('hly-condensation-results');
    const preprocessedText = resultsEl.dataset.finalText;
    
    // 【V5.3 新增】获取范围以供记录
    const layerStart = document.getElementById('hly-layer-start').value;
    const layerEnd = document.getElementById('hly-layer-end').value;
    const range = { start: parseInt(layerStart), end: parseInt(layerEnd) };

    try {
        // 路径一：如果经过了预览和编辑，直接处理最终文本
        if (preprocessedText && preprocessedText.trim()) {
            log('检测到预览后待处理的文本，开始直接凝识...', 'info');
            toastr.info('正在处理您确认后的文书...', '圣旨');
            resultsEl.textContent = '正在处理预览后的文本...';

            // 【V5.3 修改】传递范围
            const result = await HanlinyuanCore.ingestTextToHanlinyuan(preprocessedText, 'chat_history', `聊天记录 ${range.start}-${range.end}`, ()=>{}, null, log, ()=>{}, null, 0, range);
            if (result.success) {
                toastr.success(`文书已成功录入宝库，新增 ${result.count} 条忆识。`, '大功告成');
                log(`预览后文本录入成功，新增 ${result.count} 条忆识。`, 'success');
                const finalEnd = range.end === 0 ? getContext().chat.length : range.end;
                resultsEl.textContent = `聊天记录从第 ${range.start} 楼到第 ${finalEnd} 楼已成功凝识，新增 ${result.count} 条忆识。`;
                delete resultsEl.dataset.finalText; // 清理暂存数据
            } else {
                throw new Error(result.error || '未知错误');
            }
        } 
        // 路径二：用户未经过预览，按原流程处理
        else {
            resultsEl.textContent = '正在采集消息...';
            toastr.info('正在准备凝识...', '圣旨');
            log('未检测到预览文本，按标准流程采集消息...', 'info');

            const messages = HanlinyuanCore.getMessagesForCondensation();
            if (!messages || messages.length === 0) {
                toastr.warning('未找到符合条件的消息可供凝识。', '翰林院启奏');
                resultsEl.textContent = '未找到符合条件的消息。';
                return;
            }

            resultsEl.textContent = `已采集 ${messages.length} 条消息，开始凝识...`;
            toastr.info(`已采集 ${messages.length} 条消息，开始凝识...`, '翰林院启奏');
            
            // 【V5.3 修改】传递范围
            const result = await HanlinyuanCore.processCondensation(messages, log, range);

            if (result.success) {
                toastr.success(`凝识完成！新增 ${result.count} 条忆识。`, '大功告成');
                const finalEnd = range.end === 0 ? getContext().chat.length : range.end;
                resultsEl.textContent = `聊天记录从第 ${range.start} 楼到第 ${finalEnd} 楼已成功凝识，新增 ${result.count} 条忆识。`;
            } else {
                throw new Error(result.error || '未知错误');
            }
        }
    } catch (error) {
        console.error('[翰林院-枢纽] 凝识过程发生错误:', error);
        toastr.error(`凝识失败: ${error.message}`, '严重错误');
        resultsEl.textContent = `凝识失败: ${error.message}`;
    } finally {
        await updatePanelStatus();
    }
}

// =====================================================================
// ======================= 【新增】书库编纂相关函数 =======================
// =====================================================================

/**
 * 加载所有可用的世界书到“选择书库”下拉框
 */
async function loadWorldbookList() {
    const selectEl = document.getElementById('hly-hist-select-library');
    if (!selectEl) return;

    try {
        log('正在获取可用书库列表...', 'info');
        const books = await Historiographer.getAvailableWorldbooks();
        selectEl.innerHTML = '<option value="">请选择一个书库...</option>'; // 清空并添加占位符

        if (books.length === 0) {
            selectEl.innerHTML = '<option value="">未找到任何书库</option>';
            return;
        }

        books.forEach(bookName => {
            const option = new Option(bookName, bookName);
            selectEl.add(option);
        });
        log(`成功加载 ${books.length} 个书库。`, 'success');
    } catch (error) {
        console.error('[翰林院-枢纽] 加载书库列表失败:', error);
        log(`加载书库列表失败: ${error.message}`, 'error');
        selectEl.innerHTML = '<option value="">加载失败</option>';
    }
}

/**
 * 处理书库选择变化，联动更新条目下拉框
 */
async function handleWorldbookSelectionChange() {
    const librarySelect = document.getElementById('hly-hist-select-library');
    const entrySelect = document.getElementById('hly-hist-select-entry');
    const selectedBook = librarySelect.value;

    entrySelect.innerHTML = '<option value="">正在加载条目...</option>';
    entrySelect.disabled = true;

    if (!selectedBook) {
        entrySelect.innerHTML = '<option value="">请先选择书库</option>';
        return;
    }

    try {
        log(`正在为《${selectedBook}》获取条目列表...`, 'info');
        const entries = await Historiographer.getLoresForWorldbook(selectedBook);
        entrySelect.innerHTML = '<option value="">请选择一个条目...</option>';

        if (entries.length === 0) {
            entrySelect.innerHTML = '<option value="">此书库为空</option>';
            return;
        }

        entries.forEach(entry => {
            const option = new Option(`${entry.comment} (Key: ${entry.key})`, entry.key);
            entrySelect.add(option);
        });
        log(`成功加载 ${entries.length} 个条目。`, 'success');
    } catch (error) {
        console.error(`[翰林院-枢纽] 加载《${selectedBook}》的条目失败:`, error);
        log(`加载条目失败: ${error.message}`, 'error');
        entrySelect.innerHTML = '<option value="">加载失败</option>';
    } finally {
        entrySelect.disabled = false;
    }
}

/**
 * 【存根】开始书库编纂的核心函数
 */
async function startHistoriography() {
    const library = document.getElementById('hly-hist-select-library').value;
    const entry = document.getElementById('hly-hist-select-entry').value;
    const resultsEl = document.getElementById('hly-historiography-results');

    if (!library || !entry) {
        toastr.warning('请先选择一个书库和要编纂的条目。', '圣谕不明');
        return;
    }

    resultsEl.textContent = `准备对《${library}》中的条目 (Key: ${entry}) 进行编纂...`;
    toastr.info('编纂任务已开始...', '圣旨');
    log(`开始对《${library}》-${entry} 进行编纂...`, 'info');

    try {
        const result = await Historiographer.executeCompilation(library, entry);
        if (result.success) {
            const entrySelect = document.getElementById('hly-hist-select-entry');
            const entryName = entrySelect.options[entrySelect.selectedIndex].text;
            const message = `《${library}》中的条目【${entryName}】已成功编纂入库。`;
            resultsEl.textContent = message;
            toastr.success('编纂任务已完成。', '大功告成');
            log(`对《${library}》中条目 (Key: ${entry}) 的编纂任务已完成。`, 'success');
        } else {
            throw new Error(result.error || "未知的编纂错误");
        }
    } catch (error) {
        console.error('[翰林院-枢纽] 编纂过程发生错误:', error);
        toastr.error(`编纂失败: ${error.message}`, '严重错误');
        resultsEl.textContent = `编纂失败: ${error.message}`;
    }
}

/**
 * 修复：实现缺失的“查看宝库”功能
 */
async function showStats() {
    try {
        log('用户请求查看宝库状态。', 'info');
        toastr.info('正在查询宝库状态...', '圣旨');

        const count = await HanlinyuanCore.getVectorCount();
        const collectionId = HanlinyuanCore.getCollectionId();
        const settings = HanlinyuanCore.getSettings();

        // 使用 pre 标签来保持格式
        const statsText = `
<pre>
翰林院宝库状态
--------------------
集合ID: ${collectionId}
忆识总数: ${count}
--------------------
API端点: ${settings.retrieval.apiEndpoint}
所用模型: ${settings.retrieval.embeddingModel}
</pre>
        `;
        
        toastr.info(statsText, '宝库状态', {
            timeOut: 15000, // 延长显示时间
            extendedTimeOut: 5000,
            tapToDismiss: true,
            closeButton: true,
        });
        
        log(`查看宝库状态成功：集合ID=${collectionId}, 忆识总数=${count}`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 查询宝库状态失败:', error);
        toastr.error(`查询宝库状态失败: ${error.message}`, '严重错误');
        log(`查询宝库状态失败: ${error.message}`, 'error');
    }
}

/**
 * 新增：显示和编辑内容排除规则的弹窗
 */
function showExclusionRulesModal() {
    const settings = HanlinyuanCore.getSettings();
    const rules = settings.condensation.exclusionRules || [];

    // Function to create a single rule row HTML
    const createRuleRowHtml = (rule = { start: '', end: '' }, index) => `
        <div class="hly-exclusion-rule-row" data-index="${index}">
            <input type="text" class="hly-imperial-brush" value="${rule.start}" placeholder="开始字符, 如 <!--">
            <span>到</span>
            <input type="text" class="hly-imperial-brush" value="${rule.end}" placeholder="结束字符, 如 -->">
            <button class="hly-delete-rule-btn" title="删除此规则">&times;</button>
        </div>
    `;

    // Build the initial HTML for all existing rules
    const rulesHtml = rules.map(createRuleRowHtml).join('');

    const modalHtml = `
        <div id="hly-exclusion-rules-container">
            <p class="hly-notes">在这里定义需要从提取内容中排除的文本片段。例如，排除HTML注释，可以设置开始字符为 \`<!--\`，结束字符为 \`-->\`。</p>
            <div id="hly-rules-list">${rulesHtml}</div>
            <button id="hly-add-rule-btn" class="hly-action-button" style="margin-top: 10px;">
                <i class="fas fa-plus"></i> 添加新规则
            </button>
        </div>
        <style>
            .hly-exclusion-rule-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
            .hly-exclusion-rule-row input { flex-grow: 1; }
            .hly-delete-rule-btn { background: #c0392b; color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 16px; line-height: 24px; text-align: center; padding: 0; }
        </style>
    `;

    showHtmlModal('编辑内容排除规则', modalHtml, {
        okText: '保存规则',
        onOk: (dialogElement) => {
            const newRules = [];
            dialogElement.find('.hly-exclusion-rule-row').each(function() {
                const start = $(this).find('input').eq(0).val().trim();
                const end = $(this).find('input').eq(1).val().trim();
                if (start && end) {
                    newRules.push({ start, end });
                }
            });
            updateAndSaveSetting('condensation.exclusionRules', newRules);
            toastr.success('内容排除规则已保存。', '圣旨已达');
        }
    });

    // Event listeners for the modal content (add/delete)
    const modalContent = document.getElementById('hly-exclusion-rules-container');
    const rulesList = modalContent.querySelector('#hly-rules-list');

    // Add rule button
    modalContent.querySelector('#hly-add-rule-btn').addEventListener('click', () => {
        const newIndex = rulesList.children.length;
        const newRowHtml = createRuleRowHtml({ start: '', end: '' }, newIndex);
        rulesList.insertAdjacentHTML('beforeend', newRowHtml);
    });

    // Delete rule button (using event delegation)
    rulesList.addEventListener('click', (event) => {
        if (event.target.classList.contains('hly-delete-rule-btn')) {
            event.target.closest('.hly-exclusion-rule-row').remove();
        }
    });
}

function previewCondensation() {
    const resultsEl = document.getElementById('hly-condensation-results');
    try {
        // 1. 获取UI设置和新规则
        const settings = HanlinyuanCore.getSettings();
        const exclusionRules = settings.condensation.exclusionRules || [];
        const overrideMessageTypes = {
            user: document.getElementById('hly-include-user').checked,
            ai: document.getElementById('hly-include-ai').checked,
        };
        const useTagExtraction = document.getElementById('hly-tag-extraction-toggle').checked;
        const tagsToExtract = useTagExtraction 
            ? document.getElementById('hly-tag-input').value.split(',').map(t => t.trim()).filter(Boolean)
            : [];

        // 2. 获取原始消息
        const messages = HanlinyuanCore.getMessagesForCondensation(overrideMessageTypes);
        
        if (!messages || messages.length === 0) {
            resultsEl.textContent = '根据当前勾选条件，未找到符合的消息可供预览。';
            toastr.warning('未找到符合条件的消息。', '翰林院启奏');
            return;
        }

        // 3. 处理消息内容
        const processedMessages = messages.map((msg, index) => {
            let content;

            // 【V5.2 最终规则】用户消息不受标签提取和内容排除的任何影响
            if (msg.is_user) {
                content = msg.mes;
            } 
            // AI消息则遵循所有规则
            else {
                if (useTagExtraction && tagsToExtract.length > 0) {
                    const blocks = extractBlocksByTags(msg.mes, tagsToExtract);
                    content = blocks.join('\n\n');
                } else {
                    content = msg.mes;
                }
                // 内容排除规则只对AI消息生效
                content = applyExclusionRules(content, exclusionRules);
            }

            return {
                id: `preview-item-${index}`,
                name: msg.name,
                content: content.trim(),
            };
        }).filter(item => item.content); // 过滤掉处理后内容为空的条目

        if (processedMessages.length === 0) {
            resultsEl.textContent = '根据标签提取或内容排除条件，未找到任何有效内容。';
            toastr.warning('根据标签提取或内容排除条件，未找到任何有效内容。', '翰林院启奏');
            return;
        }

        // 4. 构建编辑器HTML (V3 - 优化布局和交互)
        const editorHtml = processedMessages.map((item, index) => `
            <div class="hly-preview-item-v2" id="${item.id}">
                <details class="hly-preview-details">
                    <summary class="hly-preview-summary">
                        第 ${index + 1} 楼: [${item.name}]
                    </summary>
                    <div class="hly-preview-content">
                        <textarea class="hly-preview-textarea">${item.content}</textarea>
                    </div>
                </details>
                <button class="hly-preview-delete-btn-v2" data-target="${item.id}" title="删除此条">&times;</button>
            </div>
        `).join('');

        // 5. 显示模态窗口
        showHtmlModal('预览并编辑凝识内容', `<div class="hly-preview-container-v2">${editorHtml}</div>`, {
            okText: '确认并更新预览',
            onOk: (dialogElement) => {
                const finalContent = [];
                dialogElement.find('.hly-preview-item-v2').each(function() {
                    const text = $(this).find('.hly-preview-textarea').val();
                    if (text.trim()) { // 只保留非空内容
                        finalContent.push(text);
                    }
                });
                
                const finalText = finalContent.join('\n\n---\n\n');
                // 更新预览区UI
                const layerStart = document.getElementById('hly-layer-start').value;
                const layerEnd = document.getElementById('hly-layer-end').value;
                resultsEl.textContent = `已选择 ${layerStart} 楼到 ${layerEnd} 楼的内容（共 ${finalContent.length} 条有效条目），请点击“开始凝识”进入自动向量化流程。`;
                // 将最终文本暂存到dataset中，供“开始凝识”使用
                resultsEl.dataset.finalText = finalText; 
                toastr.success('预览内容已更新，可随时开始凝识。', '圣旨已达');
            }
        });

        // 6. 为新生成的删除按钮绑定事件 (V2)
        $('.hly-preview-delete-btn-v2').on('click', function(e) {
            e.preventDefault();
            const targetId = $(this).data('target');
            $(`#${targetId}`).remove();
        });

    } catch (error) {
        console.error('[翰林院-枢纽] 预览过程发生错误:', error);
        resultsEl.textContent = `预览失败: ${error.message}`;
        toastr.error(`预览失败: ${error.message}`, '严重错误');
    }
}

/**
 * 新增：日志记录函数
 * @param {string} message - 要记录的消息
 * @param {string} type - 'info', 'success', 'error', 'warn'
 */
function log(message, type = 'info') {
    const logOutput = document.getElementById('hly-log-output');
    if (!logOutput) return;

    const p = document.createElement('p');
    const timestamp = new Date().toLocaleTimeString();
    
    let icon = 'fa-circle-info';
    let colorClass = 'log-info';

    switch (type) {
        case 'success':
            icon = 'fa-check-circle';
            colorClass = 'log-success';
            break;
        case 'error':
            icon = 'fa-times-circle';
            colorClass = 'log-error';
            break;
        case 'warn':
            icon = 'fa-exclamation-triangle';
            colorClass = 'log-warn';
            break;
    }

    p.className = `hly-log-entry ${colorClass}`;
    p.innerHTML = `<i class="fa-solid ${icon}"></i> [${timestamp}] ${message}`;
    
    // 移除初始的占位符
    const placeholder = logOutput.querySelector('.hly-log-placeholder');
    if (placeholder) {
        placeholder.remove();
    }

    logOutput.appendChild(p);
    logOutput.scrollTop = logOutput.scrollHeight; // 自动滚动到底部
}


/**
 * 新增：处理手动录入的文本
 */
async function ingestManualText() {
    const textArea = document.getElementById('hly-manual-text');
    const text = textArea.value.trim();

    if (!text) {
        toastr.warning('录入内容不能为空。', '翰林院启奏');
        log('用户尝试录入空文本。', 'warn');
        return;
    }

    log(`收到手动录入请求，文本长度: ${text.length}`, 'info');
    toastr.info('正在处理您提交的文书...', '圣旨');

    try {
        const result = await HanlinyuanCore.ingestTextToHanlinyuan(text, 'manual', '手动录入');
        if (result.success) {
            toastr.success(`文书已成功录入宝库，新增 ${result.count} 条忆识。`, '大功告成');
            log(`手动录入成功，新增 ${result.count} 条忆识。`, 'success');
            textArea.value = ''; // 清空文本域
        } else {
            throw new Error(result.error || '未知错误');
        }
    } catch (error) {
        console.error('[翰林院-枢纽] 手动录入过程发生错误:', error);
        toastr.error(`文书录入失败: ${error.message}`, '严重错误');
        log(`手动录入失败: ${error.message}`, 'error');
    } finally {
        await updatePanelStatus();
    }
}
