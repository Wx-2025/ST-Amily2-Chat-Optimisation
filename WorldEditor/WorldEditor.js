
import { world_names, loadWorldInfo, saveWorldInfo, deleteWorldInfo, updateWorldInfoList } from "/scripts/world-info.js";
import { eventSource, event_types } from '/script.js';
import { showHtmlModal } from '../ui/page-window.js';
import { safeLorebooks, safeLorebookEntries, safeUpdateLorebookEntries, compatibleWriteToLorebook } from '../core/tavernhelper-compatibility.js';
import { amilyHelper } from '../core/tavern-helper/main.js';
import { escapeHTML } from '../utils/utils.js';
const { SillyTavern } = window;

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
        this.elements.worldEditorSetDisableRecursionBtn.addEventListener('click', () => this.toggleBatchRecursion('exclude_recursion', '不可递归'));
        this.elements.worldEditorSetPreventRecursionBtn.addEventListener('click', () => this.toggleBatchRecursion('prevent_recursion', '防止递归'));
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
        this.elements.worldEditorCurrentBookTitle.textContent = `当前编辑：${bookName}`;
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
            this.showError('加载世界书列表失败: ' + error.message);
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
        container.innerHTML = ''; // 清空
        if (this.filteredWorldBooks.length === 0) {
            container.innerHTML = '<p class="world-editor-empty-state">没有找到世界书</p>';
            return;
        }

        const fragment = document.createDocumentFragment();
        this.filteredWorldBooks.forEach(book => {
            const isSelected = this.selectedWorldBooks.has(book.name);
            const row = document.createElement('div');
            row.className = `world-book-row ${isSelected ? 'selected' : ''}`;
            row.dataset.bookName = book.name;
            row.innerHTML = `
                <input type="checkbox" class="world-book-checkbox" ${isSelected ? 'checked' : ''}>
                <span class="world-book-name">${escapeHTML(book.name)}</span>
                <div class="world-book-actions">
                    <button class="world-editor-btn small-btn" data-action="edit"><i class="fas fa-pencil-alt"></i> 编辑</button>
                    <button class="world-editor-btn small-btn" data-action="rename"><i class="fas fa-i-cursor"></i> 重命名</button>
                </div>
            `;
            fragment.appendChild(row);
        });
        container.appendChild(fragment);
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
        const bookName = prompt("请输入新的世界书名称：");
        if (bookName && bookName.trim()) {
            const trimmedBookName = bookName.trim();
            try {
                await compatibleWriteToLorebook(trimmedBookName, '新条目', () => '这是一个新条目', {});
                if (window.toastr) window.toastr.success(`世界书 "${trimmedBookName}" 创建成功！`);
                this.loadAvailableWorldBooks();
            } catch (error) {
                this.showError(`创建失败: ${error.message}`);
            }
        }
    }

    async renameWorldBook(oldName) {
        const newName = prompt(`重命名世界书 "${oldName}":`, oldName);
        if (newName && newName.trim() && newName !== oldName) {
            const trimmedNewName = newName.trim();
            try {
                const bookData = await loadWorldInfo(oldName);
                await saveWorldInfo(trimmedNewName, bookData);
                await deleteWorldInfo(oldName);
                if (window.toastr) window.toastr.success('重命名成功！');

                await updateWorldInfoList();
                eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
                this.loadAvailableWorldBooks();
            } catch (error) {
                this.showError(`重命名失败: ${error.message}`);
            }
        }
    }

    async cloneSelectedBooks() {
        if (this.selectedWorldBooks.size === 0) return;
        if (!confirm(`确定要为 ${this.selectedWorldBooks.size} 个世界书创建备份吗？`)) return;

        this.setLoading(true);
        try {
            for (const bookName of this.selectedWorldBooks) {
                const newName = `${bookName}_备份_${Date.now()}`;
                const bookData = await loadWorldInfo(bookName);
                await saveWorldInfo(newName, bookData);
            }
            if (window.toastr) window.toastr.success('备份创建成功！');

            await updateWorldInfoList();
            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
            this.loadAvailableWorldBooks();
        } catch (error) {
            this.showError(`备份失败: ${error.message}`);
        } finally {
            this.setLoading(false);
        }
    }

    async deleteSelectedBooks() {
        if (this.selectedWorldBooks.size === 0) return;
        if (!confirm(`警告：这将永久删除 ${this.selectedWorldBooks.size} 个世界书及其所有内容！确定要继续吗？`)) return;

        this.setLoading(true);
        try {
            for (const bookName of this.selectedWorldBooks) {
                await deleteWorldInfo(bookName);
            }
            if (window.toastr) window.toastr.success('批量删除成功！');

            await updateWorldInfoList();
            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
            this.loadAvailableWorldBooks();
        } catch (error) {
            this.showError(`删除失败: ${error.message}`);
        } finally {
            this.setLoading(false);
        }
    }

    updateWorldBookCount() {
        this.elements.worldBookCount.textContent = `世界书：${this.allWorldBooks.length}`;
    }

    updateWorldBookSelectionUI() {
        const count = this.selectedWorldBooks.size;
        this.elements.worldBookSelectedCount.textContent = `已选择 ${count} 项`;
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
                depth: e.depth != null ? e.depth : 4,
                order: e.order != null ? e.order : 100,
                comment: e.comment || '',
                exclude_recursion: e.excludeRecursion || false,
                prevent_recursion: e.preventRecursion || false
            }));
            
            this.filteredEntries = [...this.entries];
            this.renderEntries();
            this.updateEntryCount();
        } catch (error) {
            this.showError(`加载条目失败: ${error.message}`);
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
            container.removeChild(header.nextSibling);
        }

        this.sortFilteredEntries();

        if (this.filteredEntries.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'world-editor-empty-state';
            emptyState.innerHTML = '<p>没有条目</p>';
            container.appendChild(emptyState);
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
        this.bindEntryEvents();
    }

    renderEntryRow(entry) {
        const positionOptions = {
            'before_character_definition': '角色前', 'after_character_definition': '角色后',
            'before_author_note': '注释前', 'after_author_note': '注释后',
            'at_depth': '@D深度', 'at_depth_as_system': '@D深度'
        };
        const positionSelect = `<select class="inline-edit" data-field="position" data-uid="${entry.uid}">
            ${Object.entries(positionOptions).map(([value, text]) => `<option value="${value}" ${entry.position === value ? 'selected' : ''}>${text}</option>`).join('')}
        </select>`;

        return `
            <div class="world-editor-entry-row ${this.selectedEntries.has(entry.uid) ? 'selected' : ''}" data-uid="${entry.uid}">
                <div data-label="选择"><input type="checkbox" class="world-editor-entry-checkbox" ${this.selectedEntries.has(entry.uid) ? 'checked' : ''}></div>
                <div data-label="状态" class="inline-toggle" data-field="enabled" data-uid="${entry.uid}"><i class="fas ${entry.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></div>
                <div data-label="灯色" class="inline-toggle" data-field="type" data-uid="${entry.uid}">${entry.type === 'constant' ? '🔵' : '🟢'}</div>
                <div data-label="条目"><input type="text" class="inline-edit" data-field="comment" data-uid="${entry.uid}" value="${escapeHTML(entry.comment || '')}" placeholder="点击填写条目名"></div>
                <div data-label="内容" class="world-editor-entry-content" data-action="open-editor" data-uid="${entry.uid}" title="${escapeHTML(entry.content || '')}">${escapeHTML(entry.content || '')}</div>
                <div data-label="位置">${positionSelect}</div>
                <div data-label="深度"><input type="number" class="inline-edit" data-field="depth" data-uid="${entry.uid}" value="${entry.depth != null ? entry.depth : ''}" ${!String(entry.position)?.startsWith('at_depth') ? 'disabled' : ''}></div>
                <div data-label="顺序"><input type="number" class="inline-edit" data-field="order" data-uid="${entry.uid}" value="${entry.order}"></div>
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
            this.showError(`更新失败: ${error.message}`);
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
        if (window.toastr) window.toastr.success('批量更新成功！');
    }

    toggleBatchRecursion(field, fieldName) {
        if (this.selectedEntries.size === 0) return;
        const selected = this.entries.filter(e => this.selectedEntries.has(e.uid));
        const enabledCount = selected.filter(e => e[field]).length;
        const shouldEnable = enabledCount <= selected.length / 2;
        const action = shouldEnable ? '启用' : '禁用';
        const confirmation = `确定为 ${this.selectedEntries.size} 个条目 ${action} "${fieldName}" 吗?`;
        this.batchUpdateEntries({ [field]: shouldEnable }, confirmation);
    }

    async copySelectedEntries() {
        if (this.selectedEntries.size === 0) {
            this.showError('请先选择要复制的条目');
            return;
        }

        // 获取所有世界书列表（包括当前世界书，允许在同一世界书内复制）
        const availableBooks = this.allWorldBooks.map(book => book.name);

        if (availableBooks.length === 0) {
            this.showError('没有可用的世界书');
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
                <label for="target-worldbook">选择目标世界书：</label>
                <select id="target-worldbook" class="form-control">
                    ${availableBooks.map(name => `<option value="${escapeHTML(name)}" ${name === this.currentWorldBook ? 'selected' : ''}>${escapeHTML(name)}${name === this.currentWorldBook ? ' (当前)' : ''}</option>`).join('')}
                </select>
                <div class="info">
                    将复制 ${this.selectedEntries.size} 个条目到目标世界书
                </div>
            </div>
        `;

        showHtmlModal('复制条目', selectHtml, {
            onOk: async (dialog) => {
                const targetBook = dialog.find('#target-worldbook').val();
                
                if (!targetBook) {
                    this.showError('请选择目标世界书');
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
                this.showError('没有选中的条目');
                return;
            }

            // 加载目标世界书
            const targetBookData = await loadWorldInfo(targetBookName);
            if (!targetBookData) {
                this.showError(`目标世界书 "${targetBookName}" 不存在`);
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
                window.toastr.success(`成功复制 ${entriesToCopy.length} 个条目到 "${targetBookName}"`);
            }

            // 如果复制到当前世界书，刷新视图
            if (targetBookName === this.currentWorldBook) {
                await this.loadWorldBookEntries(this.currentWorldBook);
            }
            
        } catch (error) {
            console.error('[世界书编辑器] 复制失败:', error);
            this.showError(`复制失败: ${error.message}`);
        } finally {
            this.setLoading(false);
        }
    }

    async batchDeleteEntries() {
        if (this.selectedEntries.size === 0 || !confirm(`删除 ${this.selectedEntries.size} 个条目?`)) return;
        try {
            const bookData = await loadWorldInfo(this.currentWorldBook);
            if (!bookData) throw new Error(`World book "${this.currentWorldBook}" not found.`);
            this.selectedEntries.forEach(uid => {
                delete bookData.entries[uid];
            });
            await saveWorldInfo(this.currentWorldBook, bookData, true);
            this.loadWorldBookEntries(this.currentWorldBook);
        } catch (error) {
            this.showError(`删除失败: ${error.message}`);
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
        this.elements.worldEditorSelectedCount.textContent = `已选择 ${count} 项`;
        this.elements.worldEditorBatchActions.classList.toggle('active', count > 0);
        this.elements.worldEditorSelectAll.checked = count > 0 && count === this.filteredEntries.length;
        this.elements.worldEditorSelectAll.indeterminate = count > 0 && count < this.filteredEntries.length;
    }

    updateEntryCount() { this.elements.worldEditorEntryCount.textContent = `条目：${this.entries.length}`; }

    filterEntries() {
        const term = this.elements.worldEditorSearchBox.value.toLowerCase();
        const searchType = this.elements.worldEditorSearchType.value;
        this.filteredEntries = !term ? [...this.entries] : this.entries.filter(e => (e[searchType] || '').toLowerCase().includes(term));
        this.renderEntries();
    }

    openCreateModal() {
        this.currentEditingEntry = null;
        const entry = { enabled: true, type: 'selective', keys: [], content: '', position: 'at_depth', depth: 4, order: 100, comment: '' };
        this.showEditModal('创建新条目', entry);
    }

    openEditModal(uid) {
        const entry = this.entries.find(e => e.uid === uid);
        if (!entry) return;
        this.currentEditingEntry = entry;
        this.showEditModal('编辑条目', entry);
    }

    showEditModal(title, entry) {
        const formHtml = this.getEditFormHtml(entry);
        showHtmlModal(title, formHtml, { onOk: (d) => { this.saveEntry(d); return true; } });
    }

    getEditFormHtml(entry) {
        return `
            <style>
                .world-editor-form-grid { display: grid; grid-template-columns: 120px 1fr; gap: 15px; align-items: center; }
                .world-editor-form-grid label { text-align: right; color: #ccc; }
                .world-editor-form-grid .form-control { width: 100%; padding: 8px; background-color: #404040; color: white; border: 1px solid #555; border-radius: 4px; box-sizing: border-box; }
                .world-editor-form-grid textarea.form-control { min-height: 100px; resize: vertical; }
                .world-editor-form-grid .full-width { grid-column: 1 / -1; }
                .world-editor-form-grid .checkbox-group { grid-column: 2 / -1; display: flex; align-items: center; gap: 8px; }
            </style>
            <form id="world-editor-edit-form" class="world-editor-form-grid">
                <div class="checkbox-group"><input type="checkbox" id="world-editor-entry-enabled" ${entry.enabled ? 'checked' : ''}><label for="world-editor-entry-enabled">启用条目</label></div>
                <label for="world-editor-entry-type">激活模式：</label><select id="world-editor-entry-type" class="form-control"><option value="selective" ${entry.type === 'selective' ? 'selected' : ''}>🟢 绿灯 (关键词触发)</option><option value="constant" ${entry.type === 'constant' ? 'selected' : ''}>🔵 蓝灯 (始终激活)</option></select>
                <label for="world-editor-entry-keys" class="full-width" style="text-align: left; grid-column: 1 / -1;">关键词 (每行一个)：</label><textarea id="world-editor-entry-keys" class="form-control full-width" placeholder="输入关键词，每行一个">${(entry.keys || []).join('\n')}</textarea>
                <label for="world-editor-entry-content" class="full-width" style="text-align: left; grid-column: 1 / -1;">内容：</label><textarea id="world-editor-entry-content" class="form-control full-width" placeholder="输入条目内容">${entry.content || ''}</textarea>
                <label for="world-editor-entry-position">插入位置：</label><select id="world-editor-entry-position" class="form-control"><option value="before_character_definition" ${entry.position === 'before_character_definition' ? 'selected' : ''}>角色定义之前</option><option value="after_character_definition" ${entry.position === 'after_character_definition' ? 'selected' : ''}>角色定义之后</option><option value="before_author_note" ${entry.position === 'before_author_note' ? 'selected' : ''}>作者注释之前</option><option value="after_author_note" ${entry.position === 'after_author_note' ? 'selected' : ''}>作者注释之后</option><option value="at_depth" ${entry.position === 'at_depth' ? 'selected' : ''}>@D 注入指定深度</option></select>
                <label for="world-editor-entry-depth">深度：</label><input type="number" id="world-editor-entry-depth" class="form-control" min="0" max="9999" value="${entry.depth || 4}">
                <label for="world-editor-entry-order">顺序：</label><input type="number" id="world-editor-entry-order" class="form-control" min="0" max="9999" value="${entry.order || 100}">
                <label for="world-editor-entry-comment">备注：</label><input type="text" id="world-editor-entry-comment" class="form-control" placeholder="可选的备注信息" value="${entry.comment || ''}">
                <div class="checkbox-group"><input type="checkbox" id="world-editor-entry-disable-recursion" ${entry.exclude_recursion ? 'checked' : ''}><label for="world-editor-entry-disable-recursion">不可递归 (不会被其他条目激活)</label></div>
                <div class="checkbox-group"><input type="checkbox" id="world-editor-entry-prevent-recursion" ${entry.prevent_recursion ? 'checked' : ''}><label for="world-editor-entry-prevent-recursion">防止进一步递归 (本条目将不会激活其他条目)</label></div>
            </form>
        `;
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
            this.showError(`保存失败: ${error.message}`);
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
    showError(msg) { if (window.toastr) window.toastr.error(msg); console.error(msg); }

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
