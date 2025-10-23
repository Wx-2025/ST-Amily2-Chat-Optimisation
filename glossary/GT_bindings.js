import { extension_settings, getContext } from "/scripts/extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { extensionName } from "../utils/settings.js";
import { safeLorebooks, safeLorebookEntries, safeUpdateLorebookEntries } from '../core/tavernhelper-compatibility.js';
import { testSybdApiConnection, fetchSybdModels } from '../core/api/SybdApi.js';
import { handleFileUpload, processNovel } from './index.js';
import { reorganizeEntriesByHeadings, loadDatabaseFiles } from './executor.js';
import { SETTINGS_KEY as PRESET_SETTINGS_KEY } from '../PresetSettings/config.js';

const moduleState = {
    selectedWorldBook: '',
};

function updateAndSaveSetting(key, value) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
    console.log(`[Amily2-术语表] 设置项 '${key}' 已更新为: ${JSON.stringify(value)}`);
}

function loadSettingsToUI() {
    const settings = extension_settings[extensionName] || {};
    const container = document.getElementById('amily2_glossary_panel');
    if (!container) return;

    const inputs = container.querySelectorAll('[data-setting-key]');
    inputs.forEach(target => {
        const key = target.dataset.settingKey;
        const value = settings[key];

        if (value === undefined) {
            let defaultValue;
            if (target.type === 'checkbox') {
                defaultValue = target.checked;
            } else if (target.type === 'range') {
                defaultValue = target.dataset.type === 'float' ? parseFloat(target.value) : parseInt(target.value, 10);
            } else {
                defaultValue = target.value;
            }
            updateAndSaveSetting(key, defaultValue);
            return;
        };

        if (target.type === 'checkbox') {
            target.checked = value;
        } else if (target.type === 'range') {
            target.value = value;
            const valueDisplay = document.getElementById(`${target.id}_value`);
            if (valueDisplay) valueDisplay.textContent = value;
        }
        else {
            target.value = value;
        }
    });

    const sybdContent = document.getElementById('amily2_sybd_content');
    if (sybdContent) {
        sybdContent.classList.remove('amily2-content-hidden');
    }

    const apiModeSelect = document.getElementById('amily2_sybd_api_mode');
    if (apiModeSelect) {
        updateConfigVisibility(apiModeSelect.value);
    }
}

function bindAutoSaveEvents() {
    const container = document.getElementById('amily2_glossary_panel');
    if (!container) return;

    const handler = (event) => {
        const target = event.target;
        const key = target.dataset.settingKey;
        if (!key) return;

        let value;
        const type = target.dataset.type || 'string';

        if (target.type === 'checkbox') {
            value = target.checked;
        } else {
            value = target.value;
        }

        switch (type) {
            case 'integer': value = parseInt(value, 10); break;
            case 'float': value = parseFloat(value); break;
            case 'boolean': value = (typeof value === 'boolean') ? value : (value === 'true'); break;
        }
        
        updateAndSaveSetting(key, value);

        if (key === 'sybdApiMode') {
            updateConfigVisibility(value);
        }
        if (target.type === 'range') {
            document.getElementById(`${target.id}_value`).textContent = value;
        }
    };

    container.addEventListener('change', handler);
    container.addEventListener('input', (event) => {
        if (event.target.type === 'range') handler(event);
    });
}

function updateConfigVisibility(mode) {
    const compatibleConfig = document.getElementById('amily2_sybd_compatible_config');
    const presetConfig = document.getElementById('amily2_sybd_preset_config');

    if (mode === 'sillytavern_preset') {
        compatibleConfig.style.display = 'none';
        presetConfig.style.display = 'block';
        loadTavernPresets();
    } else {
        compatibleConfig.style.display = 'block';
        presetConfig.style.display = 'none';
    }
}

async function loadTavernPresets() {
    const select = document.getElementById('amily2_sybd_tavern_profile');
    if (!select) return;

    const currentValue = extension_settings[extensionName]?.sybdTavernProfile || '';
    select.innerHTML = '<option value="">-- 加载中 --</option>';

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];
        
        select.innerHTML = '<option value="">-- 请选择预设 --</option>';
        
        if (tavernProfiles.length > 0) {
            tavernProfiles.forEach(profile => {
                if (profile.api && profile.preset) {
                    const option = new Option(profile.name || profile.id, profile.id);
                    select.add(option);
                }
            });
            select.value = currentValue;
        } else {
            select.innerHTML = '<option value="">未找到可用预设</option>';
        }
    } catch (error) {
        console.error('[Amily2-术语表] 加载SillyTavern预设失败:', error);
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

function bindManualActionEvents() {
    const testBtn = document.getElementById('amily2_sybd_test_connection');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            const originalHtml = testBtn.innerHTML;
            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 测试中';
            await testSybdApiConnection();
            testBtn.disabled = false;
            testBtn.innerHTML = originalHtml;
        });
    }

    const fetchBtn = document.getElementById('amily2_sybd_fetch_models');
    const modelSelect = document.getElementById('amily2_sybd_model_select');
    const modelInput = document.getElementById('amily2_sybd_model');

    if (fetchBtn && modelSelect && modelInput) {
        fetchBtn.addEventListener('click', async () => {
            const originalHtml = fetchBtn.innerHTML;
            fetchBtn.disabled = true;
            fetchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 获取中';
            
            try {
                const models = await fetchSybdModels();
                if (models && models.length > 0) {
                    modelSelect.innerHTML = '<option value="">-- 请选择模型 --</option>';
                    models.forEach(model => {
                        const option = new Option(model.name || model.id, model.id);
                        modelSelect.add(option);
                    });
                    
                    modelSelect.style.display = 'block';
                    modelInput.style.display = 'none';
                    toastr.success(`成功获取 ${models.length} 个模型`);
                } else {
                    toastr.warning('未获取到任何模型');
                }
            } catch (error) {
                toastr.error(`获取模型失败: ${error.message}`);
            } finally {
                fetchBtn.disabled = false;
                fetchBtn.innerHTML = originalHtml;
            }
        });

        modelSelect.addEventListener('change', () => {
            const selectedModel = modelSelect.value;
            if (selectedModel) {
                modelInput.value = selectedModel;
                modelInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
}

async function renderWorldBookEntries() {
    const container = document.getElementById('world-book-entries-display');
    if (!container) return;

    const selectedBook = moduleState.selectedWorldBook;
    if (!selectedBook) {
        container.innerHTML = '<p style="text-align:center;">请先在“小说处理”标签页中选择一个世界书。</p>';
        return;
    }

    container.innerHTML = '<p style="text-align:center;"><i class="fas fa-spinner fa-spin"></i> 正在加载条目...</p>';

    try {
        const allEntries = await safeLorebookEntries(selectedBook);
        let managedEntries = allEntries.filter(e => e.comment?.startsWith('[Amily2小说处理]'));

        if (managedEntries.length === 0) {
            container.innerHTML = '<p style="text-align:center;">未找到由小说处理功能生成的条目。</p>';
            return;
        }

        container.innerHTML = ''; 

        const summaryEntries = managedEntries.filter(e => e.comment.replace('[Amily2小说处理]', '').trim().startsWith('章节内容概述'));
        const otherEntries = managedEntries.filter(e => !e.comment.replace('[Amily2小说处理]', '').trim().startsWith('章节内容概述'));
        const sortedEntries = otherEntries.concat(summaryEntries);

        sortedEntries.forEach(entry => {
            const entryElement = document.createElement('div');
            entryElement.className = 'world-book-entry-item';
            entryElement.dataset.entryId = entry.uid;

            const title = entry.comment.replace('[Amily2小说处理]', '').trim();

            const renderContent = (content) => {
                const trimmedContent = content.trim();
                if (trimmedContent.startsWith('graph') || trimmedContent.startsWith('flowchart')) {
                    try {
                        const lines = trimmedContent.split('\n').map(l => l.trim()).filter(l => l.includes('-->') || l.includes('--'));
                        let body = '';
                        lines.forEach(line => {
                            if (line.startsWith('flowchart')) return;
                            let source = '', rel = '', target = '';

                            let match = line.match(/(.+?)\s*--\s*"(.*?)"\s*-->(.+)/);
                            if (match) {
                                [source, rel, target] = [match[1], match[2], match[3]];
                            } else {
                                match = line.match(/(.+?)\s*-->\s*\|(.*?)\|(.+)/);
                                if (match) {
                                    [source, rel, target] = [match[1], match[2], match[3]];
                                } else {
                                    match = line.match(/(.+?)\s*-->(.+)/);
                                    if (match) {
                                        [source, target] = [match[1], match[2]];
                                        rel = '<i>(直接关联)</i>';
                                    }
                                }
                            }

                            if (source && target) {
                                body += `<tr><td>${source.trim()}</td><td>${rel.trim()}</td><td>${target.trim().replace(';','')}</td></tr>`;
                            }
                        });
                        return `<table class="table-render"><thead><tr><th>源头</th><th>关系</th><th>目标</th></tr></thead><tbody>${body}</tbody></table>`;
                    } catch {
                        return `<pre>${content}</pre>`;
                    }
                }
                if (trimmedContent.includes('|') && trimmedContent.includes('\n')) {
                    try {
                        const rows = trimmedContent.split('\n').filter(row => row.trim() && row.includes('|'));
                        let header = '';
                        let body = '';
                        let isHeaderRow = true;
                        rows.forEach(rowStr => {
                            if (rowStr.includes('---')) return;
                            const cells = rowStr.split('|').filter(c => c.trim()).map(cell => `<td>${cell.trim()}</td>`).join('');
                            if (isHeaderRow) {
                                header += `<tr>${cells.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')}</tr>`;
                                isHeaderRow = false;
                            } else {
                                body += `<tr>${cells}</tr>`;
                            }
                        });
                        return `<table class="table-render"><thead>${header}</thead><tbody>${body}</tbody></table>`;
                    } catch {
                        return `<pre>${content}</pre>`;
                    }
                }
                return `<pre>${content}</pre>`;
            };

            entryElement.innerHTML = `
                <div class="entry-header">
                    <strong class="entry-title">${title}</strong>
                    <div class="entry-actions">
                        <button class="menu_button primary small_button save-entry-btn" style="display: none;"><i class="fas fa-save"></i> 保存</button>
                        <button class="menu_button danger small_button cancel-entry-btn" style="display: none;"><i class="fas fa-times"></i> 取消</button>
                        <button class="menu_button secondary small_button edit-entry-btn"><i class="fas fa-edit"></i> 编辑</button>
                    </div>
                </div>
                <div class="entry-content-display">${renderContent(entry.content)}</div>
                <div class="entry-content-editor" style="display: none;">
                    <textarea class="text_pole" style="width: 98%; min-height: 150px;">${entry.content}</textarea>
                </div>
            `;

            const editBtn = entryElement.querySelector('.edit-entry-btn');
            const saveBtn = entryElement.querySelector('.save-entry-btn');
            const cancelBtn = entryElement.querySelector('.cancel-entry-btn');
            const displayDiv = entryElement.querySelector('.entry-content-display');
            const editorDiv = entryElement.querySelector('.entry-content-editor');
            const textarea = editorDiv.querySelector('textarea');
            const originalContent = entry.content;

            editBtn.addEventListener('click', () => {
                displayDiv.style.display = 'none';
                editorDiv.style.display = 'block';
                saveBtn.style.display = 'inline-block';
                cancelBtn.style.display = 'inline-block';
                editBtn.style.display = 'none';
            });

            const hideEditor = () => {
                displayDiv.style.display = 'block';
                editorDiv.style.display = 'none';
                saveBtn.style.display = 'none';
                cancelBtn.style.display = 'none';
                editBtn.style.display = 'inline-block';
            };

            cancelBtn.addEventListener('click', () => {
                textarea.value = originalContent;
                hideEditor();
            });

            saveBtn.addEventListener('click', async () => {
                const newContent = textarea.value;
                
                displayDiv.innerHTML = renderContent(newContent);
                hideEditor();
                
                try {
                    const entryToUpdate = { uid: entry.uid, content: newContent };
                    await safeUpdateLorebookEntries(selectedBook, [entryToUpdate]);
                    toastr.success(`条目 "${title}" 已保存。`);
                    entry.content = newContent;
                } catch (error) {
                    displayDiv.innerHTML = renderContent(originalContent);
                    console.error('保存世界书条目失败:', error);
                    toastr.error(`保存失败: ${error.message}`);
                }
            });

            container.appendChild(entryElement);
        });
        
    } catch (error) {
        console.error('加载世界书条目失败:', error);
        container.innerHTML = `<p style="text-align:center; color: #ff8a8a;">加载失败: ${error.message}</p>`;
    }
}


function bindTabEvents() {
    const tabs = document.querySelectorAll('.glossary-tab');
    const contents = document.querySelectorAll('.glossary-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.dataset.tab;

            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            contents.forEach(content => {
                if (content.id === `glossary-content-${tabId}`) {
                    content.classList.add('active');
                } else {
                    content.classList.remove('active');
                }
            });

            if (tabId === 'context') {
                renderWorldBookEntries();
            } else if (tabId === 'tools') {
                const statusEl = document.getElementById('reorganize-status');
                if (statusEl) {
                    if (moduleState.selectedWorldBook) {
                        statusEl.textContent = `当前已选择世界书: "${moduleState.selectedWorldBook}"。可以开始重组。`;
                        statusEl.style.color = '';
                    } else {
                        statusEl.textContent = '请先在“小说处理”标签页中选择一个世界书。';
                        statusEl.style.color = '#ffdb58'; // Warning color
                    }
                }
            }
        });
    });
}

function bindReorganizeEvents() {
    const reorganizeBtn = document.getElementById('reorganize-entries-by-heading');
    const statusEl = document.getElementById('reorganize-status');
    const headingsListEl = document.getElementById('reorganize-headings-list');

    if (!reorganizeBtn || !statusEl || !headingsListEl) return;

    const updateStatusCallback = (message, type = 'info') => {
        statusEl.textContent = message;
        statusEl.style.color = type === 'error' ? '#ff8a8a' : (type === 'success' ? '#8aff8a' : '');
    };

    reorganizeBtn.addEventListener('click', async () => {
        const headingsToProcess = headingsListEl.value.split('\n').map(h => h.trim()).filter(Boolean);
        if (headingsToProcess.length === 0) {
            updateStatusCallback('错误：请在文本框中输入至少一个要重组的标题。', 'error');
            return;
        }

        const bookName = moduleState.selectedWorldBook;
        if (!bookName) {
            updateStatusCallback('错误：请先在“小说处理”标签页中选择一个世界书。', 'error');
            return;
        }

        const originalHtml = reorganizeBtn.innerHTML;
        reorganizeBtn.disabled = true;
        reorganizeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在重组...';

        try {
            await reorganizeEntriesByHeadings(bookName, headingsToProcess, updateStatusCallback);
            
            if (document.querySelector('.glossary-tab[data-tab="context"].active')) {
                renderWorldBookEntries();
            }
        } catch (error) {
            console.error('An error occurred during reorganization:', error);
        } finally {
            reorganizeBtn.disabled = false;
            reorganizeBtn.innerHTML = originalHtml;
        }
    });
}

function bindNovelProcessEvents() {
    const fileInput = document.getElementById('novel-file-input');
    const fileLabel = document.querySelector('label[for="novel-file-input"]');
    const dbSelectBtn = document.getElementById('select-from-database-button');
    const processBtn = document.getElementById('novel-confirm-and-process');
    const chunkSizeInput = document.getElementById('novel-chunk-size');
    const chunkCountEl = document.getElementById('novel-chunk-count');
    const chunkPreviewEl = document.getElementById('novel-chunk-preview');

    let fileContent = '';
    let processingState = {
        chunks: [],
        batchSize: 1,
        forceNew: false,
        selectedWorldBook: '',
        currentIndex: 0,
        isAborted: false,
        isRunning: false,
        lastStatus: 'idle',
    };

    function updateChunks() {
        if (!fileContent) return;
        const chunkSize = parseInt(chunkSizeInput.value, 10) || 5000;
        const newChunks = [];
        for (let i = 0; i < fileContent.length; i += chunkSize) {
            newChunks.push({ title: `Part ${i/chunkSize + 1}`, content: fileContent.substring(i, i + chunkSize) });
        }
        processingState.chunks = newChunks;

        chunkCountEl.textContent = newChunks.length;
        chunkPreviewEl.innerHTML = newChunks.map((chunk, index) =>
            `<div class="chunk-preview-item"><b>块 ${index + 1}:</b> ${chunk.content.substring(0, 100)}...</div>`
        ).join('');
        
        resetProcessing();
    }
    
    function resetProcessing() {
        processingState.currentIndex = 0;
        processingState.isAborted = false;
        processingState.isRunning = false;
        processingState.lastStatus = 'idle';
        updateButtonUI();
    }

    function updateButtonUI() {
        if (processingState.isRunning) {
            processBtn.disabled = false;
            processBtn.innerHTML = '<i class="fas fa-stop-circle"></i> 请求中止';
            processBtn.classList.add('danger');
        } else {
            processBtn.classList.remove('danger');
            switch (processingState.lastStatus) {
                case 'paused':
                    processBtn.innerHTML = '<i class="fas fa-play"></i> 继续处理';
                    processBtn.disabled = false;
                    break;
                case 'failed':
                    processBtn.innerHTML = '<i class="fas fa-redo"></i> 重试处理';
                    processBtn.disabled = false;
                    break;
                case 'success':
                    processBtn.innerHTML = '<i class="fas fa-check"></i> 处理完成';
                    processBtn.disabled = true;
                    break;
                case 'idle':
                default:
                    processBtn.innerHTML = '确认并开始处理';
                    processBtn.disabled = processingState.chunks.length === 0;
                    break;
            }
        }
    }

    async function startOrResumeProcessing() {
        if (processingState.isRunning) return;

        processingState.isRunning = true;
        processingState.isAborted = false;
        updateButtonUI();

        processingState.forceNew = document.getElementById('novel-force-new').checked;
        processingState.batchSize = 1;
        processingState.selectedWorldBook = moduleState.selectedWorldBook;

        try {
            const result = await processNovel(processingState);
            if (result === 'paused') {
                processingState.lastStatus = 'paused';
            } else if (result === 'success') {
                processingState.lastStatus = 'success';
                processingState.currentIndex = 0;
            }
        } catch (error) {
            processingState.lastStatus = 'failed';
            processingState.isAborted = true;
        } finally {
            processingState.isRunning = false;
            updateButtonUI();
        }
    }

    if (fileLabel && fileInput) {
        fileLabel.addEventListener('click', (event) => {
            event.preventDefault();
            fileInput.click();
        });
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;
            fileLabel.innerHTML = `<i class="fas fa-check"></i> 已选择: ${file.name}`;
            handleFileUpload(file, (content) => {
                fileContent = content;
                updateChunks();
            });
        });
    }

    if (dbSelectBtn) {
        dbSelectBtn.addEventListener('click', () => {
            loadDatabaseFiles();
        });
    }

    document.addEventListener('novel-file-loaded', (event) => {
        const { content, fileName } = event.detail;
        fileContent = content;
        updateChunks();
        if (fileLabel) {
            fileLabel.innerHTML = `<i class="fas fa-upload"></i> 2a. 上传本地文件 (.txt)`;
        }
    });

    if (chunkSizeInput) {
        chunkSizeInput.addEventListener('input', updateChunks);
    }


    if (processBtn) {
        processBtn.addEventListener('click', async () => {
            if (processingState.isRunning) {
                processingState.isAborted = true;
                processBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在中止...';
                processBtn.disabled = true;
            } else {
                if (processingState.lastStatus !== 'paused') {
                    const startBatchInput = document.getElementById('novel-start-batch-index');
                    let startBatch = parseInt(startBatchInput.value, 10);
                    if (isNaN(startBatch) || startBatch < 1) {
                        startBatch = 1;
                        if (startBatchInput) startBatchInput.value = 1;
                    }
                    processingState.currentIndex = (startBatch - 1);
                }
                startOrResumeProcessing();
            }
        });
    }
}


async function loadWorldBooks() {
    const select = document.getElementById('novel-world-book-select');
    if (!select) return;

    const savedBook = extension_settings[extensionName]?.selectedWorldBook;
    moduleState.selectedWorldBook = savedBook || '';

    try {
        const allBooks = await safeLorebooks();
        select.innerHTML = '<option value="">-- 请选择世界书 --</option>';

        if (allBooks && allBooks.length > 0) {
            allBooks.forEach(bookName => {
                const option = new Option(bookName, bookName);
                select.add(option);
            });

            if (savedBook && allBooks.includes(savedBook)) {
                select.value = savedBook;
            }
        } else {
            select.innerHTML = '<option value="">未找到世界书</option>';
        }
    } catch (error) {
        console.error('[Amily2-术语表] 加载世界书失败:', error);
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

export function bindGlossaryEvents() {
    const panel = document.getElementById('amily2_glossary_panel');
    if (!panel || panel.dataset.eventsBound) {
        return;
    }

    console.log('[Amily2-术语表] 开始绑定UI事件 (最终重构版)...');

    loadSettingsToUI();
    bindAutoSaveEvents();
    bindManualActionEvents();
    bindTabEvents();
    bindNovelProcessEvents();
    bindReorganizeEvents();
    loadWorldBooks();

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        console.log('[Amily2-术语表] 检测到角色加载，重新加载世界书列表以确保同步。');
        loadWorldBooks();
    });

    const worldBookSelect = document.getElementById('novel-world-book-select');
    if (worldBookSelect) {
        const updateOnBookSelect = (selectedValue) => {
            updateAndSaveSetting('selectedWorldBook', selectedValue);
            moduleState.selectedWorldBook = selectedValue;

            const contextTab = document.querySelector('.glossary-tab[data-tab="context"]');
            if (contextTab && contextTab.classList.contains('active')) {
                renderWorldBookEntries();
            }

            const toolsTab = document.querySelector('.glossary-tab[data-tab="tools"]');
            if (toolsTab && toolsTab.classList.contains('active')) {
                const statusEl = document.getElementById('reorganize-status');
                if (statusEl) {
                    if (selectedValue) {
                        statusEl.textContent = `当前已选择世界书: "${selectedValue}"。可以开始重组。`;
                        statusEl.style.color = '';
                    } else {
                        statusEl.textContent = '请先在“小说处理”标签页中选择一个世界书。';
                        statusEl.style.color = '#ffdb58';
                    }
                }
            }
        };
        
        worldBookSelect.addEventListener('change', () => {
            updateOnBookSelect(worldBookSelect.value);
        });

        if (moduleState.selectedWorldBook) {
             updateOnBookSelect(moduleState.selectedWorldBook);
        }
    }

    panel.dataset.eventsBound = 'true';
    console.log('[Amily2-术语表] UI事件绑定完成 (最终重构版)。');
}
