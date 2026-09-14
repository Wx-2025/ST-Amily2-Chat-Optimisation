import { extension_settings, getContext } from "/scripts/extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { extensionName } from "../utils/settings.js";
import { configManager } from '../utils/config/ConfigManager.js';
import { SENSITIVE_KEYS } from '../utils/config/sensitive-keys.js';
import { safeLorebooks, safeLorebookEntries, safeUpdateLorebookEntries } from '../core/tavernhelper-compatibility.js';
import { testSybdApiConnection, fetchSybdModels } from '../core/api/SybdApi.js';
import { handleFileUpload, processNovel } from './index.js';
import { reorganizeEntriesByHeadings, loadDatabaseFiles } from './executor.js';
import { SETTINGS_KEY as PRESET_SETTINGS_KEY } from '../PresetSettings/config.js';
import { escapeHTML } from '../utils/utils.js';
import { watchProfileSliderGuard } from '../ui/profile-slider-guard.js';
import { clearSecretInput, markSecretInputStored, readSecretInputUpdate } from '../ui/secret-input.js';
import {
    bindGlossaryTranslations, glossaryHtml, glossaryMessage, reportGlossaryStatus,
    releaseGlossaryTranslations, setGlossaryButton, setGlossaryRawText, setGlossaryText,
} from './i18n.js';
import {
    splitTextByUnicodeBoundary,
    truncateTextAtUnicodeBoundary,
} from '../core/utils/unicode-boundary.js';

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
        if (SENSITIVE_KEYS.has(key)) {
            clearSecretInput(target, configManager.has(key));
            if (target.dataset.secretStored === 'true') setGlossaryText(target, 'api.storedSecret', {}, 'placeholder');
            return;
        }
        const value = settings[key];

        if (value === undefined || value === null || value === '') {
            if (!SENSITIVE_KEYS.has(key)) {
                // 总开关类：未写过时用 HTML 默认（sybdEnabled 默认 true），不强制写回 false
                if (target.type === 'checkbox' && key === 'sybdEnabled') {
                    target.checked = true;
                    return;
                }
                let defaultValue;
                if (target.type === 'checkbox') {
                    defaultValue = target.checked;
                } else if (target.type === 'range') {
                    defaultValue = target.dataset.type === 'float' ? parseFloat(target.value) : parseInt(target.value, 10);
                } else {
                    defaultValue = target.value;
                }
                updateAndSaveSetting(key, defaultValue);
            }
            return;
        };

        if (target.type === 'checkbox') {
            // sybdEnabled 与 table 类似：仅明确 false 才关
            target.checked = (key === 'sybdEnabled') ? (value !== false) : !!value;
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

        // 敏感字段（API Key）经 configManager 写入 localStorage
        if (SENSITIVE_KEYS.has(key)) {
            const update = readSecretInputUpdate(target);
            if (!update.changed) return;
            configManager.set(key, update.value);
            markSecretInputStored(target, Boolean(update.value));
            if (target.dataset.secretStored === 'true') setGlossaryText(target, 'api.storedSecret', {}, 'placeholder');
        } else {
            updateAndSaveSetting(key, value);
        }

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
    releaseGlossaryTranslations(select, { includeRoot: false });
    select.innerHTML = glossaryHtml('api.loading', {}, 'option');
    bindGlossaryTranslations(select);

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];
        
        releaseGlossaryTranslations(select, { includeRoot: false });
        select.innerHTML = glossaryHtml('api.choosePreset', {}, 'option');
        
        if (tavernProfiles.length > 0) {
            tavernProfiles.forEach(profile => {
                if (profile.api && profile.preset) {
                    const option = new Option(profile.name || profile.id, profile.id);
                    select.add(option);
                }
            });
            select.value = currentValue;
        } else {
            select.innerHTML = glossaryHtml('api.noPresets', {}, 'option');
        }
    } catch (error) {
        console.error('[Amily2-术语表] 加载SillyTavern预设失败:', error);
        releaseGlossaryTranslations(select, { includeRoot: false });
        select.innerHTML = glossaryHtml('api.loadFailed', {}, 'option');
    }
    bindGlossaryTranslations(select);
}

function bindManualActionEvents() {
    const testBtn = document.getElementById('amily2_sybd_test_connection');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            setGlossaryButton(testBtn, 'api.testing', {}, 'fas fa-spinner fa-spin');
            await testSybdApiConnection();
            testBtn.disabled = false;
            setGlossaryButton(testBtn, 'api.test', {}, 'fas fa-plug');
        });
    }

    const fetchBtn = document.getElementById('amily2_sybd_fetch_models');
    const modelSelect = document.getElementById('amily2_sybd_model_select');
    const modelInput = document.getElementById('amily2_sybd_model');

    if (fetchBtn && modelSelect && modelInput) {
        fetchBtn.addEventListener('click', async () => {
            fetchBtn.disabled = true;
            setGlossaryButton(fetchBtn, 'api.fetching', {}, 'fas fa-spinner fa-spin');
            
            try {
                const models = await fetchSybdModels();
                if (models && models.length > 0) {
                    releaseGlossaryTranslations(modelSelect, { includeRoot: false });
                    modelSelect.innerHTML = glossaryHtml('api.chooseModel', {}, 'option');
                    models.forEach(model => {
                        const option = new Option(model.name || model.id, model.id);
                        modelSelect.add(option);
                    });
                    bindGlossaryTranslations(modelSelect);
                    
                    modelSelect.style.display = 'block';
                    modelInput.style.display = 'none';
                    toastr.success(escapeHTML(glossaryMessage('api.modelsFetched', { count: models.length })));
                } else {
                    toastr.warning(glossaryMessage('api.noModels'));
                }
            } catch (error) {
                toastr.error(escapeHTML(glossaryMessage('api.fetchFailed', { error: error.message })));
            } finally {
                fetchBtn.disabled = false;
                setGlossaryButton(fetchBtn, 'api.fetch', {}, 'fas fa-download');
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
        releaseGlossaryTranslations(container, { includeRoot: false });
        container.innerHTML = `<p style="text-align:center;">${glossaryHtml('entries.chooseBook')}</p>`;
        bindGlossaryTranslations(container);
        return;
    }

    releaseGlossaryTranslations(container, { includeRoot: false });
    container.innerHTML = `<p style="text-align:center;"><i class="fas fa-spinner fa-spin"></i> ${glossaryHtml('entries.loading')}</p>`;
    bindGlossaryTranslations(container);

    try {
        const allEntries = await safeLorebookEntries(selectedBook);
        let managedEntries = allEntries.filter(e => e.comment?.startsWith('[Amily2小说处理]'));

        if (managedEntries.length === 0) {
            releaseGlossaryTranslations(container, { includeRoot: false });
            container.innerHTML = `<p style="text-align:center;">${glossaryHtml('entries.empty')}</p>`;
            bindGlossaryTranslations(container);
            return;
        }

        releaseGlossaryTranslations(container, { includeRoot: false });
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
                            let directRelation = false;

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
                                        directRelation = true;
                                    }
                                }
                            }

                            if (source && target) {
                                body += `<tr><td>${escapeHTML(source.trim())}</td><td>${directRelation ? `<i>${glossaryHtml('entries.direct')}</i>` : escapeHTML(rel.trim())}</td><td>${escapeHTML(target.trim().replace(';',''))}</td></tr>`;
                            }
                        });
                        return `<table class="table-render"><thead><tr><th>${glossaryHtml('entries.source')}</th><th>${glossaryHtml('entries.relation')}</th><th>${glossaryHtml('entries.target')}</th></tr></thead><tbody>${body}</tbody></table>`;
                    } catch {
                        return `<pre>${escapeHTML(content)}</pre>`;
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
                            const cells = rowStr.split('|').filter(c => c.trim()).map(cell => `<td>${escapeHTML(cell.trim())}</td>`).join('');
                            if (isHeaderRow) {
                                header += `<tr>${cells.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')}</tr>`;
                                isHeaderRow = false;
                            } else {
                                body += `<tr>${cells}</tr>`;
                            }
                        });
                        return `<table class="table-render"><thead>${header}</thead><tbody>${body}</tbody></table>`;
                    } catch {
                        return `<pre>${escapeHTML(content)}</pre>`;
                    }
                }
                return `<pre>${escapeHTML(content)}</pre>`;
            };

            entryElement.innerHTML = `
                <div class="entry-header">
                    <strong class="entry-title">${escapeHTML(title)}</strong>
                    <div class="entry-actions">
                        <button class="menu_button primary small_button save-entry-btn" style="display: none;"><i class="fas fa-save"></i> ${glossaryHtml('entries.save')}</button>
                        <button class="menu_button danger small_button cancel-entry-btn" style="display: none;"><i class="fas fa-times"></i> ${glossaryHtml('entries.cancel')}</button>
                        <button class="menu_button secondary small_button edit-entry-btn"><i class="fas fa-edit"></i> ${glossaryHtml('entries.edit')}</button>
                    </div>
                </div>
                <div class="entry-content-display">${renderContent(entry.content)}</div>
                <div class="entry-content-editor" style="display: none;">
                    <textarea class="text_pole" style="width: 98%; min-height: 150px;">${escapeHTML(entry.content || '')}</textarea>
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
                
                releaseGlossaryTranslations(displayDiv, { includeRoot: false });
                displayDiv.innerHTML = renderContent(newContent);
                bindGlossaryTranslations(displayDiv);
                hideEditor();
                
                try {
                    const entryToUpdate = { uid: entry.uid, content: newContent };
                    await safeUpdateLorebookEntries(selectedBook, [entryToUpdate]);
                    toastr.success(escapeHTML(glossaryMessage('entries.saved', { title })));
                    entry.content = newContent;
                } catch (error) {
                    releaseGlossaryTranslations(displayDiv, { includeRoot: false });
                    displayDiv.innerHTML = renderContent(originalContent);
                    bindGlossaryTranslations(displayDiv);
                    console.error('保存世界书条目失败:', error);
                    toastr.error(escapeHTML(glossaryMessage('entries.saveFailed', { error: error.message })));
                }
            });

            container.appendChild(entryElement);
            bindGlossaryTranslations(entryElement);
        });
        
    } catch (error) {
        console.error('加载世界书条目失败:', error);
        const p = document.createElement('p');
        p.style.textAlign = 'center';
        p.style.color = '#ff8a8a';
        releaseGlossaryTranslations(container, { includeRoot: false });
        container.innerHTML = '';
        container.appendChild(p);
        setGlossaryText(p, error?.message == null ? 'entries.unknownLoadFailed' : 'entries.loadFailed', { error: error?.message });
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
                        setGlossaryText(statusEl, 'tools.selected', { book: moduleState.selectedWorldBook });
                        statusEl.style.color = '';
                    } else {
                        setGlossaryText(statusEl, 'entries.chooseBook');
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

    const updateStatusCallback = (message, type = 'info', display = null) => {
        if (display) setGlossaryText(statusEl, display.key, display.params);
        else setGlossaryRawText(statusEl, message);
        statusEl.style.color = type === 'error' ? '#ff8a8a' : (type === 'success' ? '#8aff8a' : '');
    };

    reorganizeBtn.addEventListener('click', async () => {
        const headingsToProcess = headingsListEl.value.split('\n').map(h => h.trim()).filter(Boolean);
        if (headingsToProcess.length === 0) {
            reportGlossaryStatus(updateStatusCallback, 'tools.needHeadings', {}, 'error');
            return;
        }

        const bookName = moduleState.selectedWorldBook;
        if (!bookName) {
            reportGlossaryStatus(updateStatusCallback, 'tools.needBook', {}, 'error');
            return;
        }

        reorganizeBtn.disabled = true;
        setGlossaryButton(reorganizeBtn, 'tools.running', {}, 'fas fa-spinner fa-spin');

        try {
            await reorganizeEntriesByHeadings(bookName, headingsToProcess, updateStatusCallback);
            
            if (document.querySelector('.glossary-tab[data-tab="context"].active')) {
                renderWorldBookEntries();
            }
        } catch (error) {
            console.error('An error occurred during reorganization:', error);
        } finally {
            reorganizeBtn.disabled = false;
            setGlossaryButton(reorganizeBtn, 'tools.start', {}, 'fas fa-play-circle');
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
        const newChunks = splitTextByUnicodeBoundary(fileContent, {
            maxCodeUnits: chunkSize,
        }).map((content, index) => ({
            title: `Part ${index + 1}`,
            content,
        }));
        processingState.chunks = newChunks;

        chunkCountEl.textContent = newChunks.length;
        releaseGlossaryTranslations(chunkPreviewEl, { includeRoot: false });
        chunkPreviewEl.innerHTML = newChunks.map((chunk, index) =>
            `<div class="chunk-preview-item"><b>${glossaryHtml('novel.chunk', { index: index + 1 })}</b> ${escapeHTML(truncateTextAtUnicodeBoundary(chunk.content, 100))}...</div>`
        ).join('');
        bindGlossaryTranslations(chunkPreviewEl);
        
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
            setGlossaryButton(processBtn, 'novel.stop', {}, 'fas fa-stop-circle');
            processBtn.classList.add('danger');
        } else {
            processBtn.classList.remove('danger');
            switch (processingState.lastStatus) {
                case 'paused':
                    setGlossaryButton(processBtn, 'novel.resume', {}, 'fas fa-play');
                    processBtn.disabled = false;
                    break;
                case 'failed':
                    setGlossaryButton(processBtn, 'novel.retry', {}, 'fas fa-redo');
                    processBtn.disabled = false;
                    break;
                case 'success':
                    setGlossaryButton(processBtn, 'novel.done', {}, 'fas fa-check');
                    processBtn.disabled = true;
                    break;
                case 'idle':
                default:
                    setGlossaryButton(processBtn, 'novel.confirm', {}, 'fas fa-play-circle');
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
            setGlossaryButton(fileLabel, 'novel.selectedFile', { file: file.name }, 'fas fa-check');
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
            setGlossaryButton(fileLabel, 'novel.upload', {}, 'fas fa-upload');
        }
    });

    if (chunkSizeInput) {
        chunkSizeInput.addEventListener('input', updateChunks);
    }


    if (processBtn) {
        processBtn.addEventListener('click', async () => {
            if (processingState.isRunning) {
                processingState.isAborted = true;
                setGlossaryButton(processBtn, 'novel.stopping', {}, 'fas fa-spinner fa-spin');
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
        releaseGlossaryTranslations(select, { includeRoot: false });
        select.innerHTML = glossaryHtml('novel.chooseBook', {}, 'option');

        if (allBooks && allBooks.length > 0) {
            allBooks.forEach(bookName => {
                const option = new Option(bookName, bookName);
                select.add(option);
            });

            if (savedBook && allBooks.includes(savedBook)) {
                select.value = savedBook;
            }
        } else {
            select.innerHTML = glossaryHtml('novel.noBooks', {}, 'option');
        }
    } catch (error) {
        console.error('[Amily2-术语表] 加载世界书失败:', error);
        releaseGlossaryTranslations(select, { includeRoot: false });
        select.innerHTML = glossaryHtml('api.loadFailed', {}, 'option');
    }
    bindGlossaryTranslations(select);
}

export function bindGlossaryEvents() {
    const panel = document.getElementById('amily2_glossary_panel');
    if (panel) bindGlossaryTranslations(panel);
    if (!panel || panel.dataset.eventsBound) {
        return;
    }

    console.log('[Amily2-术语表] 开始绑定UI事件 (最终重构版)...');

    loadSettingsToUI();
    bindAutoSaveEvents();
    // sybd 槽分配 profile 后，温度/maxTokens 由 profile 权威控制（T-006 informational 化）
    watchProfileSliderGuard('sybd', ['#amily2_sybd_max_tokens', '#amily2_sybd_temperature']);
    bindManualActionEvents();
    bindTabEvents();
    bindNovelProcessEvents();
    bindReorganizeEvents();
    loadWorldBooks();

    // 监听我们自己的世界书创建事件，而不是监听全局的角色加载事件，避免冲突
    document.addEventListener('amily-lorebook-created', (event) => {
        console.log(`[Amily2-术语表] 检测到新世界书《${event.detail.bookName}》创建，重新加载列表以确保同步。`);
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
                        setGlossaryText(statusEl, 'tools.selected', { book: selectedValue });
                        statusEl.style.color = '';
                    } else {
                        setGlossaryText(statusEl, 'entries.chooseBook');
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
