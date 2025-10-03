/**
 * 世界书编辑器 - 最终稳定版
 */
import { world_names, loadWorldInfo, saveWorldInfo } from "/scripts/world-info.js";
import { eventSource, event_types } from '/script.js';
import { showHtmlModal } from '/scripts/extensions/third-party/ST-Amily2-Chat-Optimisation/ui/page-window.js';
const { SillyTavern, TavernHelper } = window;

class WorldEditor {
    constructor() {
        this.currentWorldBook = null;
        this.entries = [];
        this.selectedEntries = new Set();
        this.filteredEntries = [];
        this.isLoading = false;
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
        this.bindExternalEvents(); // 绑定外部事件监听
    }

    initializeComponents() {
        const ids = [
            'world-editor-world-select', 'world-editor-refresh-btn', 'world-editor-create-entry-btn',
            'world-editor-search-box', 'world-editor-search-btn', 'world-editor-entry-count',
            'world-editor-select-all', 'world-editor-selected-count', 'world-editor-batch-actions',
            'world-editor-entries-container',
            'world-editor-enable-selected-btn', 'world-editor-disable-selected-btn',
            'world-editor-set-blue-btn', 'world-editor-set-green-btn', 'world-editor-delete-selected-btn',
            'world-editor-set-disable-recursion-btn', 'world-editor-set-prevent-recursion-btn'
        ];
        this.elements = {};
        let missing = false;
        for (const id of ids) {
            const camelCaseId = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
            this.elements[camelCaseId] = document.getElementById(id);
            if (!this.elements[camelCaseId] && id.endsWith('container')) { // Only container is critical
                console.error(`[世界书编辑器] 关键元素缺失: ${id}`);
                missing = true;
            }
        }
        return !missing;
    }

    bindEvents() {
        this.elements.worldEditorWorldSelect.addEventListener('change', (e) => this.loadWorldBookEntries(e.target.value));
        this.elements.worldEditorRefreshBtn.addEventListener('click', () => this.loadAvailableWorldBooks());
        document.querySelector('#world-editor-container .world-editor-entries-header').addEventListener('click', (e) => {
            if (e.target.dataset.sort) {
                this.sortEntries(e.target.dataset.sort);
            }
        });
        this.elements.worldEditorCreateEntryBtn.addEventListener('click', () => this.openCreateModal());
        this.elements.worldEditorSearchBox.addEventListener('input', () => this.filterEntries());
        this.elements.worldEditorSearchBtn.addEventListener('click', () => this.filterEntries());
        this.elements.worldEditorSelectAll.addEventListener('change', (e) => this.toggleSelectAll(e.target.checked));
        this.elements.worldEditorEnableSelectedBtn.addEventListener('click', () => this.batchUpdateEntries({ enabled: true }));
        this.elements.worldEditorDisableSelectedBtn.addEventListener('click', () => this.batchUpdateEntries({ enabled: false }));
        this.elements.worldEditorSetBlueBtn.addEventListener('click', () => this.batchUpdateEntries({ type: 'constant' }));
        this.elements.worldEditorSetGreenBtn.addEventListener('click', () => this.batchUpdateEntries({ type: 'selective' }));
        this.elements.worldEditorDeleteSelectedBtn.addEventListener('click', () => this.batchDeleteEntries());
        this.elements.worldEditorSetDisableRecursionBtn.addEventListener('click', () => this.toggleBatchRecursion('exclude_recursion', '不可递归'));
        this.elements.worldEditorSetPreventRecursionBtn.addEventListener('click', () => this.toggleBatchRecursion('prevent_recursion', '防止递归'));
    }

    async loadAvailableWorldBooks() {
        this.setLoading(true);
        try {
            const books = await this.getAllWorldBooks();
            const select = this.elements.worldEditorWorldSelect;
            select.innerHTML = '<option value="">请选择世界书...</option>';
            books.forEach(book => {
                const option = document.createElement('option');
                option.value = book.name;
                option.textContent = book.name;
                select.appendChild(option);
            });
            await this.selectCurrentCharacterWorldBook();
        } catch (error) {
            this.showError('加载世界书列表失败: ' + error.message);
        } finally {
            this.setLoading(false);
        }
    }

    async getAllWorldBooks() {
        if (TavernHelper?.getLorebooks) {
            const books = await TavernHelper.getLorebooks();
            if (Array.isArray(books) && books.length > 0) return books.map(name => ({ name }));
        }
        return (world_names || []).map(name => ({ name }));
    }

    async selectCurrentCharacterWorldBook() {
        if (TavernHelper?.getCurrentCharPrimaryLorebook) {
            const primaryBook = await TavernHelper.getCurrentCharPrimaryLorebook();
            if (primaryBook) {
                this.elements.worldEditorWorldSelect.value = primaryBook;
                await this.loadWorldBookEntries(primaryBook);
            }
        }
    }

    async loadWorldBookEntries(worldBookName) {
        if (!worldBookName) { this.entries = []; this.renderEntries(); return; }
        this.setLoading(true);
        this.currentWorldBook = worldBookName;
        try {
            let rawEntries = await TavernHelper?.getLorebookEntries?.(worldBookName);
            if (!rawEntries || rawEntries.length === 0) {
                const bookData = await loadWorldInfo(worldBookName);
                if (bookData?.entries) {
                    rawEntries = Object.entries(bookData.entries).map(([uid, entry]) => ({
                        uid: parseInt(uid), enabled: !entry.disable, type: entry.constant ? 'constant' : 'selective',
                        keys: entry.key || [], content: entry.content || '', position: this.convertPositionFromNative(entry.position),
                        depth: entry.depth, order: entry.order, comment: entry.comment || ''
                    }));
                }
            }
            this.entries = (rawEntries || []).map(e => ({
                uid: e.uid, enabled: e.enabled, type: e.type || (e.constant ? 'constant' : 'selective'),
                keys: e.keys || [], content: e.content || '', position: e.position || 'before_character_definition',
                depth: (e.position?.startsWith('at_depth')) ? e.depth : null, order: e.order || 100, comment: e.comment || '',
                exclude_recursion: e.exclude_recursion, prevent_recursion: e.prevent_recursion
            }));
            this.filteredEntries = [...this.entries];
            this.renderEntries();
            this.updateEntryCount();
        } catch (error) {
            this.showError(`加载条目失败: ${error.message}`);
            this.entries = []; this.renderEntries();
        } finally {
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
        
        // Clear only the entry rows, not the header
        while (container.firstChild && container.firstChild !== header) {
            container.removeChild(container.firstChild);
        }
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

            // Safely set the content to prevent HTML rendering
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
                <div data-label="条目"><input type="text" class="inline-edit" data-field="comment" data-uid="${entry.uid}" value="${entry.comment || ''}" placeholder="点击填写条目名"></div>
                <div data-label="内容" class="world-editor-entry-content" data-action="open-editor" data-uid="${entry.uid}" title="${entry.content || ''}">${entry.content || ''}</div>
                <div data-label="位置">${positionSelect}</div>
                <div data-label="深度"><input type="number" class="inline-edit" data-field="depth" data-uid="${entry.uid}" value="${entry.depth != null ? entry.depth : ''}" ${!entry.position?.startsWith('at_depth') ? 'disabled' : ''}></div>
                <div data-label="顺序"><input type="number" class="inline-edit" data-field="order" data-uid="${entry.uid}" value="${entry.order}"></div>
            </div>`;
    }

    bindEntryEvents() {
        this.elements.worldEditorEntriesContainer.querySelectorAll('.world-editor-entry-row').forEach(row => {
            const uid = parseInt(row.dataset.uid);

            // Checkbox
            const checkbox = row.querySelector('.world-editor-entry-checkbox');
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) this.selectedEntries.add(uid); else this.selectedEntries.delete(uid);
                row.classList.toggle('selected', e.target.checked);
                this.updateSelectionUI();
            });

            // Content click to open modal (for longer edits)
            row.querySelector('[data-action="open-editor"]').addEventListener('click', () => this.openEditModal(uid));

            // Inline toggles (enabled, type)
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

            // Inline edits (inputs, selects)
            row.querySelectorAll('.inline-edit').forEach(input => {
                input.addEventListener('change', (e) => {
                    e.stopPropagation();
                    const field = input.dataset.field;
                    let value = input.value;
                    if (input.type === 'number') value = parseInt(value, 10);
                    // The 'keys' field is no longer inline editable, so that specific logic can be removed.
                    
                    const updates = { [field]: value };
                    // If position changes, re-evaluate depth disable state
                    if (field === 'position') {
                        const depthInput = row.querySelector('[data-field="depth"]');
                        if (depthInput) depthInput.disabled = !value.startsWith('at_depth');
                    }

                    this.updateSingleEntry(uid, updates);
                });
                input.addEventListener('click', e => e.stopPropagation()); // Prevent row selection when clicking input
            });
        });
    }

    async updateSingleEntry(uid, updates) {
        const entry = this.entries.find(e => e.uid === uid);
        if (!entry) return;

        // Optimistic UI update
        Object.assign(entry, updates);
        this.renderEntries(); // Re-render to reflect changes immediately

        try {
            await TavernHelper.setLorebookEntries(this.currentWorldBook, [{ ...entry, ...updates }]);
        } catch (error) {
            this.showError(`更新失败: ${error.message}`);
            // Revert on failure
            this.loadWorldBookEntries(this.currentWorldBook);
        }
    }

    async batchUpdateEntries(updates, confirmation = null) {
        if (this.selectedEntries.size === 0) return;
        if (confirmation && !confirm(confirmation)) return;

        const entries = this.entries.filter(e => this.selectedEntries.has(e.uid)).map(e => ({ ...e, ...updates }));
        await TavernHelper.setLorebookEntries(this.currentWorldBook, entries);
        this.loadWorldBookEntries(this.currentWorldBook); // Refresh
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

    async batchDeleteEntries() {
        if (this.selectedEntries.size === 0 || !confirm(`删除 ${this.selectedEntries.size} 个条目?`)) return;
        await TavernHelper.deleteLorebookEntries(this.currentWorldBook, Array.from(this.selectedEntries));
        this.selectedEntries.clear();
        this.loadWorldBookEntries(this.currentWorldBook); // Refresh
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
        const searchType = document.getElementById('world-editor-search-type').value;
        
        if (!term) {
            this.filteredEntries = [...this.entries];
        } else {
            this.filteredEntries = this.entries.filter(e => {
                const targetField = e[searchType] || '';
                return targetField.toLowerCase().includes(term);
            });
        }
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
        showHtmlModal(title, formHtml, {
            onOk: (dialog) => {
                this.saveEntry(dialog);
                return true; // Close the modal
            }
        });
    }

    getEditFormHtml(entry) {
        return `
            <style>
                .world-editor-form-grid {
                    display: grid;
                    grid-template-columns: 120px 1fr;
                    gap: 15px;
                    align-items: center;
                }
                .world-editor-form-grid label {
                    text-align: right;
                    color: #ccc;
                }
                .world-editor-form-grid .form-control {
                    width: 100%;
                    padding: 8px;
                    background-color: #404040;
                    color: white;
                    border: 1px solid #555;
                    border-radius: 4px;
                    box-sizing: border-box;
                }
                .world-editor-form-grid textarea.form-control {
                    min-height: 100px;
                    resize: vertical;
                }
                .world-editor-form-grid .full-width {
                    grid-column: 1 / -1;
                }
                .world-editor-form-grid .checkbox-group {
                    grid-column: 2 / -1;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
            </style>
            <form id="world-editor-edit-form" class="world-editor-form-grid">
                <div class="checkbox-group">
                    <input type="checkbox" id="world-editor-entry-enabled" ${entry.enabled ? 'checked' : ''}>
                    <label for="world-editor-entry-enabled">启用条目</label>
                </div>

                <label for="world-editor-entry-type">激活模式：</label>
                <select id="world-editor-entry-type" class="form-control">
                    <option value="selective" ${entry.type === 'selective' ? 'selected' : ''}>🟢 绿灯 (关键词触发)</option>
                    <option value="constant" ${entry.type === 'constant' ? 'selected' : ''}>🔵 蓝灯 (始终激活)</option>
                </select>

                <label for="world-editor-entry-keys" class="full-width" style="text-align: left; grid-column: 1 / -1;">关键词 (每行一个)：</label>
                <textarea id="world-editor-entry-keys" class="form-control full-width" placeholder="输入关键词，每行一个">${(entry.keys || []).join('\n')}</textarea>

                <label for="world-editor-entry-content" class="full-width" style="text-align: left; grid-column: 1 / -1;">内容：</label>
                <textarea id="world-editor-entry-content" class="form-control full-width" placeholder="输入条目内容">${entry.content || ''}</textarea>

                <label for="world-editor-entry-position">插入位置：</label>
                <select id="world-editor-entry-position" class="form-control">
                    <option value="before_character_definition" ${entry.position === 'before_character_definition' ? 'selected' : ''}>角色定义之前</option>
                    <option value="after_character_definition" ${entry.position === 'after_character_definition' ? 'selected' : ''}>角色定义之后</option>
                    <option value="before_author_note" ${entry.position === 'before_author_note' ? 'selected' : ''}>作者注释之前</option>
                    <option value="after_author_note" ${entry.position === 'after_author_note' ? 'selected' : ''}>作者注释之后</option>
                    <option value="at_depth" ${entry.position === 'at_depth' ? 'selected' : ''}>@D 注入指定深度</option>
                </select>

                <label for="world-editor-entry-depth">深度：</label>
                <input type="number" id="world-editor-entry-depth" class="form-control" min="0" max="9999" value="${entry.depth || 4}">

                <label for="world-editor-entry-order">顺序：</label>
                <input type="number" id="world-editor-entry-order" class="form-control" min="0" max="9999" value="${entry.order || 100}">

                <label for="world-editor-entry-comment">备注：</label>
                <input type="text" id="world-editor-entry-comment" class="form-control" placeholder="可选的备注信息" value="${entry.comment || ''}">

                <div class="checkbox-group">
                    <input type="checkbox" id="world-editor-entry-disable-recursion" ${entry.exclude_recursion ? 'checked' : ''}>
                    <label for="world-editor-entry-disable-recursion">不可递归 (不会被其他条目激活)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="world-editor-entry-prevent-recursion" ${entry.prevent_recursion ? 'checked' : ''}>
                    <label for="world-editor-entry-prevent-recursion">防止进一步递归 (本条目将不会激活其他条目)</label>
                </div>

            </form>
        `;
    }

    async saveEntry(dialog) {
        const formData = this.getFormDataFromModal(dialog);
        if (this.currentEditingEntry) {
            await TavernHelper.setLorebookEntries(this.currentWorldBook, [{ ...this.currentEditingEntry, ...formData }]);
        } else {
            await TavernHelper.createLorebookEntries(this.currentWorldBook, [formData]);
        }
        this.loadWorldBookEntries(this.currentWorldBook);
    }

    getFormDataFromModal(dialog) {
        const data = {};
        data.enabled = dialog.find('#world-editor-entry-enabled').is(':checked');
        data.type = dialog.find('#world-editor-entry-type').val();
        data.keys = dialog.find('#world-editor-entry-keys').val().split('\n').map(k => k.trim()).filter(Boolean);
        data.content = dialog.find('#world-editor-entry-content').val();
        data.position = dialog.find('#world-editor-entry-position').val();
        data.depth = parseInt(dialog.find('#world-editor-entry-depth').val());
        data.order = parseInt(dialog.find('#world-editor-entry-order').val());
        data.comment = dialog.find('#world-editor-entry-comment').val();
        data.exclude_recursion = dialog.find('#world-editor-entry-disable-recursion').is(':checked');
        data.prevent_recursion = dialog.find('#world-editor-entry-prevent-recursion').is(':checked');
        return data;
    }

    setLoading(loading) { this.elements.worldEditorEntriesContainer.classList.toggle('loading', loading); }
    showError(msg) { if (window.toastr) window.toastr.error(msg); console.error(msg); }

    sortEntries(key) {
        if (this.sortState.key === key) {
            this.sortState.asc = !this.sortState.asc;
        } else {
            this.sortState.key = key;
            this.sortState.asc = true;
        }
        this.renderEntries();
    }

    sortFilteredEntries() {
        const { key, asc } = this.sortState;
        this.filteredEntries.sort((a, b) => {
            let valA = a[key];
            let valB = b[key];

            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();

            if (valA < valB) return asc ? -1 : 1;
            if (valA > valB) return asc ? 1 : -1;
            return 0;
        });
    }

    bindExternalEvents() {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            console.log('[世界书编辑器] 检测到聊天变更 (CHAT_CHANGED)，将自动刷新。');
            this.loadAvailableWorldBooks();
        });

        console.log('[世界书编辑器] 已成功绑定外部事件监听器。');
    }
}

function initializeWorldEditorWhenVisible() {
    const panel = document.getElementById('amily2_world_editor_panel');
    if (!panel) { console.error('[WorldEditor] Panel not found!'); return; }
    const observer = new MutationObserver(() => {
        if (panel.style.display !== 'none' && !window.worldEditorInstance) {
            window.worldEditorInstance = new WorldEditor();
            observer.disconnect();
        }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['style'] });
    if (panel.style.display !== 'none') { // Check initial state
        if (!window.worldEditorInstance) window.worldEditorInstance = new WorldEditor();
        observer.disconnect();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWorldEditorWhenVisible);
} else {
    initializeWorldEditorWhenVisible();
}
