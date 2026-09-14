
import { getContext } from '/scripts/extensions.js';
import { extensionBasePath } from '../utils/settings.js';
import * as HanlinyuanCore from '../core/rag-processor.js';
import * as Historiographer from '../core/historiographer.js';
import * as ContextUtils from '../core/utils/context-utils.js';
import * as IngestionManager from '../core/ingestion-manager.js';
import { showContentModal, showHtmlModal } from './page-window.js';
import { extractBlocksByTags, applyExclusionRules } from '../core/utils/rag-tag-extractor.js';
import { ruleProfileManager, resolveCondensationRuleConfig } from '../utils/config/RuleProfileManager.js';
import { clearSecretInput, markSecretInputStored, readSecretInputUpdate } from './secret-input.js';
import { readTextFile } from '../core/utils/text-file-decoder.js';
import { syncSlot } from './profile-sync.js';
import {
    filterWorldbooks,
    filterWorldbookEntries,
    highlightSearchMatch,
    debounce
} from '../core/rag-processor.js';

import { t, applyTranslations, subscribeLocaleChange } from '../utils/i18n/index.js';

// Keep locale refresh limited to display text. Never replay initialization or change handlers.
const vectorTextBindings = new Map();

function clearVectorBinding(element, property = 'textContent') {
    const attribute = property === 'textContent' ? 'data-amily-i18n' : `data-amily-i18n-${property}`;
    element.removeAttribute(attribute);
    vectorTextBindings.get(element)?.delete(property);
}

function setVectorText(element, key, params = {}, property = 'textContent') {
    clearVectorBinding(element, property);
    const value = t(key, params);
    element[property] = value;
    if (!vectorTextBindings.has(element)) vectorTextBindings.set(element, new Map());
    vectorTextBindings.get(element).set(property, { key, params, value });
}

function setVectorValueOrFallback(element, value, fallbackKey) {
    if (value) {
        clearVectorBinding(element);
        element.textContent = value;
    } else {
        setVectorText(element, fallbackKey);
    }
}

function vectorHtml(key, params = {}) {
    return `<span data-vector-i18n="${escapeAttribute(key)}" data-vector-params="${escapeAttribute(JSON.stringify(params))}">${escapeTextareaContent(t(key, params))}</span>`;
}

function vectorTitle(key, params = {}) {
    return `title="${escapeAttribute(t(key, params))}" data-vector-title="${escapeAttribute(key)}" data-vector-params="${escapeAttribute(JSON.stringify(params))}"`;
}

function vectorOption(key, value) {
    return `<option value="${escapeAttribute(value)}" data-amily-i18n="${escapeAttribute(key)}">${escapeTextareaContent(t(key))}</option>`;
}

function vectorToast(kind, message, title, options = {}) {
    return toastr[kind](message, title, { ...options, escapeHtml: true });
}

function refreshVectorTranslations() {
    for (const [element, bindings] of vectorTextBindings) {
        if (!element.isConnected) {
            vectorTextBindings.delete(element);
            continue;
        }
        for (const [property, binding] of bindings) {
            // Business callbacks may already have replaced a translated status with raw data.
            if (element[property] !== binding.value) {
                bindings.delete(property);
                continue;
            }
            element[property] = t(binding.key, binding.params);
            binding.value = element[property];
        }
    }
    for (const element of document.querySelectorAll('[data-vector-i18n], [data-vector-title]')) {
        const params = JSON.parse(element.getAttribute('data-vector-params') || '{}');
        const textKey = element.getAttribute('data-vector-i18n');
        const titleKey = element.getAttribute('data-vector-title');
        if (textKey) element.textContent = t(textKey, params);
        if (titleKey) element.title = t(titleKey, params);
    }
}

subscribeLocaleChange(refreshVectorTranslations);

'use strict';

function escapeTextareaContent(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttribute(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}


function _populateHlyRuleProfileSelect(select, slot, detail) {
    const profiles = detail?.profiles ?? ruleProfileManager.listProfiles();
    const assigned = detail?.assignments?.[slot] ?? ruleProfileManager.getAssignment(slot) ?? '';
    select.innerHTML = [
        vectorOption('vectorUi.unassigned', ''),
        ...profiles.map(p =>
            `<option value="${escapeAttribute(p.id)}" ${p.id === assigned ? 'selected' : ''}>${escapeTextareaContent(p.name || p.id)}</option>`
        ),
    ].join('');
}


function setupGlobalEventHandlers() {

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

function updateAndSaveSetting(key, value) {
    const settings = HanlinyuanCore.getSettings();
    if (!settings) return;

    const keys = key.split('.');
    let current = settings;
    for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]] = current[keys[i]] || {};
    }
    current[keys[keys.length - 1]] = value;

    HanlinyuanCore.saveSettings();

    log(`[自动保存] 设置项 '${key}' 已更新为: ${JSON.stringify(value)}`, 'success');
}

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
            if (target.type === 'password') {
                const update = readSecretInputUpdate(target);
                if (!update.changed) return;
                value = update.value;
            }
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
        if (target.type === 'password') {
            markSecretInputStored(target, Boolean(value));
        }

        // 如果更改了影响面板状态的设置（如独立聊天记忆开关），则立即刷新
        if (key === 'retrieval.independentChatMemoryEnabled') {
            updatePanelStatus();
        }
    });
}


export function bindHanlinyuanEvents() {
    const context = getContext();
    if (!context) {
        console.error('[翰林院-枢纽] 未能获取SillyTavern上下文，绑定失败。');
        return;
    }

    applyTranslations(document.getElementById('hly-modal-container')?.parentElement);
    setupGlobalEventHandlers();
    syncSlot('ragEmbed');
    syncSlot('ragRerank');
    bindPanelToggleEvents();
    bindInternalUIEvents();
    bindTutorialEvents(); // 【新增】绑定教程按钮事件
    bindAutoSaveEvents(); // 【新增】激活自动保存机制
    bindSessionLockEvent(); // 【新增】绑定会话锁定事件
    initializeUnifiedInjectionEditor(); // 初始化统一注入编辑器

    // 确保核心已经初始化
    if (HanlinyuanCore.initialize) {
        try {
            HanlinyuanCore.initialize();
        } catch (e) {
            console.error('[翰林院-枢纽] 核心初始化抛出异常：', e);
        }
    } else {
        console.error('[翰林院-枢纽] 核心法典未能提供初始化圣旨！');
        return;
    }

    try {
        loadSettingsToUI();
    } catch (e) {
        console.error('[翰林院-枢纽] loadSettingsToUI 抛出异常：', e);
    }
    try {
        loadWorldbookList();
    } catch (e) {
        console.error('[翰林院-枢纽] loadWorldbookList 抛出异常：', e);
    }
    log('[翰林院-枢纽] 已成功连接各部，政令畅通。', 'info');
    const fileInput = document.getElementById('hanlinyuan-ingest-novel-file-input');
    const fileNameSpan = document.getElementById('hanlinyuan-ingest-novel-file-name');
    const startBtn = document.getElementById('hanlinyuan-ingest-novel-start');
    const abortBtn = document.getElementById('hanlinyuan-ingest-abort');
    const progressContainer = document.getElementById('hanlinyuan-ingest-progress-container');
    const progressBar = document.getElementById('hanlinyuan-ingest-progress-bar');
    const statusText = document.getElementById('hanlinyuan-ingest-status');
    const controlsContainer = document.getElementById('hanlinyuan-ingest-novel-controls');
    const encodingSelect = document.getElementById('hanlinyuan-ingest-novel-encoding');

    let selectedFile = null;
    let abortController = null;

    fileInput.addEventListener('change', (event) => {
        selectedFile = event.target.files[0];
        if (selectedFile) {
            clearVectorBinding(fileNameSpan);
            fileNameSpan.textContent = selectedFile.name;
            fileNameSpan.title = selectedFile.name;
        } else {
            setVectorText(fileNameSpan, 'vectorUi.noFile');
        }
    });

    startBtn.addEventListener('click', async () => {
        if (!selectedFile) {
            vectorToast('warning', t('vectorUi.selectTextFile'));
            return;
        }

        let resumeFromIndex = 0;
        const jobId = IngestionManager.generateJobId(selectedFile);
        const savedState = IngestionManager.loadProgress(jobId);

        if (savedState) {
            const progressPercentage = ((savedState.processedChunks / savedState.totalChunks) * 100).toFixed(1);
            const userChoice = confirm(t('vectorUi.resumePrompt', { p0: progressPercentage }));

            if (userChoice) {
                resumeFromIndex = savedState.processedChunks;
                vectorToast('info', t('vectorUi.resumeStarted', { p0: resumeFromIndex + 1 }), t('vectorUi.noticeDone'));
                log(`[断点续传] 用户选择继续任务 ${jobId}，从第 ${resumeFromIndex} 块开始。`, 'info');
            } else {
                IngestionManager.clearJob(jobId);
                vectorToast('info', t('vectorUi.restartStarted'), t('vectorUi.noticeDone'));
                log(`[断点续传] 用户选择放弃旧任务 ${jobId}，重新开始。`, 'warn');
            }
        }

        abortController = new AbortController();
        const signal = abortController.signal;

        controlsContainer.style.display = 'none';
        progressContainer.style.display = 'block';
        setVectorText(statusText, 'vectorUi.readingFile');
        progressBar.value = 0;

        try {
            const text = await readTextFile(selectedFile, encodingSelect?.value || 'UTF-8');

            const progressCallback = (progress) => {
                setVectorText(statusText, 'vectorUi.ingestionProgress', { p0: progress.message, p1: progress.processed, p2: progress.total });
                progressBar.value = (progress.processed / progress.total) * 100;
            };

            const batchCompleteCallback = () => {
                updatePanelStatus();
                log('[实时刷新] 批次完成，忆识总数已更新。', 'info');
            };

            const result = await HanlinyuanCore.ingestTextToHanlinyuan(
                text,
                'novel',
                { sourceName: selectedFile.name },
                progressCallback,
                signal,
                log,
                batchCompleteCallback,
                jobId,
                resumeFromIndex
            );

            if (result.success) {
                vectorToast('success', t('vectorUi.chunksImported', { p0: result.count }));
                setVectorText(statusText, 'vectorUi.ingestionComplete', { p0: result.count });
                progressBar.value = 100;
                updatePanelStatus();
            } else {
                throw new Error(result.error || '未知错误');
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                vectorToast('info', t('vectorUi.abortedSaved'));
                setVectorText(statusText, 'vectorUi.aborted');
            } else {
                vectorToast('error', t('vectorUi.ingestionRetry', { p0: error.message }));
                setVectorText(statusText, 'vectorUi.errorDetail', { p0: error.message });
            }
        } finally {
            setTimeout(() => {
                controlsContainer.style.display = 'flex';
                progressContainer.style.display = 'none';
                fileInput.value = '';
                selectedFile = null;
                setVectorText(fileNameSpan, 'vectorUi.noFile');
            }, 3000);
        }
    });

    abortBtn.addEventListener('click', () => {
        if (abortController) {
            abortController.abort();
        }
    });
}

function bindSessionLockEvent() {
    const lockButton = document.getElementById('hly-session-lock-btn');
    if (!lockButton) return;

    lockButton.addEventListener('click', async () => {
        const isNowLocked = await HanlinyuanCore.toggleSessionLock();
        updateSessionLockUI(isNowLocked);

        if (isNowLocked) {
            const lockedInfo = HanlinyuanCore.getLockedSessionInfo();
            if (lockedInfo) {
                vectorToast('success', t('vectorUi.sessionLockedTo', { p0: lockedInfo.id }), t('vectorUi.noticeIssued'));
                log(`会话已锁定到宝库: ${lockedInfo.id}`, 'success');
            }
        } else {
            vectorToast('info', t('vectorUi.sessionUnlocked'), t('vectorUi.noticeAnnounce'));
            log('会话已解锁。', 'info');
        }
        // 锁定/解锁后，立即刷新状态面板以反映正确的ID和数量
        updatePanelStatus();
    });

    // 初始化时也更新一次UI
    updateSessionLockUI(HanlinyuanCore.isSessionLocked());
}

function updateSessionLockUI(isLocked) {
    const lockButton = document.getElementById('hly-session-lock-btn');
    if (!lockButton) return;

    const icon = lockButton.querySelector('i');
    const text = lockButton.querySelector('span');

    if (isLocked) {
        lockButton.classList.add('active');
        icon.className = 'fas fa-lock';
        setVectorText(text, 'vectorUi.unlockSession');
        setVectorText(lockButton, 'vectorUi.unlockTip', {}, 'title');
    } else {
        lockButton.classList.remove('active');
        icon.className = 'fas fa-lock-open';
        setVectorText(text, 'vectorUi.lockSession');
        setVectorText(lockButton, 'vectorUi.lockTip', {}, 'title');
    }
}

function bindPanelToggleEvents() {
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

            showContentModal(t('vectorUi.tutorialTitle'), `${extensionBasePath}/HanLin.md`, {
                titleKey: 'vectorUi.tutorialTitle',
                advancedTitle: t('vectorUi.advancedTutorialTitle'),
                advancedTitleKey: 'vectorUi.advancedTutorialTitle',
                advancedUrl: `${extensionBasePath}/HanLin-Advanced.md`,
            });
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
        // 现在这个函数将处理所有模式的UI变化
        apiEndpointSelect.addEventListener('change', handleApiModeChange);
    }

    // 注入设置的UI逻辑已由 initializeUnifiedInjectionEditor 函数统一处理。
    // 标签提取开关/输入框已在 2.1.0 重构中移除，改为规则配置下拉选单管理。

    // 为“书库选择”下拉框绑定联动事件
    const librarySelect = document.getElementById('hly-hist-select-library');
    if (librarySelect) {
        librarySelect.addEventListener('change', handleWorldbookSelectionChange);
    }

    // 浓缩 — 提取规则下拉选单
    const condensationRuleSelect = document.getElementById('hly-condensation-rule-profile-select');
    if (condensationRuleSelect) {
        _populateHlyRuleProfileSelect(condensationRuleSelect, 'condensation');
        condensationRuleSelect.addEventListener('change', () => {
            ruleProfileManager.setAssignment('condensation', condensationRuleSelect.value || null);
            const name = condensationRuleSelect.selectedOptions[0]?.textContent || '';
            vectorToast('info', condensationRuleSelect.value ? t('vectorUi.condensationRuleChanged', { p0: name }) : t('vectorUi.condensationRuleCleared'));
        });
    }

    // 查询预处理 — 提取规则下拉选单
    const queryPrepRuleSelect = document.getElementById('hly-query-preprocessing-rule-profile-select');
    if (queryPrepRuleSelect) {
        _populateHlyRuleProfileSelect(queryPrepRuleSelect, 'queryPreprocessing');
        queryPrepRuleSelect.addEventListener('change', () => {
            ruleProfileManager.setAssignment('queryPreprocessing', queryPrepRuleSelect.value || null);
            const name = queryPrepRuleSelect.selectedOptions[0]?.textContent || '';
            vectorToast('info', queryPrepRuleSelect.value ? t('vectorUi.queryRuleChanged', { p0: name }) : t('vectorUi.queryRuleCleared'));
        });
    }

    // 规则配置中心保存/删除后自动刷新翰林院下拉选单
    document.addEventListener('amily2:ruleProfilesChanged', (e) => {
        if (condensationRuleSelect) _populateHlyRuleProfileSelect(condensationRuleSelect, 'condensation', e.detail);
        if (queryPrepRuleSelect) _populateHlyRuleProfileSelect(queryPrepRuleSelect, 'queryPreprocessing', e.detail);
    });

    // 为自定义多选下拉框绑定事件
    const multiSelectBtn = document.getElementById('hly-hist-entry-multiselect-btn');
    const optionsContainer = document.getElementById('hly-hist-entry-multiselect-options');

    if (multiSelectBtn && optionsContainer) {
        multiSelectBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const isVisible = optionsContainer.style.display === 'block';
            optionsContainer.style.display = isVisible ? 'none' : 'block';
        });

        optionsContainer.addEventListener('change', (event) => {
            const target = event.target;
            if (target.type !== 'checkbox') return;

            const allEntryCheckboxes = optionsContainer.querySelectorAll('.hly-hist-entry-checkbox');
            const selectAllCheckbox = document.getElementById('hly-hist-select-all-entries');

            if (target.id === 'hly-hist-select-all-entries') {
                // 处理“全选”逻辑
                allEntryCheckboxes.forEach(cb => cb.checked = target.checked);
            } else {
                // 更新“全选”复选框的状态
                const allChecked = Array.from(allEntryCheckboxes).every(cb => cb.checked);
                selectAllCheckbox.checked = allChecked;
            }

            // 更新按钮上的计数
            const selectedCount = optionsContainer.querySelectorAll('.hly-hist-entry-checkbox:checked').length;
            const totalCount = allEntryCheckboxes.length;
            setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.selectedEntries', { p0: selectedCount, p1: totalCount });
        });

        // 点击外部关闭下拉框
        document.addEventListener('click', (event) => {
            if (!multiSelectBtn.contains(event.target) && !optionsContainer.contains(event.target)) {
                optionsContainer.style.display = 'none';
            }
        });
    }

    // 为“一键删除”按钮绑定事件
    const deleteAllBtn = document.getElementById('hly-kb-delete-local-btn');
    if (deleteAllBtn) {
        deleteAllBtn.addEventListener('click', deleteAllLocalKnowledgeBases);
    }

    // 为“一键移动”按钮绑定事件
    const moveAllToLocalBtn = document.getElementById('hly-kb-move-all-to-local');
    if (moveAllToLocalBtn) {
        moveAllToLocalBtn.addEventListener('click', () => moveAllKnowledgeBases('globalToLocal'));
    }

    const moveAllToGlobalBtn = document.getElementById('hly-kb-move-all-to-global');
    if (moveAllToGlobalBtn) {
        moveAllToGlobalBtn.addEventListener('click', () => moveAllKnowledgeBases('localToGlobal'));
    }

    // 为知识库列表容器绑定事件委托，避免重复绑定
    const kbContainers = ['hly-kb-list-local', 'hly-kb-list-global'];
    kbContainers.forEach(id => {
        const container = document.getElementById(id);
        if (container) {
            container.addEventListener('click', handleKbAction);
            container.addEventListener('change', handleKbAction);
        }
    });

    // 为多选工具栏绑定事件
    document.getElementById('hly-kb-select-all-global').addEventListener('change', (e) => handleSelectAll(e, 'global'));
    document.getElementById('hly-kb-select-all-local').addEventListener('change', (e) => handleSelectAll(e, 'local'));
    document.getElementById('hly-kb-bulk-actions-global').addEventListener('click', (e) => handleBulkAction(e, 'global'));
    document.getElementById('hly-kb-bulk-actions-local').addEventListener('click', (e) => handleBulkAction(e, 'local'));
}

function initializeUnifiedInjectionEditor() {
    const sourceSelector = document.getElementById('hly-injection-source-selector');
    const templateEditor = document.getElementById('hly-unified-template-editor');
    const templateNotes = document.getElementById('hly-unified-template-notes');
    const positionRadios = document.querySelectorAll('input[name="hly-unified-injection-position"]');
    const depthInput = document.getElementById('hly-unified-injection-depth');
    const roleSelect = document.getElementById('hly-unified-injection-role');

    if (!sourceSelector) return; // 如果关键元素不存在，则中止

    const placeholderMap = {
        novel: '{{novel_text}}',
        chat: '{{chat_text}}',
        lorebook: '{{lorebook_text}}',
        manual: '{{manual_text}}'
    };

    function updateView() {
        const source = sourceSelector.value;
        const settings = HanlinyuanCore.getSettings();
        const sourceSettings = settings[`injection_${source}`] || {};

        // 从设置加载值，如果未定义则提供默认值
        templateEditor.value = sourceSettings.template || '';
        setVectorText(templateNotes, 'vectorUi.placeholderHelp', { p0: placeholderMap[source] || '{{text}}' });

        const position = sourceSettings.position !== undefined ? String(sourceSettings.position) : '2';
        positionRadios.forEach(radio => radio.checked = radio.value === position);

        depthInput.value = sourceSettings.depth || 0;
        roleSelect.value = sourceSettings.depth_role !== undefined ? String(sourceSettings.depth_role) : '0';

        // 更新深度/角色控件的可用状态
        const isChatMode = position === '1';
        depthInput.disabled = !isChatMode;
        roleSelect.disabled = !isChatMode;
    }

    function saveSettings() {
        const source = sourceSelector.value;

        updateAndSaveSetting(`injection_${source}.template`, templateEditor.value);

        const selectedPosition = document.querySelector('input[name="hly-unified-injection-position"]:checked');
        if (selectedPosition) {
            updateAndSaveSetting(`injection_${source}.position`, parseInt(selectedPosition.value, 10));
        }

        updateAndSaveSetting(`injection_${source}.depth`, parseInt(depthInput.value, 10));
        updateAndSaveSetting(`injection_${source}.depth_role`, parseInt(roleSelect.value, 10));
    }

    // 绑定事件监听器
    sourceSelector.addEventListener('change', updateView);

    // 使用 debounce 避免过于频繁的保存操作
    const debouncedSave = debounce(saveSettings, 300);

    templateEditor.addEventListener('input', debouncedSave);
    depthInput.addEventListener('change', saveSettings);
    roleSelect.addEventListener('change', saveSettings);
    positionRadios.forEach(radio => radio.addEventListener('change', () => {
        saveSettings();
        // 立即更新UI状态以获得即时反馈
        const isChatMode = radio.value === '1' && radio.checked;
        depthInput.disabled = !isChatMode;
        roleSelect.disabled = !isChatMode;
    }));

    // 初始加载时更新视图
    updateView();
}

function handleApiModeChange() {
    const endpoint = document.getElementById('hly-api-endpoint').value;
    const urlDocket = document.getElementById('hly-custom-endpoint-docket');
    const keyDocket = document.getElementById('hly-api-key-group');
    const modelSelect = document.getElementById('hly-embedding-model');
    const modelLabel = modelSelect.previousElementSibling;

    if (!urlDocket || !keyDocket) return;

    // 默认都显示
    urlDocket.style.display = 'block';
    keyDocket.style.display = 'block';

    // 根据模式调整
    switch (endpoint) {
        case 'google_direct':
            // Google模式下，URL是固定的，所以隐藏URL输入框
            urlDocket.style.display = 'none';
            setVectorText(keyDocket.querySelector('label'), 'vectorUi.googleKeyLabel');
            setVectorText(keyDocket.querySelector('input'), 'vectorUi.googleKeyPlaceholder', {}, 'placeholder');
            break;
        case 'local_proxy':
            setVectorText(urlDocket.querySelector('label'), 'vectorUi.proxyUrlLabel');
            setVectorText(urlDocket.querySelector('input'), 'vectorUi.proxyUrlPlaceholder', {}, 'placeholder');
            // 本地代理通常不需要key
            keyDocket.style.display = 'none';
            break;
        case 'custom':
        default:
            setVectorText(urlDocket.querySelector('label'), 'vectorUi.customUrlLabel');
            setVectorText(urlDocket.querySelector('input'), 'vectorUi.customUrlPlaceholder', {}, 'placeholder');
            setVectorText(keyDocket.querySelector('label'), 'vectorUi.tokenLabel');
            break;
    }
}

export function loadSettingsToUI() {
    const settings = HanlinyuanCore.getSettings();
    if (!settings) return;

    // 检索设置
    document.getElementById('hly-retrieval-enabled').checked = settings.retrieval.enabled;
    document.getElementById('hly-api-endpoint').value = settings.retrieval.apiEndpoint;
    document.getElementById('hly-custom-api-url').value = settings.retrieval.customApiUrl;
    clearSecretInput(document.getElementById('hly-api-key'), Boolean(settings.retrieval.apiKey));
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

    // 注入设定的加载已由 initializeUnifiedInjectionEditor 函数处理

    handleApiModeChange(); // 根据加载的API模式更新UI

    // 凝识设置
    document.getElementById('hly-condensation-enabled').checked = settings.condensation.enabled;
    document.getElementById('hly-auto-condense-toggle').checked = settings.condensation.autoCondense;
    document.getElementById('hly-preserve-floors').value = settings.condensation.preserveFloors;
    document.getElementById('hly-layer-start').value = settings.condensation.layerStart;
    document.getElementById('hly-layer-end').value = settings.condensation.layerEnd;
    document.getElementById('hly-include-user').checked = settings.condensation.messageTypes.user;
    document.getElementById('hly-include-ai').checked = settings.condensation.messageTypes.ai;
    
    // 史官设置
    const histMaxRetriesEl = document.getElementById('historiography_max_retries');
    if (histMaxRetriesEl) {
        histMaxRetriesEl.value = settings.historiographyMaxRetries ?? 2;
    }

    // 标签提取开关/输入框已在 2.1.0 重构中移除（改为规则配置下拉选单），
    // 这里不再回填对应 DOM，避免因元素已不存在导致 loadSettingsToUI 中断。

    // Rerank 设置
    document.getElementById('hly-rerank-enabled').checked = settings.rerank.enabled;
    /** @type {HTMLSelectElement} */ (document.getElementById('hly-rerank-api-mode')).value = settings.rerank.apiMode ?? 'custom';
    document.getElementById('hly-rerank-url').value = settings.rerank.url;
    clearSecretInput(document.getElementById('hly-rerank-api-key'), Boolean(settings.rerank.apiKey));
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
    document.getElementById('hly-super-sort-enabled').checked = settings.rerank.superSortEnabled;

    // 新增：加载优先检索设置
    const prioritySettings = settings.rerank.priorityRetrieval;
    if (prioritySettings) {
        document.getElementById('hly-priority-retrieval-enabled').checked = prioritySettings.enabled;

        const sources = ['novel', 'chat_history', 'lorebook', 'manual'];
        sources.forEach(source => {
            const sourceSettings = prioritySettings.sources?.[source];
            if (sourceSettings) {
                const enabledCheckbox = document.querySelector(`[data-setting-key="rerank.priorityRetrieval.sources.${source}.enabled"]`);
                const countInput = document.querySelector(`[data-setting-key="rerank.priorityRetrieval.sources.${source}.count"]`);
                if (enabledCheckbox) enabledCheckbox.checked = sourceSettings.enabled;
                if (countInput) countInput.value = sourceSettings.count;
            }
        });
    }

    // 新增：加载检索预处理设置
    if (settings.queryPreprocessing) {
        document.getElementById('hly-query-preprocessing-enabled').checked = settings.queryPreprocessing.enabled;
    }

    // 新增：加载独立聊天记忆开关状态
    if (settings.retrieval.independentChatMemoryEnabled !== undefined) {
        document.getElementById('hly-independent-chat-memory-enabled').checked = settings.retrieval.independentChatMemoryEnabled;
    }
}

function saveSettingsFromUI(isAutoSave = true) {
    const container = document.getElementById('hly-modal-container');
    if (!container) return;

    const inputs = container.querySelectorAll('[data-setting-key]');

    inputs.forEach(target => {
        const key = target.dataset.settingKey;
        if (!key) return;

        // 被 profile-sync 接管的字段（祖先元素带 data-profile-hidden）会被填充
        // MASKED_KEY 占位符并隐藏，若一并写回会污染 settings.{rerank,retrieval}.apiKey
        // 等字段为 '••••••••'，导致取消 Profile 分配后实际请求带占位符 token 被 401。
        if (target.closest('[data-profile-hidden]')) return;

        let value;
        const type = target.dataset.type || 'string';

        if (target.type === 'checkbox') {
            value = target.checked;
        } else if (target.type === 'radio') {
            if (!target.checked) return; // 只处理选中的radio
            value = target.value;
        } else {
            value = target.value;
            if (target.type === 'password') {
                const update = readSecretInputUpdate(target);
                if (!update.changed) return;
                value = update.value;
            }
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

        // 特殊处理史官设置
        if (key === 'historiographyMaxRetries') {
            const extSettings = extension_settings[extensionName] || {};
            extSettings.historiographyMaxRetries = value;
            saveSettingsDebounced();
            return;
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
        vectorToast('success', t('vectorUi.settingsSaved'), t('vectorUi.noticeDone'));
    }
    // 自动保存的日志已在 updateAndSaveSetting 中处理，此处不再重复
}

function resetSettingsToUI() {
    if (confirm(t('vectorUi.resetPrompt'))) {
        HanlinyuanCore.resetSettings();
        loadSettingsToUI();
        vectorToast('info', t('vectorUi.settingsReset'), t('vectorUi.noticeAnnounce'));
    }
}

async function updatePanelStatus() {
    // 根据锁定状态更新显示
    const isLocked = HanlinyuanCore.isSessionLocked();
    const charNameEl = document.getElementById('hly-current-character-name');
    const chatIdEl = document.getElementById('hly-current-chat-id');

    if (isLocked) {
        const lockedInfo = HanlinyuanCore.getLockedSessionInfo();
        if (lockedInfo) {
            setVectorText(charNameEl, 'vectorUi.sessionLocked');
            clearVectorBinding(chatIdEl);
            chatIdEl.textContent = lockedInfo.id;
            setVectorText(chatIdEl, 'vectorUi.lockedTargetTip', { p0: lockedInfo.id }, 'title');
            charNameEl.classList.add('hly-locked-status');
            chatIdEl.classList.add('hly-locked-status');
        }
    } else {
        clearVectorBinding(charNameEl);
        charNameEl.textContent = ContextUtils.getCharacterName();
        setVectorValueOrFallback(chatIdEl, ContextUtils.getChatId(), 'vectorUi.none');
        clearVectorBinding(chatIdEl, 'title');
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
        setVectorText(countEl, 'vectorUi.countFailed', { p0: error.message }, 'title');
    }

    // 显示上次凝识记录
    const recordEl = document.getElementById('hly-condensation-results');
    // 只有在没有进行中的预览时才更新记录
    if (recordEl && !recordEl.dataset.finalText) {
        const settings = HanlinyuanCore.getSettings();
        const collectionId = await HanlinyuanCore.getCollectionId();

        if (settings.condensationHistory && settings.condensationHistory[collectionId]) {
            const record = settings.condensationHistory[collectionId];
            // V5.4 - record.end is now always a number, so the text is simpler.
            recordEl.innerHTML = `<p class="hly-record-hint"><i>${vectorHtml('vectorUi.lastCondensation', { start: record.start, end: record.end })}</i></p>`;
        } else {
            recordEl.innerHTML = `<p class="hly-record-hint">${vectorHtml('vectorUi.previewHint')}</p>`;
        }
    }

    // 最后，渲染知识库列表
    renderKnowledgeBases();
}

async function moveAllKnowledgeBases(direction) {
    const isMovingToLocal = direction === 'globalToLocal';
    const sourceScope = isMovingToLocal ? 'global' : 'local';
    const targetScope = isMovingToLocal ? t('vectorUi.localScope') : t('vectorUi.globalScope');
    const sourceKbs = isMovingToLocal ? HanlinyuanCore.getGlobalKnowledgeBases() : HanlinyuanCore.getLocalKnowledgeBases();
    const kbIds = Object.keys(sourceKbs);

    if (kbIds.length === 0) {
        vectorToast('info', t('vectorUi.nothingToMove', { p0: isMovingToLocal ? t('vectorUi.globalScope') : t('vectorUi.localScope') }), t('vectorUi.noticeInfo'));
        return;
    }

    if (!confirm(t('vectorUi.moveAllPrompt', { p0: kbIds.length, p1: isMovingToLocal ? t('vectorUi.globalScope') : t('vectorUi.localScope'), p2: targetScope }))) {
        return;
    }

    log(`开始将 ${kbIds.length} 个知识库从 ${sourceScope} 移动到 ${isMovingToLocal ? 'local' : 'global'}...`, 'info');

    const movePromises = kbIds.map(kbId => HanlinyuanCore.moveKnowledgeBase(kbId, sourceScope));

    try {
        await Promise.all(movePromises);
        vectorToast('success', t('vectorUi.allMoved', { p0: kbIds.length }), t('vectorUi.success'));
        log(`批量移动完成。`, 'success');
    } catch (error) {
        vectorToast('error', t('vectorUi.bulkMoveFailed', { p0: error.message }), t('vectorUi.alert'));
        log(`批量移动失败: ${error.message}`, 'error');
    } finally {
        await updatePanelStatus();
    }
}
async function deleteAllLocalKnowledgeBases() {
    const localKbs = HanlinyuanCore.getLocalKnowledgeBases();
    const kbIds = Object.keys(localKbs);

    if (kbIds.length === 0) {
        vectorToast('info', t('vectorUi.nothingToDelete'), t('vectorUi.noticeInfo'));
        return;
    }

    if (!confirm(t('vectorUi.deleteAllPrompt', { p0: kbIds.length }))) {
        return;
    }

    vectorToast('info', t('vectorUi.deletingLocal', { p0: kbIds.length }), t('vectorUi.notice'));
    log(`开始批量删除 ${kbIds.length} 个局部知识库...`, 'warn');

    let successCount = 0;
    let errorCount = 0;

    for (const kbId of kbIds) {
        try {
            // 明确指定 scope 为 'local'
            await HanlinyuanCore.removeKnowledgeBase(kbId, 'local');
            successCount++;
        } catch (error) {
            errorCount++;
            log(`删除局部知识库 ${kbId} 失败: ${error.message}`, 'error');
        }
    }

    if (errorCount > 0) {
        vectorToast('error', t('vectorUi.partialDelete', { p0: errorCount }), t('vectorUi.alert'));
    } else {
        vectorToast('success', t('vectorUi.allDeleted', { p0: successCount }), t('vectorUi.success'));
    }

    log(`局部知识库批量删除完成。成功: ${successCount}, 失败: ${errorCount}`, 'info');
    await updatePanelStatus();
}

async function renderKnowledgeBases() {
    const localContainer = document.getElementById('hly-kb-list-local');
    const globalContainer = document.getElementById('hly-kb-list-global');
    const localCharNameEl = document.getElementById('hly-local-kb-char-name');

    if (!localContainer || !globalContainer || !localCharNameEl) return;

    // 更新局部知识库标题中的角色名
    setVectorValueOrFallback(localCharNameEl, ContextUtils.getCharacterName(), 'vectorUi.currentCharacter');

    try {
        const localKbs = HanlinyuanCore.getLocalKnowledgeBases();
        const globalKbs = HanlinyuanCore.getGlobalKnowledgeBases();

        // 渲染局部知识库
        await _renderKbList(localKbs, localContainer, 'local', 'hly-kb-list-local-placeholder');
        // 渲染全局知识库
        await _renderKbList(globalKbs, globalContainer, 'global', 'hly-kb-list-global-placeholder');

    } catch (error) {
        console.error('[翰林院-枢纽] 渲染知识库列表失败:', error);
        localContainer.innerHTML = `<p class="hly-notes log-error"><i>${vectorHtml('vectorUi.loadError', { error: error.message })}</i></p>`;
        globalContainer.innerHTML = `<p class="hly-notes log-error"><i>${vectorHtml('vectorUi.loadError', { error: error.message })}</i></p>`;
    }
}


async function _renderKbList(kbs, container, scope, placeholderId) {
    const placeholder = document.getElementById(placeholderId);
    container.innerHTML = ''; // 清空
    container.appendChild(placeholder); // 先把占位符加回去

    if (Object.keys(kbs).length === 0) {
        placeholder.style.display = 'block';
        return;
    }

    placeholder.style.display = 'none';

    // 分组逻辑：找出自动凝识的记录
    const autoCondenseGroup = [];
    const otherKbs = [];

    for (const [id, kb] of Object.entries(kbs)) {
        if (kb.name && kb.name.includes(': 自动凝识 (')) {
            autoCondenseGroup.push({ id, ...kb });
        } else {
            otherKbs.push({ id, ...kb });
        }
    }

    // 渲染自动凝识分组（如果有）
    if (autoCondenseGroup.length > 0) {
        const groupItem = document.createElement('div');
        groupItem.className = 'hly-kb-group-item';

        // 计算组内总向量数和启用状态
        let totalVectors = 0;
        let allEnabled = true;

        // 预先获取所有向量数（并行）
        const countPromises = autoCondenseGroup.map(kb => HanlinyuanCore.getVectorCount(kb.id, scope));
        const counts = await Promise.all(countPromises);

        autoCondenseGroup.forEach((kb, index) => {
            kb.vectorCount = counts[index];
            totalVectors += counts[index];
            if (!kb.enabled) allEnabled = false;
        });

        // 排序：按楼层顺序 (假设名字里有数字)
        autoCondenseGroup.sort((a, b) => {
            const matchA = a.name.match(/\((\d+)-/);
            const matchB = b.name.match(/\((\d+)-/);
            if (matchA && matchB) {
                return parseInt(matchA[1]) - parseInt(matchB[1]);
            }
            return a.name.localeCompare(b.name);
        });

        const groupHtml = `
            <details class="hly-kb-group-details">
                <summary class="hly-kb-group-summary">
                    <span class="hly-kb-group-title"><i class="fas fa-folder"></i> ${vectorHtml('vectorUi.autoGroup', { chunks: autoCondenseGroup.length, count: totalVectors })}</span>
                </summary>
                <div class="hly-kb-group-content">
                    <!-- 子项目将在这里渲染 -->
                </div>
            </details>
        `;
        groupItem.innerHTML = groupHtml;
        container.appendChild(groupItem);

        const groupContent = groupItem.querySelector('.hly-kb-group-content');

        for (const kb of autoCondenseGroup) {
            const item = _createKbItemElement(kb.id, kb, scope, kb.vectorCount);
            groupContent.appendChild(item);
        }
    }

    // 渲染其他普通知识库
    for (const kb of otherKbs) {
        const vectorCount = await HanlinyuanCore.getVectorCount(kb.id, scope);
        const item = _createKbItemElement(kb.id, kb, scope, vectorCount);
        container.appendChild(item);
    }
}

function _createKbItemElement(id, kb, scope, vectorCount) {
    const item = document.createElement('div');
    item.className = 'hly-kb-list-item';
    item.dataset.kbId = id;
    item.dataset.kbScope = scope;

    const moveButtonHtml = scope === 'local'
        ? `<button class="hly-kb-move-btn" ${vectorTitle("vectorUi.moveUpTip")}><i class="fas fa-arrow-up"></i></button>`
        : `<button class="hly-kb-move-btn" ${vectorTitle("vectorUi.moveDownTip")}><i class="fas fa-arrow-down"></i></button>`;

    // 聊天级库（独立聊天记忆产物）标记：仅所属聊天可检索
    const chatBadgeHtml = kb.chatId
        ? `<span ${vectorTitle('vectorUi.chatOnlyTip', { chatId: kb.chatId })} style="font-size: 0.8em; padding: 0 5px; border-radius: 3px; background: rgba(88,166,255,0.25); margin-left: 4px; white-space: nowrap;"><i class="fas fa-comment"></i> ${vectorHtml('vectorUi.chatOnly')}</span>`
        : '';

    item.innerHTML = `
        <div class="hly-kb-name-container">
            <input type="checkbox" class="hly-kb-item-checkbox" data-kb-id="${escapeAttribute(id)}">
            <span class="hly-kb-name" title="ID: ${escapeAttribute(id)}">${escapeTextareaContent(kb.name || '')} ${vectorHtml('vectorUi.recordCount', { count: Number(vectorCount) || 0 })}</span>${chatBadgeHtml}
        </div>
        <div class="hly-kb-actions">
            ${moveButtonHtml}
            <button class="hly-kb-rename-btn" ${vectorTitle("vectorUi.renameTip")}><i class="fas fa-pen-to-square"></i></button>
            <label class="hly-toggle-switch" ${vectorTitle("vectorUi.toggleTip")}>
                <input type="checkbox" class="hly-kb-toggle" ${kb.enabled ? 'checked' : ''}>
                <span class="hly-toggle-slider"></span>
            </label>
            <button class="hly-kb-delete-btn" ${vectorTitle("vectorUi.deleteKnowledgeTip")}>&times;</button>
        </div>
    `;
    return item;
}

async function handleKbAction(event) {
    const target = event.target;
    const listItem = target.closest('.hly-kb-list-item');
    if (!listItem) return;

    const kbId = listItem.dataset.kbId;
    const scope = listItem.dataset.kbScope;
    const kbName = listItem.querySelector('.hly-kb-name').textContent.split(' (')[0];

    // 重命名操作
    if (target.closest('.hly-kb-rename-btn')) {
        const currentName = listItem.querySelector('.hly-kb-name').textContent.split(' (')[0];
        const newName = prompt(t('vectorUi.renamePrompt'), currentName);

        if (newName && newName.trim() && newName.trim() !== currentName) {
            try {
                await HanlinyuanCore.renameKnowledgeBase(kbId, newName, scope);
                // 重命名成功后直接刷新整个面板
                await updatePanelStatus();
            } catch (error) {
                log(`重命名知识库 ${currentName} 失败: ${error.message}`, 'error');
                vectorToast('error', t('vectorUi.renameFailed', { p0: error.message }));
            }
        }
        return; // 处理完重命名后退出，避免触发其他逻辑
    }

    // 删除操作
    if (target.classList.contains('hly-kb-delete-btn')) {
        if (confirm(t('vectorUi.deletePrompt', { p0: kbName }))) {
            try {
                await HanlinyuanCore.removeKnowledgeBase(kbId, scope);
                log(`知识库 ${kbName} (ID: ${kbId}) 已被删除`, 'success');
                vectorToast('success', t('vectorUi.deleted', { p0: kbName }));
                await updatePanelStatus();
            } catch (error) {
                log(`删除知识库 ${kbName} 失败: ${error.message}`, 'error');
                vectorToast('error', t('vectorUi.deleteFailed', { p0: error.message }));
            }
        }
    }

    // 移动操作
    if (target.closest('.hly-kb-move-btn')) {
        const direction = scope === 'local' ? t('vectorUi.globalScope') : t('vectorUi.localScope');
        if (confirm(t('vectorUi.movePrompt', { p0: kbName, p1: direction }))) {
            try {
                await HanlinyuanCore.moveKnowledgeBase(kbId, scope);
                await updatePanelStatus();
            } catch (error) {
                log(`移动知识库 ${kbName} 失败: ${error.message}`, 'error');
                vectorToast('error', t('vectorUi.moveFailed', { p0: error.message }));
            }
        }
    }

    // 启用/禁用操作
    if (target.classList.contains('hly-kb-toggle') && event.type === 'change') {
        try {
            await HanlinyuanCore.toggleKnowledgeBase(kbId, scope);
            log(`知识库 ${kbName} 的状态已切换`, 'success');
            // 只更新UI，不完全重载，避免勾选状态丢失
            // await updatePanelStatus(); 
        } catch (error) {
            log(`切换知识库 ${kbName} 状态失败: ${error.message}`, 'error');
            vectorToast('error', t('vectorUi.toggleFailed', { p0: error.message }));
            // 切换失败时，恢复UI状态
            target.checked = !target.checked;
        }
    }

    // 多选框勾选操作
    if (target.classList.contains('hly-kb-item-checkbox') && event.type === 'change') {
        updateBulkActionUI(scope);
    }
}

function handleSelectAll(event, scope) {
    const isChecked = event.target.checked;
    const container = document.getElementById(`hly-kb-list-${scope}`);
    const itemCheckboxes = container.querySelectorAll('.hly-kb-item-checkbox');
    itemCheckboxes.forEach(cb => cb.checked = isChecked);
    updateBulkActionUI(scope);
}
function updateBulkActionUI(scope) {
    const container = document.getElementById(`hly-kb-list-${scope}`);
    const bulkActions = document.getElementById(`hly-kb-bulk-actions-${scope}`);
    const selectAllCheckbox = document.getElementById(`hly-kb-select-all-${scope}`);

    const itemCheckboxes = container.querySelectorAll('.hly-kb-item-checkbox');
    const selectedCheckboxes = container.querySelectorAll('.hly-kb-item-checkbox:checked');

    const selectedCount = selectedCheckboxes.length;
    const totalCount = itemCheckboxes.length;

    if (selectedCount > 0) {
        bulkActions.style.display = 'flex';
    } else {
        bulkActions.style.display = 'none';
    }

    if (totalCount === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === totalCount) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else if (selectedCount > 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    }
}

async function handleBulkAction(event, scope) {
    const action = event.target.dataset.action;
    if (!action) return;

    const container = document.getElementById(`hly-kb-list-${scope}`);
    const selectedCheckboxes = container.querySelectorAll('.hly-kb-item-checkbox:checked');
    const selectedIds = Array.from(selectedCheckboxes).map(cb => cb.dataset.kbId);

    if (selectedIds.length === 0) {
        vectorToast('warning', t('vectorUi.selectKnowledgeFirst'), t('vectorUi.noticeInfo'));
        return;
    }

    let confirmMessage = '';
    let actionFunction;
    let successMessage = '';

    switch (action) {
        case 'delete':
            confirmMessage = t('vectorUi.bulkDeletePrompt', { p0: selectedIds.length });
            actionFunction = (id) => HanlinyuanCore.removeKnowledgeBase(id, scope);
            successMessage = t('vectorUi.bulkDeleted', { p0: selectedIds.length });
            break;
        case 'move':
            const direction = scope === 'local' ? t('vectorUi.globalScope') : t('vectorUi.localScope');
            confirmMessage = t('vectorUi.bulkMovePrompt', { p0: selectedIds.length, p1: direction });
            actionFunction = (id) => HanlinyuanCore.moveKnowledgeBase(id, scope);
            successMessage = t('vectorUi.bulkMoved', { p0: selectedIds.length });
            break;
        case 'toggle':
            confirmMessage = t('vectorUi.bulkTogglePrompt', { p0: selectedIds.length });
            actionFunction = (id) => HanlinyuanCore.toggleKnowledgeBase(id, scope);
            successMessage = t('vectorUi.bulkToggled', { p0: selectedIds.length });
            break;
        default:
            return;
    }

    if (!confirm(confirmMessage)) {
        return;
    }

    vectorToast('info', t('vectorUi.bulkWorking', { p0: selectedIds.length }), t('vectorUi.notice'));
    log(`开始对 ${selectedIds.length} 个知识库 (范围: ${scope}) 执行批量 ${action} 操作...`, 'info');

    try {
        const promises = selectedIds.map(id => actionFunction(id));
        await Promise.all(promises);
        vectorToast('success', successMessage, t('vectorUi.success'));
        log(`批量 ${action} 操作成功。`, 'success');
    } catch (error) {
        vectorToast('error', t('vectorUi.bulkFailed', { p0: error.message }), t('vectorUi.alert'));
        log(`批量 ${action} 操作失败: ${error.message}`, 'error');
    } finally {
        await updatePanelStatus(); // 刷新整个面板以显示最新状态
    }
}

async function testApi() {
    vectorToast('info', t('vectorUi.testing'), t('vectorUi.notice'));
    try {
        await HanlinyuanCore.testApiConnection();
        vectorToast('success', t('vectorUi.connectionSuccess'), t('vectorUi.noticeSuccess'));
    } catch (error) {
        vectorToast('error', t('vectorUi.connectionFailed', { p0: error.message }), t('vectorUi.alert'));
    }
}

async function fetchHLYEmbeddingModels() {
    const modelSelect = document.getElementById('hly-embedding-model');
    const currentModel = modelSelect.value; // 保存当前选中的模型
    modelSelect.innerHTML = vectorOption('vectorUi.fetchingModels', '正在获取...');
    modelSelect.disabled = true;

    try {
        log('开始获取模型列表...', 'info');
        const models = await HanlinyuanCore.fetchEmbeddingModels();
        modelSelect.innerHTML = ''; // 清空

        if (models.length === 0) {
            modelSelect.innerHTML = vectorOption('vectorUi.noModels', '未找到模型');
            vectorToast('warn', t('vectorUi.noModelsNotice'), t('vectorUi.noticeModule'));
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

        vectorToast('success', t('vectorUi.modelsFetched', { p0: models.length }), t('vectorUi.noticeSuccess'));
        log(`成功获取 ${models.length} 个模型。`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 获取模型列表失败:', error);
        vectorToast('error', t('vectorUi.modelsFailed', { p0: error.message }), t('vectorUi.seriousError'));
        log(`获取模型失败: ${error.message}`, 'error');
        modelSelect.innerHTML = vectorOption('vectorUi.fetchFailed', '获取失败');
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
    modelSelect.innerHTML = vectorOption('vectorUi.fetchingModels', '正在获取...');
    modelSelect.disabled = true;

    try {
        log('开始获取Rerank模型列表...', 'info');
        const models = await HanlinyuanCore.fetchRerankModels();
        modelSelect.innerHTML = '';

        if (models.length === 0) {
            modelSelect.innerHTML = vectorOption('vectorUi.noModels', '未找到模型');
            vectorToast('warn', t('vectorUi.noRerankModels'), t('vectorUi.noticeModule'));
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

        vectorToast('success', t('vectorUi.rerankModelsFetched', { p0: models.length }), t('vectorUi.noticeSuccess'));
        log(`成功获取 ${models.length} 个Rerank模型。`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 获取Rerank模型列表失败:', error);
        vectorToast('error', t('vectorUi.rerankModelsFailed', { p0: error.message }), t('vectorUi.seriousError'));
        log(`获取Rerank模型失败: ${error.message}`, 'error');
        modelSelect.innerHTML = vectorOption('vectorUi.fetchFailed', '获取失败');
    } finally {
        modelSelect.disabled = false;
    }
}

async function purgeStorage() {
    if (confirm(t('vectorUi.purgePrompt'))) {
        vectorToast('info', t('vectorUi.purging'), t('vectorUi.notice'));
        const success = await HanlinyuanCore.purgeStorage();
        if (success) {
            vectorToast('success', t('vectorUi.purged'), t('vectorUi.noticeSuccess'));
        } else {
            vectorToast('error', t('vectorUi.purgeFailed'), t('vectorUi.alert'));
        }
        await updatePanelStatus();
    }
}

async function startCondensation() {
    const resultsEl = document.getElementById('hly-condensation-results');
    const preprocessedMessagesJSON = resultsEl.dataset.finalMessages;

    const layerStart = document.getElementById('hly-layer-start').value;
    const layerEnd = document.getElementById('hly-layer-end').value;
    const range = { start: parseInt(layerStart), end: parseInt(layerEnd) };

    try {
        let messagesToProcess;

        // 【V6 重构】路径判断：是处理预览后的消息对象数组，还是重新采集
        if (preprocessedMessagesJSON) {
            log('检测到预览后待处理的消息对象，开始精确凝识...', 'info');
            vectorToast('info', t('vectorUi.processingConfirmed'), t('vectorUi.notice'));
            messagesToProcess = JSON.parse(preprocessedMessagesJSON);
            delete resultsEl.dataset.finalMessages; // 清理暂存数据
        } else {
            log('未检测到预览文本，按标准流程采集消息...', 'info');
            vectorToast('info', t('vectorUi.preparingCondensation'), t('vectorUi.notice'));
            messagesToProcess = HanlinyuanCore.getMessagesForCondensation();
        }

        if (!messagesToProcess || messagesToProcess.length === 0) {
            vectorToast('warning', t('vectorUi.noCondensationMessages'), t('vectorUi.noticeModule'));
            setVectorText(resultsEl, 'vectorUi.noMessages');
            return;
        }

        setVectorText(resultsEl, 'vectorUi.messagesCollected', { p0: messagesToProcess.length });
        vectorToast('info', t('vectorUi.messagesCollected', { p0: messagesToProcess.length }), t('vectorUi.noticeModule'));

        // 统一调用 processCondensation，它现在能处理任何符合格式的消息数组
        const result = await HanlinyuanCore.processCondensation(messagesToProcess, log, range);

        if (result.success) {
            vectorToast('success', t('vectorUi.condensationComplete', { p0: result.count }), t('vectorUi.success'));
            const finalEnd = range.end === 0 ? getContext().chat.length : range.end;
            setVectorText(resultsEl, 'vectorUi.condensationResult', { p0: range.start, p1: finalEnd, p2: result.count });
        } else {
            throw new Error(result.error || '未知错误');
        }

    } catch (error) {
        console.error('[翰林院-枢纽] 凝识过程发生错误:', error);
        vectorToast('error', t('vectorUi.condensationFailed', { p0: error.message }), t('vectorUi.seriousError'));
        setVectorText(resultsEl, 'vectorUi.condensationFailed', { p0: error.message });
    } finally {
        await updatePanelStatus();
    }
}

async function loadWorldbookList() {
    const selectEl = document.getElementById('hly-hist-select-library');
    const searchInput = document.getElementById('hly-worldbook-search');
    if (!selectEl) return;

    try {
        log('正在获取可用书库列表...', 'info');
        const books = await Historiographer.getAvailableWorldbooks();

        // 存储所有书库数据以供搜索使用
        window.allWorldbooks = books;

        // 初始化世界书选项
        updateWorldbookOptions(selectEl, '', books);

        // 绑定搜索事件
        if (searchInput) {
            const debouncedSearch = debounce((query) => {
                updateWorldbookOptions(selectEl, query, books);
            }, 300);

            searchInput.addEventListener('input', (e) => {
                debouncedSearch(e.target.value);
            });
        }

        log(`成功加载 ${books.length} 个书库。`, 'success');
    } catch (error) {
        console.error('[翰林院-枢纽] 加载书库列表失败:', error);
        log(`加载书库列表失败: ${error.message}`, 'error');
        if (selectEl) {
            selectEl.innerHTML = vectorOption('vectorUi.loadFailed', '');
        }
    }
}

function updateWorldbookOptions(selectElement, query, allBooks) {
    const filteredBooks = filterWorldbooks(query, allBooks);
    const currentValue = selectElement.value;

    // 清空并重新填充
    selectElement.innerHTML = vectorOption('vectorUi.chooseLibrary', '');

    if (filteredBooks.length === 0) {
        selectElement.innerHTML = query.trim() ?
            vectorOption('vectorUi.noMatchingLibrary', '') :
            vectorOption('vectorUi.noLibraries', '');
        return;
    }

    filteredBooks.forEach(bookName => {
        const option = document.createElement('option');
        option.value = bookName;
        option.textContent = bookName;
        selectElement.appendChild(option);
    });

    // 恢复选择
    if (currentValue && filteredBooks.includes(currentValue)) {
        selectElement.value = currentValue;
    }
}

async function handleWorldbookSelectionChange() {
    const librarySelect = document.getElementById('hly-hist-select-library');
    const multiSelectBtn = document.getElementById('hly-hist-entry-multiselect-btn');
    const optionsContainer = document.getElementById('hly-hist-entry-multiselect-options');
    const entrySearchInput = document.getElementById('hly-entry-search');
    const selectedBook = librarySelect.value;

    // 重置状态
    multiSelectBtn.disabled = true;
    setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.loadingEntries');
    optionsContainer.innerHTML = '';
    optionsContainer.style.display = 'none';

    if (entrySearchInput) {
        entrySearchInput.value = '';
    }

    if (!selectedBook) {
        setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.chooseLibraryFirst');
        return;
    }

    try {
        log(`正在为《${selectedBook}》获取条目列表...`, 'info');
        const entries = await Historiographer.getLoresForWorldbook(selectedBook);

        if (entries.length === 0) {
            setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.emptyLibrary');
            return;
        }

        // 存储所有条目以供搜索使用
        window.allEntries = entries;

        // 初始化条目选项
        updateEntryOptions('', entries);

        // 绑定条目搜索事件
        if (entrySearchInput) {
            // 移除之前的事件监听器（如果有）
            entrySearchInput.removeEventListener('input', entrySearchInput._searchHandler);

            const debouncedEntrySearch = debounce((query) => {
                updateEntryOptions(query, entries);
            }, 300);

            entrySearchInput._searchHandler = (e) => {
                debouncedEntrySearch(e.target.value);
            };

            entrySearchInput.addEventListener('input', entrySearchInput._searchHandler);
        }

        log(`成功加载 ${entries.length} 个条目。`, 'success');

    } catch (error) {
        console.error(`[翰林院-枢纽] 加载《${selectedBook}》的条目失败:`, error);
        log(`加载条目失败: ${error.message}`, 'error');
        setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.loadFailed');
    } finally {
        multiSelectBtn.disabled = false;
    }
}

function updateEntryOptions(query, allEntries) {
    const optionsContainer = document.getElementById('hly-hist-entry-multiselect-options');
    const multiSelectBtn = document.getElementById('hly-hist-entry-multiselect-btn');

    const filteredEntries = filterWorldbookEntries(query, allEntries);

    // 清空容器
    optionsContainer.innerHTML = '';

    // 添加全选选项
    const selectAllHtml = `
        <label class="hly-multiselect-option">
            <input type="checkbox" id="hly-hist-select-all-entries">
            <strong>${vectorHtml('vectorUi.selectAllEntries')}</strong>
        </label>`;
    optionsContainer.insertAdjacentHTML('beforeend', selectAllHtml);

    if (filteredEntries.length === 0) {
        const noResultsHtml = `<div class="hly-no-results">${vectorHtml('vectorUi.noMatchingEntries')}</div>`;
        optionsContainer.insertAdjacentHTML('beforeend', noResultsHtml);
        setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.noMatchingEntries');
        return;
    }

    // 添加过滤后的条目
    filteredEntries.forEach(entry => {
        const displayText = query ?
            highlightSearchMatch(entry.comment, query) :
            escapeTextareaContent(entry.comment);

        const optionHtml = `
            <label class="hly-multiselect-option" title="${escapeAttribute(entry.comment)} (Key: ${escapeAttribute(entry.key)})">
                <input type="checkbox" class="hly-hist-entry-checkbox" value="${escapeAttribute(entry.key)}">
                <span>${displayText}</span>
            </label>`;
        optionsContainer.insertAdjacentHTML('beforeend', optionHtml);
    });

    // 更新按钮文本
    setVectorText(multiSelectBtn.querySelector('span'), 'vectorUi.noEntriesSelected', { p0: filteredEntries.length });
}

/**
 * 【V9.1 重构】开始书库编纂的核心函数，支持多选
 */
async function startHistoriography() {
    const library = document.getElementById('hly-hist-select-library').value;
    const optionsContainer = document.getElementById('hly-hist-entry-multiselect-options');
    const resultsEl = document.getElementById('hly-historiography-results');

    const selectedEntries = Array.from(optionsContainer.querySelectorAll('.hly-hist-entry-checkbox:checked')).map(cb => cb.value);

    if (!library || selectedEntries.length === 0) {
        vectorToast('warning', t('vectorUi.chooseEntriesFirst'), t('vectorUi.noticeWarning'));
        return;
    }

    setVectorText(resultsEl, 'vectorUi.compilationPreparing', { p0: library, p1: selectedEntries.length });
    vectorToast('info', t('vectorUi.compilationStarted'), t('vectorUi.notice'));
    log(`开始对《${library}》中的 ${selectedEntries.length} 个条目进行编纂...`, 'info');

    try {
        const result = await Historiographer.executeCompilation(library, selectedEntries);

        clearVectorBinding(resultsEl);
        resultsEl.textContent = result.content; // 显示来自后端的详细报告

        if (result.success) {
            vectorToast('success', t('vectorUi.compilationCompleted'), t('vectorUi.success'));
        } else {
            vectorToast('warning', t('vectorUi.compilationPartial'), t('vectorUi.noticeInfo'));
        }
        log(`对《${library}》的批量编纂任务已完成。成功: ${result.totalSuccess}, 向量: ${result.totalVectors}`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 编纂过程发生严重错误:', error);
        vectorToast('error', t('vectorUi.compilationFailed', { p0: error.message }), t('vectorUi.seriousError'));
        setVectorText(resultsEl, 'vectorUi.compilationFailed', { p0: error.message });
    } finally {
        await updatePanelStatus();
    }
}
async function showStats() {
    try {
        log('用户请求查看宝库状态。', 'info');
        vectorToast('info', t('vectorUi.queryingStats'), t('vectorUi.notice'));

        const count = await HanlinyuanCore.getVectorCount();
        const collectionId = await HanlinyuanCore.getCollectionId();
        const settings = HanlinyuanCore.getSettings();

        // 使用 pre 标签来保持格式
        const statsText = `<pre>${vectorHtml('vectorUi.statsBody', {
            collectionId,
            count,
            endpoint: settings.retrieval.apiEndpoint,
            model: settings.retrieval.embeddingModel,
        })}</pre>`;

        toastr.info(statsText, escapeTextareaContent(t('vectorUi.statsTitle')), {
            escapeHtml: false,
            timeOut: 15000, // 延长显示时间
            extendedTimeOut: 5000,
            tapToDismiss: true,
            closeButton: true,
        });

        log(`查看宝库状态成功：集合ID=${collectionId}, 忆识总数=${count}`, 'success');

    } catch (error) {
        console.error('[翰林院-枢纽] 查询宝库状态失败:', error);
        vectorToast('error', t('vectorUi.statsFailed', { p0: error.message }), t('vectorUi.seriousError'));
        log(`查询宝库状态失败: ${error.message}`, 'error');
    }
}
function previewCondensation() {
    const resultsEl = document.getElementById('hly-condensation-results');
    try {
        // 1. 获取UI设置和新规则
        const settings = HanlinyuanCore.getSettings();
        const condensationRuleConfig = resolveCondensationRuleConfig(settings);
        const exclusionRules = condensationRuleConfig.exclusionRules || [];
        const overrideMessageTypes = {
            user: document.getElementById('hly-include-user').checked,
            ai: document.getElementById('hly-include-ai').checked,
        };
        const useTagExtraction = condensationRuleConfig.tagExtractionEnabled;
        const tagsToExtract = useTagExtraction
            ? (condensationRuleConfig.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            : [];

        // 2. 获取原始消息
        const messages = HanlinyuanCore.getMessagesForCondensation(overrideMessageTypes);

        if (!messages || messages.length === 0) {
            setVectorText(resultsEl, 'vectorUi.noPreviewMessages');
            vectorToast('warning', t('vectorUi.noMessages'), t('vectorUi.noticeModule'));
            return;
        }

        // 3. 处理消息内容
        const fullChat = getContext().chat;
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
                    if (blocks.length > 0) {
                        // 恢复逻辑：直接连接完整的块，保留标签
                        content = blocks.join('\n\n');
                    } else {
                        content = msg.mes; // 保留原始内容
                    }
                } else {
                    content = msg.mes;
                }
                // 内容排除规则只对AI消息生效
                content = applyExclusionRules(content, exclusionRules);
            }

            const floorIndex = fullChat.findIndex(chatMsg => chatMsg === msg);
            const floor = floorIndex !== -1 ? floorIndex + 1 : -1;

            return {
                id: `preview-item-${index}`,
                name: msg.name,
                content: content.trim(),
                floor: floor, // 【V6 新增】保留绝对楼层号
                is_user: msg.is_user, // 【V6 新增】保留用户标识
                send_date: msg.send_date, // 【V6 新增】保留发送时间
            };
        }).filter(item => item.content); // 过滤掉处理后内容为空的条目

        if (processedMessages.length === 0) {
            setVectorText(resultsEl, 'vectorUi.noValidContent');
            vectorToast('warning', t('vectorUi.noValidContent'), t('vectorUi.noticeModule'));
            return;
        }

        // 4. 构建编辑器HTML (V6 - 增加 data-* 属性以保留元数据)
        const editorHtml = processedMessages.map((item, index) => `
            <div class="hly-preview-item-v2" id="${item.id}">
                <details class="hly-preview-details">
                    <summary class="hly-preview-summary">
                        ${vectorHtml('vectorUi.previewFloor', { floor: item.floor, name: item.name })}
                    </summary>
                    <div class="hly-preview-content">
                        <textarea class="hly-preview-textarea" 
                                  data-floor="${item.floor}" 
                                  data-is-user="${item.is_user}" 
                                  data-send-date="${escapeAttribute(item.send_date)}">${escapeTextareaContent(item.content)}</textarea>
                    </div>
                </details>
                <button class="hly-preview-delete-btn-v2" data-target="${item.id}" ${vectorTitle("vectorUi.deleteEntryTip")}>&times;</button>
            </div>
        `).join('');

        // 5. 显示模态窗口
        showHtmlModal(t('vectorUi.previewTitle'), `<div class="hly-preview-container-v2">${editorHtml}</div>`, {
            okText: t('vectorUi.confirmPreview'),
            onShow: (dialogElement) => {
                const heading = dialogElement[0].querySelector('h3');
                if (heading) {
                    for (const child of [...heading.childNodes]) {
                        if (child.nodeName !== 'I') child.remove();
                    }
                    const title = document.createElement('span');
                    heading.appendChild(title);
                    setVectorText(title, 'vectorUi.previewTitle');
                }
                const okButton = dialogElement[0].querySelector('.popup-button-ok');
                if (okButton) setVectorText(okButton, 'vectorUi.confirmPreview');
            },
            onOk: (dialogElement) => {
                const finalMessages = [];
                dialogElement.find('.hly-preview-item-v2').each(function () {
                    const textarea = $(this).find('.hly-preview-textarea');
                    const text = textarea.val();
                    if (text.trim()) {
                        // 【V6 重构】收集包含完整元数据的消息对象
                        finalMessages.push({
                            mes: text,
                            is_user: textarea.data('is-user'),
                            send_date: textarea.data('send-date'),
                            floor: textarea.data('floor'), // 【V6.2 修复】把楼层号也一并传过去！
                        });
                    }
                });

                // 将对象数组字符串化后存入dataset
                resultsEl.dataset.finalMessages = JSON.stringify(finalMessages);

                // 更新预览区UI
                const layerStart = document.getElementById('hly-layer-start').value;
                const layerEnd = document.getElementById('hly-layer-end').value;
                setVectorText(resultsEl, 'vectorUi.previewSelected', { p0: layerStart, p1: layerEnd, p2: finalMessages.length });

                vectorToast('success', t('vectorUi.previewUpdated'), t('vectorUi.noticeDone'));
            }
        });

        // 6. 为新生成的删除按钮绑定事件 (V2)
        $('.hly-preview-delete-btn-v2').on('click', function (e) {
            e.preventDefault();
            const targetId = $(this).data('target');
            $(`#${targetId}`).remove();
        });

    } catch (error) {
        console.error('[翰林院-枢纽] 预览过程发生错误:', error);
        setVectorText(resultsEl, 'vectorUi.previewFailed', { p0: error.message });
        vectorToast('error', t('vectorUi.previewFailed', { p0: error.message }), t('vectorUi.seriousError'));
    }
}

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
    p.innerHTML = `<i class="fa-solid ${escapeAttribute(icon)}"></i> [${escapeTextareaContent(timestamp)}] ${escapeTextareaContent(message)}`;

    // 移除初始的占位符
    const placeholder = logOutput.querySelector('.hly-log-placeholder');
    if (placeholder) {
        placeholder.remove();
    }

    logOutput.appendChild(p);
    logOutput.scrollTop = logOutput.scrollHeight; // 自动滚动到底部
}

async function ingestManualText() {
    const textArea = document.getElementById('hly-manual-text');
    const text = textArea.value.trim();

    if (!text) {
        vectorToast('warning', t('vectorUi.emptyManual'), t('vectorUi.noticeModule'));
        log('用户尝试录入空文本。', 'warn');
        return;
    }

    log(`收到手动录入请求，文本长度: ${text.length}`, 'info');
    vectorToast('info', t('vectorUi.processingManual'), t('vectorUi.notice'));

    try {
        const result = await HanlinyuanCore.ingestTextToHanlinyuan(text, 'manual', { sourceName: '手动录入' });
        if (result.success) {
            vectorToast('success', t('vectorUi.manualCompleted', { p0: result.count }), t('vectorUi.success'));
            log(`手动录入成功，新增 ${result.count} 条忆识。`, 'success');
            textArea.value = ''; // 清空文本域
        } else {
            throw new Error(result.error || '未知错误');
        }
    } catch (error) {
        console.error('[翰林院-枢纽] 手动录入过程发生错误:', error);
        vectorToast('error', t('vectorUi.manualFailed', { p0: error.message }), t('vectorUi.seriousError'));
        log(`手动录入失败: ${error.message}`, 'error');
    } finally {
        await updatePanelStatus();
    }
}
