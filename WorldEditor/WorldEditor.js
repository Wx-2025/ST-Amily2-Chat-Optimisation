
import { world_names, loadWorldInfo, saveWorldInfo, deleteWorldInfo, updateWorldInfoList } from "/scripts/world-info.js";
import { eventSource, event_types } from '/script.js';
import { showHtmlModal } from '../ui/page-window.js';
import { safeLorebooks, safeLorebookEntries, safeUpdateLorebookEntries, compatibleWriteToLorebook } from '../core/tavernhelper-compatibility.js';
import { amilyHelper } from '../core/tavern-helper/main.js';
import { escapeHTML } from '../utils/utils.js';
import {
    t, bindWorldEditorTranslations, refreshWorldEditorTranslations, releaseWorldEditorTranslations, setWorldEditorText,
    worldEditorHtml, worldEditorAttr, worldEditorOption, worldEditorToast,
    worldEditorError, worldEditorErrorParams,
} from './i18n.js';
const { SillyTavern } = window;

function normalizeFiniteInteger(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const integer = Math.trunc(numeric);
    return Number.isSafeInteger(integer) ? integer : fallback;
}

class WorldEditor {
    constructor() {
        this.isLoading = false;

        this.allWorldBooks = [];
        this.filteredWorldBooks = [];
        this.selectedWorldBooks = new Set();

        this.currentWorldBook = null;
        this.entries = [];
        this.selectedEntries = new Set();
        this.filteredEntries = [];
        this.currentEditingEntry = null;
        this.sortState = { key: 'order', asc: true };

        this.init();
    }

    init() {
        if (!this.initializeComponents()) {
            console.error('[世界书编辑器] 组件初始化失败，5秒后重试...');
            setTimeout(() => this.init(), 5000);
            return;
        }
        bindWorldEditorTranslations(document.getElementById('amily2_world_editor_panel'));
        this.bindEvents();
        this.loadAvailableWorldBooks();
        this.bindExternalEvents();
    }

    initializeComponents() {
        const ids = [
            // 主视图
            'world-book-selection-view', 'world-editor-entry-view',
            // 顶部按钮
            'world-editor-refresh-btn', 'world-editor-create-book-btn', 'world-editor-create-entry-btn',
            // 世界书视图
            'world-book-search-box', 'world-book-search-btn', 'world-book-count',
            'world-book-batch-actions', 'world-book-selected-count', 'world-book-clone-btn', 'world-book-delete-btn',
            'world-book-list-container',
            // 条目视图
            'world-editor-current-book-title', 'world-editor-back-to-list-btn',
            'world-editor-search-type', 'world-editor-search-box', 'world-editor-search-btn', 'world-editor-entry-count',
            'world-editor-select-all', 'world-editor-selected-count', 'world-editor-batch-actions',
            'world-editor-entries-container',
            'world-editor-enable-selected-btn', 'world-editor-disable-selected-btn',
            'world-editor-set-blue-btn', 'world-editor-set-green-btn', 'world-editor-copy-entries-btn', 'world-editor-delete-selected-btn',
            'world-editor-set-disable-recursion-btn', 'world-editor-set-prevent-recursion-btn'
        ];
        this.elements = {};
        let missing = false;
        for (const id of ids) {
            const camelCaseId = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
            this.elements[camelCaseId] = document.getElementById(id);
            if (!this.elements[camelCaseId]) {
                console.warn(`[世界书编辑器] UI元素缺失: ${id}`);
                if (id.endsWith('container') || id.endsWith('view')) {
                    missing = true; // 关键元素缺失
                }
            }
        }
        return !missing;
    }

    bindEvents() {
        // 视图切换
        this.elements.worldEditorBackToListBtn.addEventListener('click', () => this.switchToBookListView());

        // 顶部按钮
        this.elements.worldEditorRefreshBtn.addEventListener('click', () => this.loadAvailableWorldBooks());
        this.elements.worldEditorCreateBookBtn.addEventListener('click', () => this.createNewWorldBook());
        this.elements.worldEditorCreateEntryBtn.addEventListener('click', () => this.openCreateModal());

        // 世界书视图事件
        this.elements.worldBookSearchBox.addEventListener('input', () => this.filterWorldBooks());
        this.elements.worldBookSearchBtn.addEventListener('click', () => this.filterWorldBooks());
        this.elements.worldBookCloneBtn.addEventListener('click', () => this.cloneSelectedBooks());
        this.elements.worldBookDeleteBtn.addEventListener('click', () => this.deleteSelectedBooks());

        // 条目视图事件
        document.querySelector('#world-editor-entry-view .world-editor-entries-header').addEventListener('click', (e) => {
            if (e.target.dataset.sort) this.sortEntries(e.target.dataset.sort);
        });
        this.elements.worldEditorSearchBox.addEventListener('input', () => this.filterEntries());
        this.elements.worldEditorSearchBtn.addEventListener('click', () => this.filterEntries());
        this.elements.worldEditorSelectAll.addEventListener('change', (e) => this.toggleSelectAll(e.target.checked));
        this.elements.worldEditorEnableSelectedBtn.addEventListener('click', () => this.batchUpdateEntries({ enabled: true }));
        this.elements.worldEditorDisableSelectedBtn.addEventListener('click', () => this.batchUpdateEntries({ enabled: false }));
        this.elements.worldEditorSetBlueBtn.addEventListener('click', () => this.batchUpdateEntries({ type: 'constant' }));
        this.elements.worldEditorSetGreenBtn.addEventListener('click', () => this.batchUpdateEntries({ type: 'selective' }));
        this.elements.worldEditorCopyEntriesBtn.addEventListener('click', () => this.copySelectedEntries());
        this.elements.worldEditorDeleteSelectedBtn.addEventListener('click', () => this.batchDeleteEntries());
        this.elements.worldEditorSetDisableRecursionBtn.addEventListener('click', () => this.toggleBatchRecursion('exclude_recursion', 'worldEditorUi.excludeRecursion'));
        this.elements.worldEditorSetPreventRecursionBtn.addEventListener('click', () => this.toggleBatchRecursion('prevent_recursion', 'worldEditorUi.preventRecursion'));
    }

    // 视图管理
    switchToBookListView() {
        this.elements.worldBookSelectionView.style.display = 'block';
        this.elements.worldEditorEntryView.style.display = 'none';
        this.elements.worldEditorCreateEntryBtn.disabled = true;
        this.currentWorldBook = null;
    }

    switchToEntryView(bookName) {
        this.elements.worldBookSelectionView.style.display = 'none';
        this.elements.worldEditorEntryView.style.display = 'block';
        this.elements.worldEditorCreateEntryBtn.disabled = false;
        setWorldEditorText(this.elements.worldEditorCurrentBookTitle, 'worldEditorUi.currentBook', { name: bookName });
        this.loadWorldBookEntries(bookName);
    }

    // 世界书数据处理
    async loadAvailableWorldBooks() {
        this.setLoading(true);
        try {
            const books = await this.getAllWorldBooks();
            this.allWorldBooks = books.sort((a, b) => a.name.localeCompare(b.name));
            this.filterWorldBooks(); // 这会渲染列表
        } catch (error) {
            this.showError('worldEditorUi.error.loadBooks', { detail: error.message });
        } finally {
            this.setLoading(false);
        }
    }

    async getAllWorldBooks() {
        const books = await safeLorebooks();
        return books.map(name => ({ name }));
    }

    filterWorldBooks() {
        const term = this.elements.worldBookSearchBox.value.toLowerCase();
        this.filteredWorldBooks = this.allWorldBooks.filter(book => book.name.toLowerCase().includes(term));
        this.renderWorldBookList();
        this.updateWorldBookCount();
    }

    renderWorldBookList() {
        const container = this.elements.worldBookListContainer;
        releaseWorldEditorTranslations(container);
        container.innerHTML = ''; // 清空
        if (this.filteredWorldBooks.length === 0) {
            container.innerHTML = `<p class="world-editor-empty-state">${worldEditorHtml('worldEditorUi.emptyBooks')}</p>`;
            refreshWorldEditorTranslations(container);
            return;
        }

        const fragment = document.createDocumentFragment();
        this.filteredWorldBooks.forEach(book => {
            const isSelected = this.selectedWorldBooks.has(book.name);
            const row = document.createElement('div');
            row.className = `world-book-row ${isSelected ? 'selected' : ''}`;
            row.dataset.bookName = book.name;
            row.innerHTML = `
                <input type="checkbox" class="world-book-checkbox" ${isSelected ? 'checked' : ''} ${worldEditorAttr('worldEditorUi.selectBook', { name: book.name }, 'aria-label')}>
                <span class="world-book-name">${escapeHTML(book.name)}</span>
                <div class="world-book-actions">
                    <button class="world-editor-btn small-btn" data-action="edit"><i class="fas fa-pencil-alt"></i> ${worldEditorHtml('worldEditorUi.edit')}</button>
                    <button class="world-editor-btn small-btn" data-action="rename"><i class="fas fa-i-cursor"></i> ${worldEditorHtml('worldEditorUi.rename')}</button>
                </div>
            `;
            fragment.appendChild(row);
        });
        container.appendChild(fragment);
        refreshWorldEditorTranslations(container);
        this.bindWorldBookListEvents();
    }

    bindWorldBookListEvents() {
        this.elements.worldBookListContainer.querySelectorAll('.world-book-row').forEach(row => {
            const bookName = row.dataset.bookName;
            // 复选框事件
            row.querySelector('.world-book-checkbox').addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.selectedWorldBooks.add(bookName);
                } else {
                    this.selectedWorldBooks.delete(bookName);
                }
                row.classList.toggle('selected', e.target.checked);
                this.updateWorldBookSelectionUI();
            });

            // 按钮事件
            row.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.switchToEntryView(bookName);
            });
            row.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.renameWorldBook(bookName);
            });
        });
    }

    async createNewWorldBook() {
        const bookName = prompt(t('worldEditorUi.prompt.createBook'));
        if (bookName && bookName.trim()) {
            const trimmedBookName = bookName.trim();
            try {
                await compatibleWriteToLorebook(trimmedBookName, '新条目', () => '这是一个新条目', {});
                worldEditorToast('success', 'worldEditorUi.success.createdBook', { name: trimmedBookName });
                this.loadAvailableWorldBooks();
            } catch (error) {
                this.showError('worldEditorUi.error.createBook', { detail: error.message });
            }
        }
    }

    async renameWorldBook(oldName) {
        const newName = prompt(t('worldEditorUi.prompt.renameBook', { name: oldName }), oldName);
        if (newName && newName.trim() && newName !== oldName) {
            const trimmedNewName = newName.trim();
            try {
                const bookData = await loadWorldInfo(oldName);
                await saveWorldInfo(trimmedNewName, bookData);
                await deleteWorldInfo(oldName);
                worldEditorToast('success', 'worldEditorUi.success.renamed');

                await updateWorldInfoList();
                eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
                this.loadAvailableWorldBooks();
            } catch (error) {
                this.showError('worldEditorUi.error.renameBook', { detail: error.message });
            }
        }
    }

    async cloneSelectedBooks() {
        if (this.selectedWorldBooks.size === 0) return;
        if (!confirm(t('worldEditorUi.confirm.cloneBooks', { count: this.selectedWorldBooks.size }))) return;

        this.setLoading(true);
        try {
            for (const bookName of this.selectedWorldBooks) {
                const newName = `${bookName}_备份_${Date.now()}`;
                const bookData = await loadWorldInfo(bookName);
                await saveWorldInfo(newName, bookData);
            }
            worldEditorToast('success', 'worldEditorUi.success.cloned');

            await updateWorldInfoList();
            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
            this.loadAvailableWorldBooks();
        } catch (error) {
            this.showError('worldEditorUi.error.cloneBooks', { detail: error.message });
        } finally {
            this.setLoading(false);
        }
    }

    async deleteSelectedBooks() {
        if (this.selectedWorldBooks.size === 0) return;
        if (!confirm(t('worldEditorUi.confirm.deleteBooks', { count: this.selectedWorldBooks.size }))) return;

        this.setLoading(true);
        try {
            for (const bookName of this.selectedWorldBooks) {
                await deleteWorldInfo(bookName);
            }
            worldEditorToast('success', 'worldEditorUi.success.deletedBooks');

            await updateWorldInfoList();
            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
            this.loadAvailableWorldBooks();
        } catch (error) {
            this.showError('worldEditorUi.error.delete', { detail: error.message });
        } finally {
            this.setLoading(false);
        }
    }

    updateWorldBookCount() {
        setWorldEditorText(this.elements.worldBookCount, 'worldEditorUi.bookCount', { count: this.allWorldBooks.length });
    }

    updateWorldBookSelectionUI() {
        const count = this.selectedWorldBooks.size;
        setWorldEditorText(this.elements.worldBookSelectedCount, 'worldEditorUi.selectedCount', { count });
        this.elements.worldBookBatchActions.classList.toggle('active', count > 0);
    }


    // 条目数据处理 (大部分逻辑与旧版相似)
    async loadWorldBookEntries(worldBookName) {
        if (!worldBookName) {
            this.entries = [];
            this.filteredEntries = [];
            this.selectedEntries.clear();
            this.renderEntries();
            this.updateEntryCount();
            this.updateSelectionUI();
            return;
        }
        this.setLoading(true);
        this.currentWorldBook = worldBookName;
        try {
            const bookData = await loadWorldInfo(worldBookName);
            if (!bookData || !bookData.entries) {
                this.entries = [];
                this.filteredEntries = [];
                this.renderEntries();
                this.updateEntryCount();
                return;
            }
            
            const positionMap = { 
                0: 'before_character_definition', 
                1: 'after_character_definition', 
                2: 'before_author_note', 
                3: 'after_author_note', 
                4: 'at_depth' 
            };
            
            this.entries = Object.entries(bookData.entries).map(([uid, e]) => ({
                uid: parseInt(uid),
                enabled: !e.disable,
                type: e.constant ? 'constant' : 'selective',
                keys: e.key || [],
                content: e.content || '',
                position: positionMap[e.position] || 'at_depth',
                depth: normalizeFiniteInteger(e.depth, 4),
                order: normalizeFiniteInteger(e.order, 100),
                comment: e.comment || '',
                exclude_recursion: e.excludeRecursion || false,
                prevent_recursion: e.preventRecursion || false
            }));
            
            this.filteredEntries = [...this.entries];
            this.renderEntries();
            this.updateEntryCount();
        } catch (error) {
            this.showError('worldEditorUi.error.loadEntries', { detail: error.message });
            this.entries = [];
            this.filteredEntries = [];
        } finally {
            this.selectedEntries.clear();
            this.updateSelectionUI();
            this.setLoading(false);
        }
    }

    convertPositionFromNative(pos) {
        const map = { 0: 'before_character_definition', 1: 'after_character_definition', 2: 'before_author_note', 3: 'after_author_note', 4: 'at_depth' };
        return map[pos] || 'at_depth';
    }

    renderEntries() {
        const container = this.elements.worldEditorEntriesContainer;
        const header = container.querySelector('.world-editor-entries-header');
        
        while (header && header.nextSibling) {
            releaseWorldEditorTranslations(header.nextSibling);
            container.removeChild(header.nextSibling);
        }

        this.sortFilteredEntries();

        if (this.filteredEntries.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'world-editor-empty-state';
            emptyState.innerHTML = `<p>${worldEditorHtml('worldEditorUi.emptyEntries')}</p>`;
            container.appendChild(emptyState);
            refreshWorldEditorTranslations(container);
            return;
        }

        const fragment = document.createDocumentFragment();
        this.filteredEntries.forEach(e => {
            const rowHTML = this.renderEntryRow(e).trim();
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = rowHTML;
            const rowElement = tempDiv.firstChild;

            const contentCell = rowElement.querySelector('.world-editor-entry-content');
            if (contentCell) {
                contentCell.textContent = e.content || '';
            }

            fragment.appendChild(rowElement);
        });
        container.appendChild(fragment);
        refreshWorldEditorTranslations(container);
        this.bindEntryEvents();
    }

    renderEntryRow(entry) {
        const positionOptions = {
            'before_character_definition': 'worldEditorUi.position.beforeCharacter', 'after_character_definition': 'worldEditorUi.position.afterCharacter',
            'before_author_note': 'worldEditorUi.position.beforeNote', 'after_author_note': 'worldEditorUi.position.afterNote',
            'at_depth': 'worldEditorUi.position.depth', 'at_depth_as_system': 'worldEditorUi.position.depth'
        };
        const positionSelect = `<select class="inline-edit" data-field="position" data-uid="${escapeHTML(String(entry.uid))}">
            ${Object.entries(positionOptions).map(([value, key]) => worldEditorOption(value, key, entry.position === value)).join('')}
        </select>`;

        return `
            <div class="world-editor-entry-row ${this.selectedEntries.has(entry.uid) ? 'selected' : ''}" data-uid="${escapeHTML(String(entry.uid))}">
                <div ${worldEditorAttr('worldEditorUi.column.select', {}, 'data-label')}><input type="checkbox" class="world-editor-entry-checkbox" ${this.selectedEntries.has(entry.uid) ? 'checked' : ''} ${worldEditorAttr('worldEditorUi.selectEntry', { uid: entry.uid }, 'aria-label')}></div>
                <div ${worldEditorAttr('worldEditorUi.column.enabled', {}, 'data-label')} class="inline-toggle" data-field="enabled" data-uid="${escapeHTML(String(entry.uid))}" ${worldEditorAttr(entry.enabled ? 'worldEditorUi.inline.enabled' : 'worldEditorUi.inline.disabled')}><i class="fas ${entry.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></div>
                <div ${worldEditorAttr('worldEditorUi.column.type', {}, 'data-label')} class="inline-toggle" data-field="type" data-uid="${escapeHTML(String(entry.uid))}" ${worldEditorAttr(entry.type === 'constant' ? 'worldEditorUi.inline.constant' : 'worldEditorUi.inline.selective')}>${entry.type === 'constant' ? '🔵' : '🟢'}</div>
                <div class="world-editor-entry-comment" ${worldEditorAttr('worldEditorUi.column.comment', {}, 'data-label')}><input type="text" class="inline-edit" data-field="comment" data-uid="${escapeHTML(String(entry.uid))}" value="${escapeHTML(entry.comment || '')}" ${worldEditorAttr('worldEditorUi.inline.commentPlaceholder', {}, 'placeholder')}></div>
                <div ${worldEditorAttr('worldEditorUi.column.content', {}, 'data-label')} class="world-editor-entry-content" data-action="open-editor" data-uid="${escapeHTML(String(entry.uid))}" title="${escapeHTML(entry.content || '')}">${escapeHTML(entry.content || '')}</div>
                <div ${worldEditorAttr('worldEditorUi.column.position', {}, 'data-label')}>${positionSelect}</div>
                <div ${worldEditorAttr('worldEditorUi.column.depth', {}, 'data-label')}><input type="number" class="inline-edit" data-field="depth" data-uid="${escapeHTML(String(entry.uid))}" value="${escapeHTML(String(entry.depth != null ? entry.depth : ''))}" ${!String(entry.position)?.startsWith('at_depth') ? 'disabled' : ''}></div>
                <div ${worldEditorAttr('worldEditorUi.column.order', {}, 'data-label')}><input type="number" class="inline-edit" data-field="order" data-uid="${escapeHTML(String(entry.uid))}" value="${escapeHTML(String(entry.order))}"></div>
            </div>`;
    }

    bindEntryEvents() {
        this.elements.worldEditorEntriesContainer.querySelectorAll('.world-editor-entry-row').forEach(row => {
            const uid = parseInt(row.dataset.uid);
            const checkbox = row.querySelector('.world-editor-entry-checkbox');
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) this.selectedEntries.add(uid); else this.selectedEntries.delete(uid);
                row.classList.toggle('selected', e.target.checked);
                this.updateSelectionUI();
            });
            row.querySelector('[data-action="open-editor"]').addEventListener('click', () => this.openEditModal(uid));
            row.querySelectorAll('.inline-toggle').forEach(toggle => {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const field = toggle.dataset.field;
                    const entry = this.entries.find(e => e.uid === uid);
                    let newValue;
                    if (field === 'enabled') newValue = !entry.enabled;
                    if (field === 'type') newValue = entry.type === 'constant' ? 'selective' : 'constant';
                    this.updateSingleEntry(uid, { [field]: newValue });
                });
            });
            row.querySelectorAll('.inline-edit').forEach(input => {
                input.addEventListener('change', (e) => {
                    e.stopPropagation();
                    const field = input.dataset.field;
                    let value = input.value;
                    if (input.type === 'number') value = parseInt(value, 10);
                    const updates = { [field]: value };
                    if (field === 'position') {
                        const depthInput = row.querySelector('[data-field="depth"]');
                        if (depthInput) depthInput.disabled = !value.startsWith('at_depth');
                    }
                    this.updateSingleEntry(uid, updates);
                });
                input.addEventListener('click', e => e.stopPropagation());
            });
        });
    }

    /**
     * 使用原生 saveWorldInfo 更新条目，避免界面跳转
     * @param {Array<object>} entriesToUpdate - 需要更新的条目对象数组
     */
    async updateEntriesWithNativeMethod(entriesToUpdate) {
        try {
            // 将所有更新逻辑统一到 amilyHelper.setLorebookEntries
            await amilyHelper.setLorebookEntries(this.currentWorldBook, entriesToUpdate);

            // Optimistic UI update in local state
            for (const updatedEntry of entriesToUpdate) {
                const localEntry = this.entries.find(e => e.uid === updatedEntry.uid);
                if (localEntry) {
                    Object.assign(localEntry, updatedEntry);
                }
            }
            this.renderEntries();

        } catch (error) {
            this.showError('worldEditorUi.error.update', { detail: error.message });
            this.loadWorldBookEntries(this.currentWorldBook); // On error, re-sync with truth
        }
    }
    
    // Helper function to convert string position to native number format
    convertPositionToNative(posStr) {
        const map = {
            'before_character_definition': 0,
            'after_character_definition': 1,
            'before_author_note': 2,
            'after_author_note': 3,
            'at_depth': 4,
            'at_depth_as_system': 4
        };
        return map[posStr] !== undefined ? map[posStr] : 4;
    }

    async updateSingleEntry(uid, updates) {
        const entry = this.entries.find(e => e.uid === uid);
        if (!entry) return;
        const updatedEntry = { ...entry, ...updates };
        await this.updateEntriesWithNativeMethod([updatedEntry]);
    }

    async batchUpdateEntries(updates, confirmation = null) {
        if (this.selectedEntries.size === 0) return;
        if (confirmation && !confirm(confirmation)) return;

        const entriesToUpdate = this.entries
            .filter(e => this.selectedEntries.has(e.uid))
            .map(e => ({ ...e, ...updates }));

        await this.updateEntriesWithNativeMethod(entriesToUpdate);
        worldEditorToast('success', 'worldEditorUi.success.updatedEntries');
    }

    toggleBatchRecursion(field, fieldName) {
        if (this.selectedEntries.size === 0) return;
        const selected = this.entries.filter(e => this.selectedEntries.has(e.uid));
        const enabledCount = selected.filter(e => e[field]).length;
        const shouldEnable = enabledCount <= selected.length / 2;
        const action = t(shouldEnable ? 'worldEditorUi.enable' : 'worldEditorUi.disable');
        const confirmation = t('worldEditorUi.confirm.recursion', { count: this.selectedEntries.size, action, field: t(fieldName) });
        this.batchUpdateEntries({ [field]: shouldEnable }, confirmation);
    }

    async copySelectedEntries() {
        if (this.selectedEntries.size === 0) {
            this.showError('worldEditorUi.error.selectEntriesToCopy');
            return;
        }

        // 获取所有世界书列表（包括当前世界书，允许在同一世界书内复制）
        const availableBooks = this.allWorldBooks.map(book => book.name);

        if (availableBooks.length === 0) {
            this.showError('worldEditorUi.error.noBooks');
            return;
        }

        console.log('[世界书编辑器] 准备复制条目，已选择:', this.selectedEntries.size, '个条目');
        console.log('[世界书编辑器] 选中的UID:', Array.from(this.selectedEntries));

        // 创建选择对话框
        const selectHtml = `
            <style>
                .copy-dialog { padding: 20px; }
                .copy-dialog label { display: block; margin-bottom: 10px; color: #ccc; font-weight: bold; }
                .copy-dialog select { width: 100%; padding: 10px; background-color: #404040; color: white; border: 1px solid #555; border-radius: 4px; font-size: 14px; }
                .copy-dialog .info { margin-top: 15px; padding: 10px; background-color: #2a2a2a; border-left: 3px solid #4a9eff; color: #ccc; }
            </style>
            <div class="copy-dialog">
                <label for="target-worldbook">${worldEditorHtml('worldEditorUi.copy.target')}</label>
                <select id="target-worldbook" class="form-control"></select>
                <div class="info">
                    ${worldEditorHtml('worldEditorUi.copy.count', { count: this.selectedEntries.size })}
                </div>
            </div>
        `;

        showHtmlModal(worldEditorHtml('worldEditorUi.copyEntries'), selectHtml, {
            okText: worldEditorHtml('worldEditorUi.modal.confirm'),
            cancelText: worldEditorHtml('worldEditorUi.modal.cancel'),
            onShow: (dialog) => {
                const select = dialog.find('#target-worldbook').empty();
                availableBooks.forEach((name) => {
                    const option = document.createElement('option');
                    option.value = String(name);
                    option.textContent = String(name);
                    if (name === this.currentWorldBook) setWorldEditorText(option, 'worldEditorUi.copy.currentBook', { name });
                    option.selected = name === this.currentWorldBook;
                    select.append(option);
                });
                bindWorldEditorTranslations(dialog);
            },
            onOk: async (dialog) => {
                const targetBook = dialog.find('#target-worldbook').val();
                
                if (!targetBook) {
                    this.showError('worldEditorUi.error.selectTarget');
                    return false;
                }

                await this.performCopy(targetBook);
                return true;
            }
        });
    }

    async performCopy(targetBookName) {
        this.setLoading(true);
        try {
            // 获取要复制的条目
            const entriesToCopy = this.entries.filter(e => this.selectedEntries.has(e.uid));
            
            console.log('[世界书编辑器] 过滤后的条目数量:', entriesToCopy.length);
            console.log('[世界书编辑器] 条目详情:', entriesToCopy);
            
            if (entriesToCopy.length === 0) {
                this.showError('worldEditorUi.error.noSelectedEntries');
                return;
            }

            // 加载目标世界书
            const targetBookData = await loadWorldInfo(targetBookName);
            if (!targetBookData) {
                this.showError('worldEditorUi.error.targetMissing', { name: targetBookName });
                return;
            }

            // 准备要创建的条目数据
            const newEntries = entriesToCopy.map(entry => ({
                enabled: entry.enabled,
                type: entry.type,
                keys: Array.isArray(entry.keys) ? entry.keys : [],
                content: entry.content || '',
                position: entry.position,
                depth: entry.depth != null ? entry.depth : 4,
                order: entry.order != null ? entry.order : 100,
                comment: entry.comment || '',
                exclude_recursion: entry.exclude_recursion || false,
                prevent_recursion: entry.prevent_recursion || false
            }));

            console.log('[世界书编辑器] 准备创建的条目:', newEntries);

            // 在目标世界书中创建条目
            await amilyHelper.createLorebookEntries(targetBookName, newEntries);

            if (window.toastr) {
                worldEditorToast('success', 'worldEditorUi.success.copied', { count: entriesToCopy.length, name: targetBookName });
            }

            // 如果复制到当前世界书，刷新视图
            if (targetBookName === this.currentWorldBook) {
                await this.loadWorldBookEntries(this.currentWorldBook);
            }
            
        } catch (error) {
            console.error('[世界书编辑器] 复制失败:', error);
            this.showError('worldEditorUi.error.copy', { detail: error.message });
        } finally {
            this.setLoading(false);
        }
    }

    async batchDeleteEntries() {
        if (this.selectedEntries.size === 0 || !confirm(t('worldEditorUi.confirm.deleteEntries', { count: this.selectedEntries.size }))) return;
        try {
            const bookData = await loadWorldInfo(this.currentWorldBook);
            if (!bookData) throw worldEditorError('worldEditorUi.error.bookMissing', { name: this.currentWorldBook });
            this.selectedEntries.forEach(uid => {
                delete bookData.entries[uid];
            });
            await saveWorldInfo(this.currentWorldBook, bookData, true);
            this.loadWorldBookEntries(this.currentWorldBook);
        } catch (error) {
            this.showError('worldEditorUi.error.delete', worldEditorErrorParams(error));
        }
    }

    toggleSelectAll(checked) {
        this.selectedEntries.clear();
        if (checked) this.filteredEntries.forEach(e => this.selectedEntries.add(e.uid));
        this.renderEntries();
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        const count = this.selectedEntries.size;
        setWorldEditorText(this.elements.worldEditorSelectedCount, 'worldEditorUi.selectedCount', { count });
        this.elements.worldEditorBatchActions.classList.toggle('active', count > 0);
        this.elements.worldEditorSelectAll.checked = count > 0 && count === this.filteredEntries.length;
        this.elements.worldEditorSelectAll.indeterminate = count > 0 && count < this.filteredEntries.length;
    }

    updateEntryCount() { setWorldEditorText(this.elements.worldEditorEntryCount, 'worldEditorUi.entryCount', { count: this.entries.length }); }

    filterEntries() {
        const term = this.elements.worldEditorSearchBox.value.toLowerCase();
        const searchType = this.elements.worldEditorSearchType.value;
        this.filteredEntries = !term ? [...this.entries] : this.entries.filter(e => (e[searchType] || '').toLowerCase().includes(term));
        this.renderEntries();
    }

    openCreateModal() {
        this.currentEditingEntry = null;
        const entry = { enabled: true, type: 'selective', keys: [], content: '', position: 'at_depth', depth: 4, order: 100, comment: '' };
        this.showEditModal('worldEditorUi.modal.createTitle', entry);
    }

    openEditModal(uid) {
        const entry = this.entries.find(e => e.uid === uid);
        if (!entry) return;
        this.currentEditingEntry = entry;
        this.showEditModal('worldEditorUi.modal.editTitle', entry);
    }

    showEditModal(title, entry) {
        const formHtml = this.getEditFormHtml();
        showHtmlModal(worldEditorHtml(title), formHtml, {
            okText: worldEditorHtml('worldEditorUi.modal.confirm'),
            cancelText: worldEditorHtml('worldEditorUi.modal.cancel'),
            onShow: (dialog) => this.populateEditForm(dialog, entry),
            onOk: (dialog) => {
                this.saveEntry(dialog);
                return true;
            },
        });
    }

    getEditFormHtml() {
        return `
            <style>
                .world-editor-form-grid { display: grid; grid-template-columns: minmax(0, 120px) minmax(0, 1fr); gap: 15px; align-items: center; }
                .world-editor-form-grid label { text-align: right; color: #ccc; overflow-wrap: anywhere; }
                .world-editor-form-grid .form-control { min-width: 0; width: 100%; padding: 8px; background-color: #404040; color: white; border: 1px solid #555; border-radius: 4px; box-sizing: border-box; }
                .world-editor-form-grid textarea.form-control { min-height: 100px; resize: vertical; }
                .world-editor-form-grid .full-width { grid-column: 1 / -1; }
                .world-editor-form-grid .checkbox-group { grid-column: 2 / -1; display: flex; align-items: center; gap: 8px; min-width: 0; }
                .world-editor-form-grid .checkbox-group label { min-width: 0; text-align: left; }
                @media (max-width: 480px) {
                    .world-editor-form-grid { grid-template-columns: minmax(0, 1fr); }
                    .world-editor-form-grid .checkbox-group { grid-column: 1 / -1; }
                    .world-editor-form-grid label { text-align: left; }
                }
            </style>
            <form id="world-editor-edit-form" class="world-editor-form-grid">
                <div class="checkbox-group"><input type="checkbox" id="world-editor-entry-enabled"><label for="world-editor-entry-enabled">${worldEditorHtml('worldEditorUi.form.enabled')}</label></div>
                <label for="world-editor-entry-type">${worldEditorHtml('worldEditorUi.form.type')}</label><select id="world-editor-entry-type" class="form-control">${worldEditorOption('selective', 'worldEditorUi.form.selective')}${worldEditorOption('constant', 'worldEditorUi.form.constant')}</select>
                <label for="world-editor-entry-keys" class="full-width" style="text-align: left; grid-column: 1 / -1;">${worldEditorHtml('worldEditorUi.form.keys')}</label><textarea id="world-editor-entry-keys" class="form-control full-width" ${worldEditorAttr('worldEditorUi.form.keysPlaceholder', {}, 'placeholder')}></textarea>
                <label for="world-editor-entry-content" class="full-width" style="text-align: left; grid-column: 1 / -1;">${worldEditorHtml('worldEditorUi.form.content')}</label><textarea id="world-editor-entry-content" class="form-control full-width" ${worldEditorAttr('worldEditorUi.form.contentPlaceholder', {}, 'placeholder')}></textarea>
                <label for="world-editor-entry-position">${worldEditorHtml('worldEditorUi.form.position')}</label><select id="world-editor-entry-position" class="form-control">${worldEditorOption('before_character_definition', 'worldEditorUi.form.beforeCharacter')}${worldEditorOption('after_character_definition', 'worldEditorUi.form.afterCharacter')}${worldEditorOption('before_author_note', 'worldEditorUi.form.beforeNote')}${worldEditorOption('after_author_note', 'worldEditorUi.form.afterNote')}${worldEditorOption('at_depth', 'worldEditorUi.form.atDepth')}</select>
                <label for="world-editor-entry-depth">${worldEditorHtml('worldEditorUi.form.depth')}</label><input type="number" id="world-editor-entry-depth" class="form-control" min="0" max="9999">
                <label for="world-editor-entry-order">${worldEditorHtml('worldEditorUi.form.order')}</label><input type="number" id="world-editor-entry-order" class="form-control" min="0" max="9999">
                <label for="world-editor-entry-comment">${worldEditorHtml('worldEditorUi.form.comment')}</label><input type="text" id="world-editor-entry-comment" class="form-control" ${worldEditorAttr('worldEditorUi.form.commentPlaceholder', {}, 'placeholder')}>
                <div class="checkbox-group"><input type="checkbox" id="world-editor-entry-disable-recursion"><label for="world-editor-entry-disable-recursion">${worldEditorHtml('worldEditorUi.form.excludeRecursion')}</label></div>
                <div class="checkbox-group"><input type="checkbox" id="world-editor-entry-prevent-recursion"><label for="world-editor-entry-prevent-recursion">${worldEditorHtml('worldEditorUi.form.preventRecursion')}</label></div>
            </form>
        `;
    }

    populateEditForm(dialog, entry) {
        const source = entry && typeof entry === 'object' ? entry : {};
        const keys = Array.isArray(source.keys)
            ? source.keys.map((key) => String(key)).join('\n')
            : String(source.keys ?? '');
        const type = source.type === 'constant' ? 'constant' : 'selective';
        const positions = [
            'before_character_definition',
            'after_character_definition',
            'before_author_note',
            'after_author_note',
            'at_depth',
        ];
        const position = positions.includes(source.position) ? source.position : 'at_depth';

        dialog.find('#world-editor-entry-enabled').prop('checked', Boolean(source.enabled));
        dialog.find('#world-editor-entry-type').val(type);
        dialog.find('#world-editor-entry-keys').val(keys);
        dialog.find('#world-editor-entry-content').val(String(source.content ?? ''));
        dialog.find('#world-editor-entry-position').val(position);
        dialog.find('#world-editor-entry-depth').val(normalizeFiniteInteger(source.depth, 4));
        dialog.find('#world-editor-entry-order').val(normalizeFiniteInteger(source.order, 100));
        dialog.find('#world-editor-entry-comment').val(String(source.comment ?? ''));
        dialog.find('#world-editor-entry-disable-recursion').prop('checked', Boolean(source.exclude_recursion));
        dialog.find('#world-editor-entry-prevent-recursion').prop('checked', Boolean(source.prevent_recursion));
        bindWorldEditorTranslations(dialog);
    }

    async saveEntry(dialog) {
        const formData = this.getFormDataFromModal(dialog);
        try {
            if (this.currentEditingEntry) {
                // 使用改造后的原生方法更新
                await this.updateEntriesWithNativeMethod([{ ...this.currentEditingEntry, ...formData }]);
            } else {
                // 创建条目仍然可以使用TavernHelper，因为它通常不会触发跳转
                await amilyHelper.createLorebookEntries(this.currentWorldBook, [formData]);
            }
            // 刷新当前视图
            this.loadWorldBookEntries(this.currentWorldBook);
        } catch (error) {
            this.showError('worldEditorUi.error.save', { detail: error.message });
        }
    }

    getFormDataFromModal(dialog) {
        return {
            enabled: dialog.find('#world-editor-entry-enabled').is(':checked'),
            type: dialog.find('#world-editor-entry-type').val(),
            keys: dialog.find('#world-editor-entry-keys').val().split('\n').map(k => k.trim()).filter(Boolean),
            content: dialog.find('#world-editor-entry-content').val(),
            position: dialog.find('#world-editor-entry-position').val(),
            depth: parseInt(dialog.find('#world-editor-entry-depth').val()),
            order: parseInt(dialog.find('#world-editor-entry-order').val()),
            comment: dialog.find('#world-editor-entry-comment').val(),
            exclude_recursion: dialog.find('#world-editor-entry-disable-recursion').is(':checked'),
            prevent_recursion: dialog.find('#world-editor-entry-prevent-recursion').is(':checked')
        };
    }

    setLoading(loading) {
        this.isLoading = loading;
        document.getElementById('world-editor-container').classList.toggle('loading', loading);
    }
    showError(key, params = {}) {
        worldEditorToast('error', key, params);
        console.error(t(key, typeof params === 'function' ? params() : params));
    }

    sortEntries(key) {
        if (this.sortState.key === key) this.sortState.asc = !this.sortState.asc;
        else { this.sortState.key = key; this.sortState.asc = true; }
        this.renderEntries();
    }

    sortFilteredEntries() {
        const { key, asc } = this.sortState;
        this.filteredEntries.sort((a, b) => {
            let valA = a[key], valB = b[key];
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();
            if (valA < valB) return asc ? -1 : 1;
            if (valA > valB) return asc ? 1 : -1;
            return 0;
        });
    }

    bindExternalEvents() {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            console.log('[世界书编辑器] 检测到聊天变更，将自动刷新。');
            if (this.currentWorldBook) {
                this.loadWorldBookEntries(this.currentWorldBook);
            } else {
                this.loadAvailableWorldBooks();
            }
        });
        console.log('[世界书编辑器] 已成功绑定外部事件监听器。');
    }
}

function initializeWorldEditor() {
    const panel = document.getElementById('amily2_world_editor_panel');
    if (!panel) {
        console.error('[WorldEditor] Panel not found, initialization aborted.');
        return;
    }
    if (panel.dataset.initialized) {
        return;
    }
    panel.dataset.initialized = 'true';
    console.log('[WorldEditor] Initializing WorldEditor instance.');
    window.worldEditorInstance = new WorldEditor();
}

function tryInitialize() {
    const panel = document.getElementById('amily2_world_editor_panel');
    if (panel) {
        initializeWorldEditor();
    } else {
        const observer = new MutationObserver((mutations, obs) => {
            const panel = document.getElementById('amily2_world_editor_panel');
            if (panel) {
                obs.disconnect();
                initializeWorldEditor();
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInitialize);
} else {
    tryInitialize();
}
