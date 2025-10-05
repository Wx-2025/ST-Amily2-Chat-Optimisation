import * as TableManager from '../core/table-system/manager.js';
import { log } from '../core/table-system/logger.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { extensionName } from '../utils/settings.js';
import { updateOrInsertTableInChat } from './message-table-renderer.js';
import { saveSettingsDebounced } from '/script.js';
import { startBatchFilling } from '../core/table-system/batch-filler.js';
import { showHtmlModal } from './page-window.js';
import { DEFAULT_AI_RULE_TEMPLATE, DEFAULT_AI_FLOW_TEMPLATE } from '../core/table-system/settings.js';
import { world_names, loadWorldInfo } from '/scripts/world-info.js';
import { safeCharLorebooks, safeLorebookEntries } from '../core/tavernhelper-compatibility.js';
import { characters, this_chid, eventSource, event_types } from "/script.js";
import { fetchNccsModels, testNccsApiConnection } from '../core/api/NccsApi.js';

const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;
const getAllTablesContainer = () => document.getElementById('all-tables-container');

let isResizing = false;


function toggleRowContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();

    const targetTd = event.target.closest('td.index-col');
    if (!targetTd) return;

    const tableWrapper = targetTd.closest('.amily2-table-wrapper');
    if (!tableWrapper) return;

    const isActive = targetTd.classList.contains('amily2-menu-open');

    // Close all other open menus (both row and column)
    document.querySelectorAll('.amily2-menu-open').forEach(openEl => {
        if (openEl !== targetTd) {
            openEl.classList.remove('amily2-menu-open');
            const otherWrapper = openEl.closest('.amily2-table-wrapper');
            if (otherWrapper) {
                otherWrapper.style.overflowX = 'auto';
                otherWrapper.style.zIndex = '';
                otherWrapper.style.position = '';
            }
        }
    });

    // Toggle the class on the current cell
    targetTd.classList.toggle('amily2-menu-open');

    // Adjust the overflow property
    if (targetTd.classList.contains('amily2-menu-open')) {
        tableWrapper.style.overflowX = 'visible';
        tableWrapper.style.position = 'relative';
        tableWrapper.style.zIndex = '10';
    } else {
        tableWrapper.style.overflowX = 'auto';
        tableWrapper.style.position = '';
        tableWrapper.style.zIndex = '';
    }

    const closeMenu = (e) => {
        if (!targetTd.contains(e.target)) {
            targetTd.classList.remove('amily2-menu-open');
            tableWrapper.style.overflowX = 'auto';
            tableWrapper.style.position = '';
            tableWrapper.style.zIndex = '';
            document.removeEventListener('click', closeMenu, true);
        }
    };

    if (targetTd.classList.contains('amily2-menu-open')) {
        setTimeout(() => {
            document.addEventListener('click', closeMenu, true);
        }, 0);
    }
}


function toggleColumnContextMenu(event) {
    if (isResizing || event.target.classList.contains('amily2-resizer')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();

    const targetTh = event.target.closest('th');
    if (!targetTh) return;

    const tableWrapper = targetTh.closest('.amily2-table-wrapper');
    if (!tableWrapper) return;

    const isActive = targetTh.classList.contains('amily2-menu-open');

    // Close all other open menus and reset their wrappers' overflow
    document.querySelectorAll('th.amily2-menu-open').forEach(openTh => {
        if (openTh !== targetTh) {
            openTh.classList.remove('amily2-menu-open');
            const otherWrapper = openTh.closest('.amily2-table-wrapper');
            if (otherWrapper) {
                otherWrapper.style.overflowX = 'auto';
                otherWrapper.style.zIndex = '';
                otherWrapper.style.position = '';
            }
        }
    });

    // Toggle the class on the current header
    targetTh.classList.toggle('amily2-menu-open');

    // Adjust the overflow property based on whether the menu is now open or closed
    if (targetTh.classList.contains('amily2-menu-open')) {
        tableWrapper.style.overflowX = 'visible';
        tableWrapper.style.position = 'relative'; // z-index only works on positioned elements
        tableWrapper.style.zIndex = '10';
    } else {
        tableWrapper.style.overflowX = 'auto';
        tableWrapper.style.position = '';
        tableWrapper.style.zIndex = '';
    }

    const closeMenu = (e) => {
        // Check if the click is outside the th containing the menu
        if (!targetTh.contains(e.target)) {
            targetTh.classList.remove('amily2-menu-open');
            tableWrapper.style.overflowX = 'auto';
            tableWrapper.style.position = '';
            tableWrapper.style.zIndex = '';
            document.removeEventListener('click', closeMenu, true);
        }
    };

    // If the menu was opened, set up the listener to close it
    if (targetTh.classList.contains('amily2-menu-open')) {
        setTimeout(() => {
            document.addEventListener('click', closeMenu, true);
        }, 0);
    }
}


function toggleHeaderIndexContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();

    const targetTh = event.target.closest('th.index-col');
    if (!targetTh) return;

    const menu = targetTh.querySelector('.amily2-context-menu');
    if (!menu) return;

    const isActive = menu.classList.contains('amily2-menu-active');

    document.querySelectorAll('.amily2-context-menu.amily2-menu-active').forEach(activeMenu => {
        activeMenu.classList.remove('amily2-menu-active');
    });

    if (!isActive) {
        menu.classList.add('amily2-menu-active');
    }

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.classList.remove('amily2-menu-active');
            document.removeEventListener('click', closeMenu, true);
        }
    };

    setTimeout(() => {
        if (menu.classList.contains('amily2-menu-active')) {
            document.addEventListener('click', closeMenu, true);
        }
    }, 0);
}


function showInputDialog({ title, label, currentValue, placeholder, onSave }) {
    const dialogHtml = `
        <dialog class="popup custom-input-dialog">
            <div class="popup-body">
                <h4 style="margin-top:0; color: #e0e0e0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px; display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-edit" style="color: #9e8aff;"></i> ${title}
                </h4>
                <div class="popup-content" style="padding: 20px 10px;">
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        <label style="color: #ccc; font-weight: bold;">${label}</label>
                        <input type="text" id="generic-input" class="text_pole" 
                               value="${currentValue}" 
                               style="padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.2); color: #fff; font-size: 1em;"
                               placeholder="${placeholder}">
                        <small style="color: #aaa; font-style: italic;">提示：输入内容将用于更新项目。</small>
                    </div>
                </div>
                <div class="popup-controls" style="display: flex; gap: 10px; justify-content: flex-end; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1);">
                    <div class="popup-button-cancel menu_button interactable" style="background: rgba(120,120,120,0.2); border-color: rgba(120,120,120,0.4);">
                        <i class="fas fa-times"></i> 取消
                    </div>
                    <div class="popup-button-ok menu_button menu_button_primary interactable" style="background: rgba(158,138,255,0.3); border-color: rgba(158,138,255,0.6);">
                        <i class="fas fa-check"></i> 确认
                    </div>
                </div>
            </div>
        </dialog>`;

    const dialogElement = $(dialogHtml).appendTo('body');
    const input = dialogElement.find('#generic-input');

    const closeDialog = () => {
        dialogElement[0].close();
        dialogElement.remove();
    };

    const save = () => {
        const newValue = input.val().trim();
        if (newValue && newValue !== currentValue) {
            onSave(newValue);
        } else if (!newValue) {
            toastr.warning('名称不能为空！');
            input.focus();
            return;
        }
        closeDialog();
    };

    dialogElement.find('.popup-button-ok').on('click', save);
    dialogElement.find('.popup-button-cancel').on('click', closeDialog);
    input.on('keypress', (e) => { if (e.which === 13) save(); });
    input.on('keydown', (e) => { if (e.which === 27) closeDialog(); });

    dialogElement[0].showModal();
    input.focus().select();
}


function showColumnNameEditor(tableIndex, colIndex, currentName) {
    showInputDialog({
        title: '编辑列名',
        label: '列名：',
        currentValue: currentName,
        placeholder: '请输入列名...',
        onSave: (newName) => {
            TableManager.updateHeader(tableIndex, colIndex, newName);
            renderTables();
            toastr.success(`列名已更新为 "${newName}"`);
        }
    });
}


function showTableNameEditor(tableIndex, currentName) {
    showInputDialog({
        title: '编辑表名',
        label: '表名：',
        currentValue: currentName,
        placeholder: '请输入表名...',
        onSave: (newName) => {
            TableManager.renameTable(tableIndex, newName);
            renderTables();
            toastr.success(`表名已更新为 "${newName}"`);
        }
    });
}


function positionContextMenu(menu, trigger) {
    menu.style.position = 'absolute';
    menu.style.zIndex = '10000';
    menu.style.left = '0';
    menu.style.right = 'auto';
    menu.style.marginTop = '';
    menu.style.marginBottom = '';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';

    const viewportHeight = window.innerHeight;
    const triggerRect = trigger.getBoundingClientRect();
    const menuHeight = 200; 
    const scrollContainer = trigger.closest('.hly-scroll');
    const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : { top: 0, bottom: viewportHeight };

    const spaceBelow = Math.min(viewportHeight, containerRect.bottom) - triggerRect.bottom;
    const spaceAbove = triggerRect.top - Math.max(0, containerRect.top);

    if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
        menu.style.top = 'auto';
        menu.style.bottom = '100%';
        menu.style.marginBottom = '2px';
    } else {
        menu.style.top = '100%';
        menu.style.bottom = 'auto';
        menu.style.marginTop = '2px';
    }

    const menuWidth = 160;
    const table = trigger.closest('table');
    const tableWrapper = table ? table.closest('div[style*="overflowX"]') : null;
    
    if (tableWrapper) {
        const wrapperRect = tableWrapper.getBoundingClientRect();
        const triggerLeftInWrapper = triggerRect.left - wrapperRect.left;

        if (triggerLeftInWrapper + menuWidth > wrapperRect.width - 20) {
            menu.style.left = 'auto';
            menu.style.right = '0';
        }
    }
}


export function renderTables() {
    let tables = TableManager.getMemoryState();
    if (!tables) {
        log('内存状态为空，从聊天记录加载作为后备。', 'warn');
        tables = TableManager.loadTables();
    }
    
    const container = getAllTablesContainer();

    if (!tables || !container) {
        console.error('[内存储司-工部] 缺少表格数据或容器，无法渲染。');
        return;
    }

    const highlights = TableManager.getHighlights();

    const placeholder = document.getElementById('add-table-placeholder');
    if (placeholder) {
        placeholder.remove();
    }

    container.innerHTML = '';

    tables.forEach((tableData, tableIndex) => {
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        const title = document.createElement('h3');
        title.innerHTML = `<i class="fas fa-table table-rename-icon" data-table-index="${tableIndex}" title="重命名"></i> ${tableData.name}`;
        const controls = document.createElement('div');
        controls.className = 'table-controls';

        const moveUpBtn = tableIndex > 0 ? `<button class="menu_button small_button move-table-up-btn" data-table-index="${tableIndex}" title="上移"><i class="fas fa-arrow-up"></i></button>` : '';
        const moveDownBtn = tableIndex < tables.length - 1 ? `<button class="menu_button small_button move-table-down-btn" data-table-index="${tableIndex}" title="下移"><i class="fas fa-arrow-down"></i></button>` : '';

        controls.innerHTML = `
            ${moveUpBtn}
            ${moveDownBtn}
            <button class="menu_button small_button edit-rules-btn" data-table-index="${tableIndex}" title="编辑规则"><i class="fa-solid fa-scroll"></i></button>
            <button class="menu_button small_button danger delete-table-btn" data-table-index="${tableIndex}" title="废黜此表"><i class="fas fa-trash-alt"></i></button>
        `;
        header.appendChild(title);
        header.appendChild(controls);
        container.appendChild(header);

        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'amily2-table-wrapper';

        const tableElement = document.createElement('table');
        tableElement.id = `amily2-table-${tableIndex}`;
        tableElement.dataset.tableIndex = tableIndex;

        const colgroup = document.createElement('colgroup');
        const indexCol = document.createElement('col');
        indexCol.style.width = '40px';
        colgroup.appendChild(indexCol);

        if (tableData.headers) {
            tableData.headers.forEach((_, colIndex) => {
                const col = document.createElement('col');
                // Assign a default width of 120px if none is specified
                const colWidth = (tableData.columnWidths && tableData.columnWidths[colIndex]) ? tableData.columnWidths[colIndex] : 90;
                col.style.width = `${colWidth}px`;
                colgroup.appendChild(col);
            });
        }
        tableElement.appendChild(colgroup);

        // Explicitly calculate and set the total table width to override CSS conflicts
        let totalWidth = 0;
        const cols = colgroup.querySelectorAll('col');
        cols.forEach(col => {
            totalWidth += parseInt(col.style.width, 10);
        });
        tableElement.style.width = `${totalWidth}px`;

        const thead = tableElement.createTHead();
        const headerRow = thead.insertRow();
        
        const indexTh = document.createElement('th');
        indexTh.className = 'index-col';
        indexTh.textContent = '#';
        indexTh.style.cursor = 'pointer';
        indexTh.title = '点击添加第一行';
        
        // 为表头的 # 号添加特殊的上下文菜单（仅在表格为空时显示）
        if (!tableData.rows || tableData.rows.length === 0) {
            const headerMenu = document.createElement('div');
            headerMenu.className = 'amily2-context-menu amily2-header-menu';
            headerMenu.style.display = 'none';  // 默认隐藏
            
            const addRowButton = document.createElement('button');
            addRowButton.innerHTML = '<i class="fas fa-plus-circle"></i> 创建第一行';
            addRowButton.className = 'menu_button small_button';
            addRowButton.addEventListener('click', (e) => {
                e.stopPropagation();
                TableManager.addRow(tableIndex);
                renderTables();
            });
            
            headerMenu.appendChild(addRowButton);
            indexTh.appendChild(headerMenu);
            
            // 为表头添加直接的点击事件监听器
            indexTh.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Header # clicked for table', tableIndex);
                
                // 直接执行添加行操作
                TableManager.addRow(tableIndex);
                renderTables();
                toastr.success('已添加第一行');
            });
        }
        
        headerRow.appendChild(indexTh);

        tableData.headers.forEach((headerText, colIndex) => {
            const th = document.createElement('th');
            th.dataset.colIndex = colIndex;
            th.style.cursor = 'pointer';

            const headerContent = document.createElement('span');
            headerContent.className = 'amily2-header-text';
            headerContent.textContent = headerText;
            th.appendChild(headerContent);

            const menu = document.createElement('div');
            menu.className = 'amily2-context-menu';

            const actions = [
                { label: '向左移动', action: 'move-left', icon: 'fa-arrow-left' },
                { label: '向右移动', action: 'move-right', icon: 'fa-arrow-right' },
                { label: '在左加列', action: 'add-left', icon: 'fa-plus-circle' },
                { label: '在右加列', action: 'add-right', icon: 'fa-plus-circle' },
                { label: '编辑列名', action: 'rename', icon: 'fa-pen' },
                { label: '删除该列', action: 'delete', icon: 'fa-trash-alt', isDanger: true }
            ];

            actions.forEach(({ label, action, icon, isDanger }) => {
                const button = document.createElement('button');
                button.textContent = label;
                button.className = 'menu_button small_button';
                if (isDanger) button.classList.add('danger');
                
                button.addEventListener('click', (e) => {
                    e.stopPropagation();
                    switch (action) {
                        case 'move-left':
                            TableManager.moveColumn(tableIndex, colIndex, 'left');
                            break;
                        case 'move-right':
                            TableManager.moveColumn(tableIndex, colIndex, 'right');
                            break;
                        case 'add-left':
                            TableManager.insertColumn(tableIndex, colIndex, 'left');
                            break;
                        case 'add-right':
                            TableManager.insertColumn(tableIndex, colIndex, 'right');
                            break;
                        case 'rename':
                            showColumnNameEditor(tableIndex, colIndex, headerText);
                            break;
                        case 'delete':
                            if (confirm(`您确定要删除 “${headerText}” 列吗？`)) {
                                TableManager.deleteColumn(tableIndex, colIndex);
                            }
                            break;
                    }
                    renderTables(); 
                });
                menu.appendChild(button);
            });

            th.appendChild(menu);

            const resizer = document.createElement('div');
            resizer.className = 'amily2-resizer';
            th.appendChild(resizer);

            const startResize = (startEvent) => {
                startEvent.preventDefault();
                startEvent.stopPropagation();

                isResizing = true;

                const table = startEvent.target.closest('table');
                const th = startEvent.target.parentElement;
                const col = table.querySelector(`colgroup > col:nth-child(${th.cellIndex + 1})`);

                const isTouchEvent = startEvent.type.startsWith('touch');
                const startX = isTouchEvent ? startEvent.touches[0].clientX : startEvent.clientX;
                const startWidth = th.offsetWidth;

                const onMove = (moveEvent) => {
                    const currentX = isTouchEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
                    const newWidth = startWidth + (currentX - startX);
                    if (newWidth > 50) {
                        col.style.width = `${newWidth}px`;
                    }
                };

                const onEnd = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onEnd);
                    document.removeEventListener('touchmove', onMove);
                    document.removeEventListener('touchend', onEnd);

                    const finalWidth = parseInt(col.style.width, 10);
                    TableManager.updateColumnWidth(tableIndex, colIndex, finalWidth);

                    setTimeout(() => { isResizing = false; }, 0);
                };

                if (isTouchEvent) {
                    document.addEventListener('touchmove', onMove, { passive: false });
                    document.addEventListener('touchend', onEnd);
                } else {
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onEnd);
                }
            };

            resizer.addEventListener('mousedown', startResize);
            resizer.addEventListener('touchstart', startResize, { passive: false });

            headerRow.appendChild(th);
        });

        const tbody = tableElement.createTBody();
        if (tableData.rows && tableData.rows.length > 0) {
            tableData.rows.forEach((rowData, rowIndex) => {
                const row = tbody.insertRow();
                row.dataset.rowIndex = rowIndex;

                const indexCell = row.insertCell();
                indexCell.className = 'index-col';

                const rowIndexSpan = document.createElement('span');
                rowIndexSpan.textContent = rowIndex + 1;
                indexCell.appendChild(rowIndexSpan);

                const menu = document.createElement('div');
                menu.className = 'amily2-context-menu amily2-row-context-menu';

                const actions = [
                    { label: '向上移动', action: 'move-up', icon: 'fa-arrow-up' },
                    { label: '向下移动', action: 'move-down', icon: 'fa-arrow-down' },
                    { label: '在上加行', action: 'add-above', icon: 'fa-plus-circle' },
                    { label: '在下加行', action: 'add-below', icon: 'fa-plus-circle' },
                    { label: '删除该行', action: 'delete-row', icon: 'fa-trash-alt', isDanger: true }
                ];

                actions.forEach(({ label, action, icon, isDanger }) => {
                    const button = document.createElement('button');
                    button.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
                    button.className = 'menu_button small_button';
                    if (isDanger) button.classList.add('danger');

                    button.addEventListener('click', (e) => {
                        e.stopPropagation();
                        
                        switch (action) {
                            case 'move-up':
                                TableManager.moveRow(tableIndex, rowIndex, 'up');
                                break;
                            case 'move-down':
                                TableManager.moveRow(tableIndex, rowIndex, 'down');
                                break;
                            case 'add-above':
                                TableManager.insertRow(tableIndex, rowIndex, 'above');
                                break;
                            case 'add-below':
                                TableManager.insertRow(tableIndex, rowIndex, 'below');
                                break;
                            case 'delete-row':
                                if (confirm(`您确定要删除第 ${rowIndex + 1} 行吗？`)) {
                                    TableManager.deleteRow(tableIndex, rowIndex);
                                }
                                break;
                        }
                        renderTables();
                    });
                    menu.appendChild(button);
                });
                indexCell.appendChild(menu);

                rowData.forEach((cellData, colIndex) => {
                    const cell = row.insertCell();
                    
                    const cellContent = document.createElement('div');
                    cellContent.className = 'amily2-cell-content';
                    cellContent.textContent = cellData;
                    cell.appendChild(cellContent);

                    if (!isTouchDevice()) {
                        cell.setAttribute('contenteditable', 'true');
                    }
                    cell.dataset.colIndex = colIndex;
                    cell.dataset.label = tableData.headers[colIndex] || '';

                    const highlightKey = `${tableIndex}-${rowIndex}-${colIndex}`;
                    if (highlights.has(highlightKey)) {
                        cell.classList.add('cell-highlight');
                    }
                });
            });
        }
        tableWrapper.appendChild(tableElement);
        container.appendChild(tableWrapper);
    });

    if (placeholder) {
        container.appendChild(placeholder);
    }

    // Also update the in-chat table whenever the main tables are re-rendered
    updateOrInsertTableInChat();
}


function openTableRuleEditor() {
    const settings = extension_settings[extensionName];
    const tags = settings.table_tags_to_extract || '';
    const exclusionRules = settings.table_exclusion_rules || [];

    const rulesHtml = exclusionRules.map((rule, index) => `
        <div class="exclusion-rule-item" data-index="${index}">
            <input type="text" class="text_pole rule-start" value="${rule.start}" placeholder="起始标记">
            <span>-</span>
            <input type="text" class="text_pole rule-end" value="${rule.end}" placeholder="结束标记">
            <button class="menu_button danger small_button remove-rule-btn"><i class="fas fa-trash-alt"></i></button>
        </div>
    `).join('');

    const modalHtml = `
        <div id="table-rules-editor" style="display: flex; flex-direction: column; gap: 20px;">
            <div>
                <label for="table-tags-input"><b>标签提取 (半角逗号分隔)</b></label>
                <input type="text" id="table-tags-input" class="text_pole" value="${tags}" placeholder="例如: content,game,time">
                <small class="notes">仅提取指定XML标签的内容，例如填“content”，即提取<content>...</content>中的内容。</small>
            </div>
            <div>
                <label><b>内容排除规则</b></label>
                <div id="exclusion-rules-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">${rulesHtml}</div>
                <button id="add-exclusion-rule-btn" class="menu_button small_button" style="margin-top: 10px;"><i class="fas fa-plus"></i> 添加规则</button>
                <small class="notes">移除所有被起始和结束标记包裹的内容（例如 OOC 部分）。</small>
            </div>
        </div>
    `;

    const dialog = showHtmlModal('配置独立提取规则', modalHtml, {
        onOk: () => {
            const newTags = document.getElementById('table-tags-input').value;
            updateAndSaveTableSetting('table_tags_to_extract', newTags);

            const newExclusionRules = [];
            document.querySelectorAll('#exclusion-rules-list .exclusion-rule-item').forEach(item => {
                const start = item.querySelector('.rule-start').value.trim();
                const end = item.querySelector('.rule-end').value.trim();
                if (start && end) {
                    newExclusionRules.push({ start, end });
                }
            });
            updateAndSaveTableSetting('table_exclusion_rules', newExclusionRules);
            toastr.success('独立提取规则已保存。');
        },
        onShow: (dialogElement) => {
            const rulesList = dialogElement.find('#exclusion-rules-list');

            dialogElement.find('#add-exclusion-rule-btn').on('click', () => {
                const newIndex = rulesList.children().length;
                const newItemHtml = `
                    <div class="exclusion-rule-item" data-index="${newIndex}">
                        <input type="text" class="text_pole rule-start" value="" placeholder="起始标记">
                        <span>-</span>
                        <input type="text" class="text_pole rule-end" value="" placeholder="结束标记">
                        <button class="menu_button danger small_button remove-rule-btn"><i class="fas fa-trash-alt"></i></button>
                    </div>`;
                rulesList.append(newItemHtml);
            });

            rulesList.on('click', '.remove-rule-btn', function() {
                $(this).closest('.exclusion-rule-item').remove();
            });
        }
    });
}

function openRuleEditor(tableIndex) {
    const tables = TableManager.getMemoryState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];

    // 兼容旧数据结构
    if (table.charLimitRule && !table.charLimitRules) {
        table.charLimitRules = {};
        if (table.charLimitRule.columnIndex !== -1) {
            table.charLimitRules[table.charLimitRule.columnIndex] = table.charLimitRule.limit;
        }
    }
    const charLimitRules = table.charLimitRules || {};

    const renderCharLimitRules = (rules) => {
        return Object.entries(rules).map(([colIndex, limit]) => {
            const header = table.headers[colIndex] || `未知列 (${colIndex})`;
            return `
                <div class="char-limit-rule-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
                    <span><i class="fas fa-file-alt" style="margin-right: 8px; color: #9e8aff;"></i><b>${header}</b>: 不超过 ${limit} 字</span>
                    <button class="menu_button danger small_button remove-char-limit-rule-btn" data-col-index="${colIndex}" title="删除此规则">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `;
        }).join('');
    };

    const getColumnOptions = (rules) => {
        return table.headers.map((header, index) => {
            // 如果该列已存在规则，则不应出现在下拉菜单中
            if (rules[index]) return '';
            return `<option value="${index}">${header}</option>`;
        }).join('');
    };

    const dialogHtml = `
        <dialog class="popup wide_dialogue_popup large_dialogue_popup">
          <div class="popup-body">
            <h4 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">
                <i class="fa-solid fa-scroll"></i> 编辑 “${table.name}” 的规则
            </h4>
            <div class="popup-content" style="height: 70vh; overflow-y: auto;">
                <div class="rule-editor-form" style="display: flex; flex-direction: column; gap: 15px; padding: 10px;">
                    
                    <div class="rule-editor-field" style="border: 1px solid #444; padding: 10px; border-radius: 5px;">
                        <label style="font-weight: bold; color: #9e8aff;">内容长度限制 (0为禁用)</label>
                        
                        <div id="current-char-limit-rules" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                            ${renderCharLimitRules(charLimitRules)}
                        </div>
                        
                        <div id="add-char-limit-rule-area" style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;">
                            <div style="display: flex; gap: 10px; align-items: center;">
                                <select id="new-rule-column-select" class="text_pole" style="flex: 1;">
                                    <option value="-1">-- 选择要添加规则的列 --</option>
                                    ${getColumnOptions(charLimitRules)}
                                </select>
                                <input type="number" id="new-rule-limit-input" class="text_pole" min="0" value="0" style="width: 80px;">
                                <button id="add-char-limit-rule-btn" class="menu_button menu_button_primary small_button">
                                    <i class="fas fa-plus"></i> 添加
                                </button>
                            </div>
                        </div>
                        <small class="notes">您可以为多个不同的列添加字符数限制规则。</small>
                    </div>

                    <div class="rule-editor-field" style="border: 1px solid #444; padding: 10px; border-radius: 5px;">
                        <label for="rule-row-limit-value" style="font-weight: bold; color: #9e8aff;">表格行数限制 (0为禁用)</label>
                        <input type="number" id="rule-row-limit-value" class="text_pole" min="0" value="${table.rowLimitRule || 0}" style="width: 100px; margin-top: 10px;">
                        <small class="notes">当表格总行数超过设定值时，将在表格底部显示警告。</small>
                    </div>

                    <hr style="border-color: #444; margin: 10px 0;">

                    <div class="rule-editor-field">
                        <label for="rule-note">【说明】:</label>
                        <textarea id="rule-note" class="text_pole" rows="5" style="width: 100%;">${table.note || ''}</textarea>
                    </div>
                    <div class="rule-editor-field">
                        <label for="rule-add">【增加】:</label>
                        <textarea id="rule-add" class="text_pole" rows="3" style="width: 100%;">${table.rule_add || ''}</textarea>
                    </div>
                    <div class="rule-editor-field">
                        <label for="rule-delete">【删除】:</label>
                        <textarea id="rule-delete" class="text_pole" rows="3" style="width: 100%;">${table.rule_delete || ''}</textarea>
                    </div>
                    <div class="rule-editor-field">
                        <label for="rule-update">【修改】:</label>
                        <textarea id="rule-update" class="text_pole" rows="3" style="width: 100%;">${table.rule_update || ''}</textarea>
                    </div>
                </div>
            </div>
            <div class="popup-controls">
                <div class="popup-button-ok menu_button menu_button_primary interactable">保存</div>
                <div class="popup-button-cancel menu_button interactable" style="margin-left: 10px;">取消</div>
            </div>
          </div>
        </dialog>`;

    const dialogElement = $(dialogHtml).appendTo('body');

    const closeDialog = () => {
        dialogElement[0].close();
        dialogElement.remove();
    };

    const refreshRuleUI = () => {
        const currentRules = JSON.parse(dialogElement.find('#current-char-limit-rules').attr('data-rules') || '{}');
        dialogElement.find('#current-char-limit-rules').html(renderCharLimitRules(currentRules));
        dialogElement.find('#new-rule-column-select').html(`<option value="-1">-- 选择要添加规则的列 --</option>${getColumnOptions(currentRules)}`);
    };

    dialogElement.find('#current-char-limit-rules').attr('data-rules', JSON.stringify(charLimitRules));

    dialogElement.on('click', '#add-char-limit-rule-btn', () => {
        const selectedColumn = parseInt(dialogElement.find('#new-rule-column-select').val(), 10);
        const limitValue = parseInt(dialogElement.find('#new-rule-limit-input').val(), 10);

        if (selectedColumn === -1) {
            toastr.warning('请选择一个列。');
            return;
        }
        
        // 允许输入0，但0意味着“无限制”，所以我们不添加规则。
        if (isNaN(limitValue) || limitValue < 0) {
            toastr.warning('请输入一个有效的字数限制（大于等于0）。');
            return;
        }

        const currentRules = JSON.parse(dialogElement.find('#current-char-limit-rules').attr('data-rules') || '{}');

        if (limitValue > 0) {
            // 只有当限制大于0时，才添加或更新规则
            currentRules[selectedColumn] = limitValue;
            dialogElement.find('#current-char-limit-rules').attr('data-rules', JSON.stringify(currentRules));
            refreshRuleUI();
        } else {
            // 如果用户输入0，则视为不设置规则
            toastr.info('字数限制为0表示不设置规则。');
        }
    });

    dialogElement.on('click', '.remove-char-limit-rule-btn', function() {
        const colIndexToRemove = $(this).data('col-index');
        const currentRules = JSON.parse(dialogElement.find('#current-char-limit-rules').attr('data-rules') || '{}');
        delete currentRules[colIndexToRemove];
        dialogElement.find('#current-char-limit-rules').attr('data-rules', JSON.stringify(currentRules));
        refreshRuleUI();
    });

    dialogElement.find('.popup-button-ok').on('click', () => {
        const newCharLimitRules = JSON.parse(dialogElement.find('#current-char-limit-rules').attr('data-rules') || '{}');
        const rowLimitValue = parseInt(dialogElement.find('#rule-row-limit-value').val(), 10);

        const newRules = {
            note: dialogElement.find('#rule-note').val(),
            rule_add: dialogElement.find('#rule-add').val(),
            rule_delete: dialogElement.find('#rule-delete').val(),
            rule_update: dialogElement.find('#rule-update').val(),
            charLimitRules: newCharLimitRules,
            rowLimitRule: rowLimitValue,
        };
        TableManager.updateTableRules(tableIndex, newRules);
        closeDialog();
    });

    dialogElement.find('.popup-button-cancel').on('click', closeDialog);
    dialogElement[0].showModal();
}


function bindInjectionSettings() {
    const settings = extension_settings[extensionName];

    const masterSwitchCheckbox = document.getElementById('table-system-master-switch');
    const enabledCheckbox = document.getElementById('table-injection-enabled');
    const positionSelect = document.getElementById('table-injection-position');
    const depthInput = document.getElementById('table-injection-depth');
    const roleRadioGroup = document.querySelectorAll('input[name="table-injection-role"]');

    if (!masterSwitchCheckbox || !enabledCheckbox || !positionSelect || !depthInput || !roleRadioGroup.length) {
        return;
    }

    const updateInjectionUI = () => {
        const position = positionSelect.value;
        const masterEnabled = masterSwitchCheckbox.checked;
 
        const isChatInjection = position === '1';

        enabledCheckbox.disabled = !masterEnabled;
        positionSelect.disabled = !masterEnabled;
        depthInput.disabled = !masterEnabled || !isChatInjection;
        roleRadioGroup.forEach(radio => radio.disabled = !masterEnabled || !isChatInjection);

        const enabledOpacity = masterEnabled ? '1' : '0.5';
        enabledCheckbox.style.opacity = enabledOpacity;
        if (enabledCheckbox.closest('.control-block-with-switch')) {
            enabledCheckbox.closest('.control-block-with-switch').style.opacity = enabledOpacity;
        }
        
        positionSelect.style.opacity = enabledOpacity;
        if (positionSelect.previousElementSibling) {
            positionSelect.previousElementSibling.style.opacity = enabledOpacity;
        }

        const depthOpacity = masterEnabled && isChatInjection ? '1' : '0.5';
        depthInput.style.opacity = depthOpacity;
        if (depthInput.previousElementSibling) {
            depthInput.previousElementSibling.style.opacity = depthOpacity;
        }

        const roleOpacity = masterEnabled && isChatInjection ? '1' : '0.5';
        const roleGroupContainer = document.getElementById('table-role-system')?.closest('.radio-group');
        if (roleGroupContainer) {
            roleGroupContainer.style.opacity = roleOpacity;
            if (roleGroupContainer.previousElementSibling) {
                roleGroupContainer.previousElementSibling.style.opacity = roleOpacity;
            }
        }

        const fillingModeRadios = document.querySelectorAll('input[name="filling-mode"]');
        fillingModeRadios.forEach(radio => {
            radio.disabled = !masterEnabled;
            const label = radio.closest('label');
            if (label) {
                label.style.opacity = masterEnabled ? '1' : '0.5';
            }
        });

        const fillButton = document.getElementById('fill-table-now-btn');
        if (fillButton) {
            fillButton.disabled = !masterEnabled;
            fillButton.style.opacity = masterEnabled ? '1' : '0.5';
        }
    };

    masterSwitchCheckbox.checked = settings.table_system_enabled !== false;
    enabledCheckbox.checked = settings.table_injection_enabled;
    positionSelect.value = settings.injection.position;
    depthInput.value = settings.injection.depth;
    roleRadioGroup.forEach(radio => {
        if (parseInt(radio.value, 10) === settings.injection.role) {
            radio.checked = true;
        }
    });

    updateInjectionUI();

    masterSwitchCheckbox.addEventListener('change', () => {
        settings.table_system_enabled = masterSwitchCheckbox.checked;
        saveSettingsDebounced();
        updateInjectionUI();
        
        const statusText = masterSwitchCheckbox.checked ? '已启用' : '已禁用';
        toastr.info(`表格系统总开关${statusText}。`);
        log(`表格系统总开关${statusText}。`, 'info');
    });

    enabledCheckbox.addEventListener('change', () => {
        settings.table_injection_enabled = enabledCheckbox.checked;
        saveSettingsDebounced();
    });

    positionSelect.addEventListener('change', () => {
        settings.injection.position = parseInt(positionSelect.value, 10);
        saveSettingsDebounced();

        updateInjectionUI();
    });

    depthInput.addEventListener('input', () => {
        settings.injection.depth = parseInt(depthInput.value, 10);
        saveSettingsDebounced();
    });

    roleRadioGroup.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                settings.injection.role = parseInt(radio.value, 10);
                saveSettingsDebounced();
            }
        });
    });

    log('表格注入设置已成功绑定。', 'success');
}


function updateAndSaveTableSetting(key, value) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
}

function bindWorldBookSettings() {
    const settings = extension_settings[extensionName];

    if (settings.table_worldbook_enabled === undefined) settings.table_worldbook_enabled = false;
    if (settings.table_worldbook_char_limit === undefined) settings.table_worldbook_char_limit = 30000;
    if (settings.table_worldbook_source === undefined) settings.table_worldbook_source = 'character';
    if (settings.table_selected_worldbooks === undefined) settings.table_selected_worldbooks = [];
    if (settings.table_selected_entries === undefined) settings.table_selected_entries = {};

    const enabledCheckbox = document.getElementById('table_worldbook_enabled');
    const limitSlider = document.getElementById('table_worldbook_char_limit');
    const limitValueSpan = document.getElementById('table_worldbook_char_limit_value');
    const sourceRadios = document.querySelectorAll('input[name="table_worldbook_source"]');
    const manualSelectWrapper = document.getElementById('table_worldbook_select_wrapper');
    const refreshButton = document.getElementById('table_refresh_worldbooks');
    const bookListContainer = document.getElementById('table_worldbook_checkbox_list');
    const entryListContainer = document.getElementById('table_worldbook_entry_list');

    if (!enabledCheckbox || !limitSlider || !limitValueSpan || !sourceRadios.length || !manualSelectWrapper || !refreshButton || !bookListContainer || !entryListContainer) {
        log('无法找到世界书设置的相关UI元素，绑定失败。', 'warn');
        return;
    }

    const saveSelectedEntries = () => {
        const selected = {};
        entryListContainer.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            const book = cb.dataset.book;
            const uid = cb.dataset.uid;
            if (!selected[book]) {
                selected[book] = [];
            }
            selected[book].push(uid);
        });
        settings.table_selected_entries = selected;
        saveSettingsDebounced();
    };

    const renderWorldBookEntries = async () => {
        entryListContainer.innerHTML = '<p>加载条目中...</p>';
        const source = settings.table_worldbook_source || 'character';
        let bookNames = [];

        if (source === 'manual') {
            bookNames = settings.table_selected_worldbooks || [];
        } else {
            if (this_chid !== undefined && this_chid >= 0 && characters[this_chid]) {
                try {
                    const charLorebooks = await safeCharLorebooks({ type: 'all' });
                    if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
                    if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
                } catch (error) {
                    console.error(`[内存储司] 获取角色世界书失败:`, error);
                    entryListContainer.innerHTML = '<p class="notes" style="color:red;">获取角色世界书失败。</p>';
                    return;
                }
            } else {
                entryListContainer.innerHTML = '<p class="notes">请先加载一个角色。</p>';
                return;
            }
        }

        if (bookNames.length === 0) {
            entryListContainer.innerHTML = '<p class="notes">未选择或绑定世界书。</p>';
            return;
        }

        try {
            const allEntries = [];
            for (const bookName of bookNames) {
                const entries = await safeLorebookEntries(bookName);
                entries.forEach(entry => allEntries.push({ ...entry, bookName }));
            }

            entryListContainer.innerHTML = '';
            if (allEntries.length === 0) {
                entryListContainer.innerHTML = '<p class="notes">所选世界书中没有条目。</p>';
                return;
            }

            allEntries.forEach(entry => {
                const div = document.createElement('div');
                div.className = 'checkbox-item';
                div.title = `世界书: ${entry.bookName}\nUID: ${entry.uid}`;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `wb-entry-check-${entry.bookName}-${entry.uid}`;
                checkbox.dataset.book = entry.bookName;
                checkbox.dataset.uid = entry.uid;
                
                const isChecked = settings.table_selected_entries[entry.bookName]?.includes(String(entry.uid));
                checkbox.checked = !!isChecked;

                const label = document.createElement('label');
                label.htmlFor = checkbox.id;
                label.textContent = entry.comment || '无标题条目';

                div.appendChild(checkbox);
                div.appendChild(label);
                entryListContainer.appendChild(div);
            });
        } catch (error) {
            console.error(`[内存储司] 加载世界书条目失败:`, error);
            entryListContainer.innerHTML = '<p class="notes" style="color:red;">加载条目失败。</p>';
        }
    };

    const renderWorldBookList = () => {
        const worldBooks = world_names.map(name => ({ name: name.replace('.json', ''), file_name: name }));
        bookListContainer.innerHTML = '';
        if (worldBooks && worldBooks.length > 0) {
            worldBooks.forEach(book => {
                const div = document.createElement('div');
                div.className = 'checkbox-item';
                div.title = book.name;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `wb-check-${book.file_name}`;
                checkbox.value = book.file_name;
                checkbox.checked = settings.table_selected_worldbooks.includes(book.file_name);

                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        if (!settings.table_selected_worldbooks.includes(book.file_name)) {
                            settings.table_selected_worldbooks.push(book.file_name);
                        }
                    } else {
                        settings.table_selected_worldbooks = settings.table_selected_worldbooks.filter(name => name !== book.file_name);
                    }
                    saveSettingsDebounced();
                    renderWorldBookEntries();
                });

                const label = document.createElement('label');
                label.htmlFor = `wb-check-${book.file_name}`;
                label.textContent = book.name;

                div.appendChild(checkbox);
                div.appendChild(label);
                bookListContainer.appendChild(div);
            });
        } else {
            bookListContainer.innerHTML = '<p class="notes">没有找到世界书。</p>';
        }
        renderWorldBookEntries();
    };
    
    const updateManualSelectVisibility = () => {
        const isManual = settings.table_worldbook_source === 'manual';
        manualSelectWrapper.style.display = isManual ? 'block' : 'none';
        renderWorldBookEntries();
        if (isManual) {
            renderWorldBookList();
        }
    };

    enabledCheckbox.checked = settings.table_worldbook_enabled;
    limitSlider.value = settings.table_worldbook_char_limit;
    limitValueSpan.textContent = settings.table_worldbook_char_limit;
    sourceRadios.forEach(radio => {
        radio.checked = radio.value === settings.table_worldbook_source;
    });

    updateManualSelectVisibility();

    enabledCheckbox.addEventListener('change', () => {
        settings.table_worldbook_enabled = enabledCheckbox.checked;
        saveSettingsDebounced();
    });

    limitSlider.addEventListener('input', () => { limitValueSpan.textContent = limitSlider.value; });
    limitSlider.addEventListener('change', () => {
        settings.table_worldbook_char_limit = parseInt(limitSlider.value, 10);
        saveSettingsDebounced();
    });

    sourceRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                settings.table_worldbook_source = radio.value;
                updateManualSelectVisibility();
                saveSettingsDebounced();
            }
        });
    });

    refreshButton.addEventListener('click', renderWorldBookList);
    entryListContainer.addEventListener('change', (event) => {
        if (event.target.type === 'checkbox') {
            saveSelectedEntries();
        }
    });

    log('世界书设置已成功绑定。', 'success');
}

export function bindTableEvents() {
    const panel = document.getElementById('amily2_memorisation_forms_panel');
    if (!panel || panel.dataset.eventsBound) {
        return;
    }
    log('开始为表格视图绑定交互事件...', 'info');
    const fillingModeRadios = panel.querySelectorAll('input[name="filling-mode"]');
    const contextSliderContainer = document.getElementById('context-reading-slider-container');
    const contextSlider = document.getElementById('context-reading-slider');
    const contextValueSpan = document.getElementById('context-reading-value');
    const independentRulesContainer = document.getElementById('table-independent-rules-container');
    const independentRulesToggle = document.getElementById('table-independent-rules-enabled');
    const configureRulesBtn = document.getElementById('table-configure-rules-btn');
    
    const updateFillingModeUI = () => {
        const currentMode = extension_settings[extensionName]?.filling_mode || 'main-api';
        fillingModeRadios.forEach(radio => {
            radio.checked = (radio.value === currentMode);
        });

        const isSecondaryMode = currentMode === 'secondary-api';

        if (contextSliderContainer) {
            contextSliderContainer.style.display = isSecondaryMode ? 'block' : 'none';
        }

        if (independentRulesContainer) {
            independentRulesContainer.style.display = 'flex';
        }

        if (independentRulesToggle && configureRulesBtn) {
            configureRulesBtn.style.display = independentRulesToggle.checked ? 'block' : 'none';
        }
    };

    fillingModeRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            const selectedMode = this.value;
            updateAndSaveTableSetting('filling_mode', selectedMode);
            
            let modeName = '原始填表';
            if (selectedMode === 'secondary-api') modeName = '分步填表';
            if (selectedMode === 'optimized') modeName = '优化中填表';
            
            toastr.info(`填表模式已切换为 ${modeName}。`);
            updateFillingModeUI(); // 更新UI以确保状态同步
        });
    });

    if (contextSlider && contextValueSpan) {
        const contextReadingValue = extension_settings[extensionName]?.context_reading_level || 4;
        contextSlider.value = contextReadingValue;
        contextValueSpan.textContent = contextReadingValue;

        contextSlider.addEventListener('input', function() {
            contextValueSpan.textContent = this.value;
        });
        
        contextSlider.addEventListener('change', function() {
            updateAndSaveTableSetting('context_reading_level', parseInt(this.value, 10));
            toastr.info(`上下文读取级别已设置为 ${this.value}。`);
        });
    }

    if (independentRulesToggle) {
        independentRulesToggle.checked = extension_settings[extensionName]?.table_independent_rules_enabled ?? false;
        independentRulesToggle.addEventListener('change', () => {
            updateAndSaveTableSetting('table_independent_rules_enabled', independentRulesToggle.checked);
            updateFillingModeUI();
        });
    }

    updateFillingModeUI();

    if (configureRulesBtn) {
        configureRulesBtn.addEventListener('click', openTableRuleEditor);
    }

    const renderAll = () => {
        renderTables();
        bindInjectionSettings();
        bindTemplateEditors(); 
    };

    renderAll();
    bindWorldBookSettings();
    bindBatchFillButton(); // 【新增】绑定批量填表按钮
    bindFloorFillButtons(); // 【新增】绑定楼层填表按钮
    bindReorganizeButton(); // 【新增】绑定重新整理按钮
    bindTemplateEditors(); // 【新增】为新的指令模板编辑器绑定事件
    bindNccsApiEvents(); // 【新增】绑定Nccs API系统事件
    bindChatTableDisplaySetting(); // 【新增】绑定聊天内表格显示开关

    const navDeck = document.querySelector('#amily2_memorisation_forms_panel .sinan-navigation-deck');
    if (navDeck) {
        navDeck.addEventListener('click', (event) => {
            const target = event.target.closest('.sinan-nav-item');
            if (!target) return;

            const tabName = target.dataset.tab;
            if (!tabName) return;

            const container = target.closest('.settings-group');
            if (!container) return;

            container.querySelectorAll('.sinan-nav-item').forEach(btn => btn.classList.remove('active'));
            target.classList.add('active');
            container.querySelectorAll('.sinan-tab-pane').forEach(pane => pane.classList.remove('active'));
            const activePane = container.querySelector(`#sinan-${tabName}-tab`);
            if (activePane) {
                activePane.classList.add('active');
            }
        });
    }

    const exportBtn = document.getElementById('amily2-export-preset-btn');
    const exportFullBtn = document.getElementById('amily2-export-preset-full-btn');
    const importBtn = document.getElementById('amily2-import-preset-btn');
    const importGlobalBtn = document.getElementById('amily2-import-global-preset-btn');
    const clearGlobalBtn = document.getElementById('amily2-clear-global-preset-btn');

    if (exportBtn) {
        exportBtn.addEventListener('click', () => TableManager.exportPreset());
    }
    if (exportFullBtn) {
        exportFullBtn.addEventListener('click', () => TableManager.exportPresetFull());
    }
    if (importBtn) {
        importBtn.addEventListener('click', () => TableManager.importPreset(renderAll));
    }
    if (importGlobalBtn) {
        importGlobalBtn.addEventListener('click', () => {

            const isEmpty = TableManager.isCurrentTablesEmpty();
            TableManager.importGlobalPreset(() => {
                if (isEmpty) {
                    TableManager.loadTables(); 
                    renderAll();
                }
            });
        });
    }
    if (clearGlobalBtn) {
        clearGlobalBtn.addEventListener('click', () => {
            const isEmpty = TableManager.isCurrentTablesEmpty();
            TableManager.clearGlobalPreset();
            if (isEmpty) {
                TableManager.loadTables();
                renderAll();
            }
        });
    }

    const clearAllBtn = document.getElementById('amily2-clear-all-tables-btn');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            if (confirm('【确认】您确定要清空所有表格的剧情内容吗？此操作将保留表格结构，但会删除所有已填写的行。')) {
                TableManager.clearAllTables();
                renderAll();
            }
        });
    }


    const addTablePlaceholder = document.getElementById('add-table-placeholder');
    if (addTablePlaceholder) {
        addTablePlaceholder.addEventListener('click', () => {
            const newName = prompt('请输入新表格的名称：', '新表格');
            if (newName && newName.trim()) {
                TableManager.addTable(newName.trim());
                renderAll();
            }
        });
    }


    const allTablesContainer = getAllTablesContainer();
    if (allTablesContainer) {
        allTablesContainer.addEventListener('click', (event) => {
            const th = event.target.closest('th');
            if (th && th.classList.contains('index-col')) {
                // 处理表头 # 号的点击（用于空表格添加首行）
                toggleHeaderIndexContextMenu(event);
                return;
            }
            if (th && !th.classList.contains('index-col')) {
                toggleColumnContextMenu(event);
                return;
            }

            const td = event.target.closest('td.index-col');
            if (td) {
                toggleRowContextMenu(event);
                return;
            }

            const renameIcon = event.target.closest('.table-rename-icon');
            if (renameIcon) {
                const tableIndex = parseInt(renameIcon.dataset.tableIndex, 10);
                const tables = TableManager.getMemoryState();
                const currentName = tables[tableIndex]?.name || '';
                showTableNameEditor(tableIndex, currentName);
                return;
            }

            const target = event.target.closest('button');
            if (!target) return;

            const tableIndex = parseInt(target.dataset.tableIndex, 10);

            if (target.matches('.add-row-btn')) {
                TableManager.addRow(tableIndex);
                renderAll();
            } else if (target.matches('.add-col-btn')) {
                TableManager.addColumn(tableIndex);
                renderAll();
            } else if (target.matches('.move-table-up-btn') || target.matches('.move-table-down-btn')) {
                const direction = target.classList.contains('move-table-up-btn') ? 'up' : 'down';
                TableManager.moveTable(tableIndex, direction);
                renderAll();
            } else if (target.matches('.edit-rules-btn')) {
                openRuleEditor(tableIndex);
            } else if (target.matches('.delete-table-btn')) {
                const tables = TableManager.getMemoryState();
                const tableName = tables[tableIndex]?.name || '未知表格';
                if (confirm(`【最终警告】您确定要永久废黜表格 “[${tableName}]” 吗？此操作不可逆！`)) {
                    TableManager.deleteTable(tableIndex);
                    renderAll();
                }
            }
        });

        if (isTouchDevice()) {
            let lastTap = 0;
            let lastTapTarget = null;
            allTablesContainer.addEventListener('touchstart', (event) => {
                const target = event.target.closest('td');
                if (!target || target.dataset.colIndex === undefined) return;

                const currentTime = new Date().getTime();
                const tapLength = currentTime - lastTap;
                if (tapLength < 300 && tapLength > 0 && lastTapTarget === target) {
                    event.preventDefault();
                    if (target.getAttribute('contenteditable') !== 'true') {
                        target.setAttribute('contenteditable', 'true');
                        setTimeout(() => target.focus(), 0);
                    }
                }
                lastTap = currentTime;
                lastTapTarget = target;
            });
        }

        allTablesContainer.addEventListener('blur', (event) => {
            const target = event.target;
            if (target.tagName !== 'TD' || target.getAttribute('contenteditable') !== 'true') return;

            if (isTouchDevice()) {
                target.setAttribute('contenteditable', 'false');
            }

            const tableElement = target.closest('table');
            if (!tableElement) return;
            
            const tableIndex = parseInt(tableElement.dataset.tableIndex, 10);
            const rowIndex = parseInt(target.closest('tr').dataset.rowIndex, 10);
            const colIndex = parseInt(target.dataset.colIndex, 10);
            const newValue = target.textContent;

            // Correctly save scroll positions before re-rendering
            const tableWrapper = tableElement.closest('.amily2-table-wrapper');
            const hScroll = tableWrapper ? tableWrapper.scrollLeft : 0;
            const vScroll = allTablesContainer.scrollTop;

            TableManager.addHighlight(tableIndex, rowIndex, colIndex);
            const dataToUpdate = { [colIndex]: newValue };
            TableManager.updateRow(tableIndex, rowIndex, dataToUpdate);

            renderAll();

            // Correctly restore scroll positions after re-rendering
            const newTableWrapper = document.getElementById(`amily2-table-${tableIndex}`)?.closest('.amily2-table-wrapper');
            if (newTableWrapper) {
                newTableWrapper.scrollLeft = hScroll;
            }
            allTablesContainer.scrollTop = vScroll;

        }, true);
    }
    
    panel.dataset.eventsBound = 'true';
    log('表格视图交互事件已成功绑定。', 'success');

    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log(`[${extensionName}] 检测到角色/聊天切换，正在刷新表格系统UI和世界书设置...`);
        renderAll();

        setTimeout(() => {
            const settings = extension_settings[extensionName];
            if (settings && settings.table_worldbook_enabled) {
                try {
                    bindWorldBookSettings();
                    console.log(`[${extensionName}] 世界书设置已刷新`);
                } catch (error) {
                    console.error(`[${extensionName}] 刷新世界书设置时出错:`, error);
                }
            }
        }, 100);
    });
}

function bindBatchFillButton() {
    const fillButton = document.getElementById('fill-table-now-btn');
    if (fillButton) {
        if (fillButton.dataset.batchEventBound) return;
        
        fillButton.addEventListener('click', (event) => {
            const settings = extension_settings[extensionName];
            const tableSystemEnabled = settings.table_system_enabled !== false;
            
            if (!tableSystemEnabled) {
                event.preventDefault();
                toastr.warning('表格系统总开关已关闭，请先启用总开关。');
                return;
            }
            
            startBatchFilling();
        });
        
        fillButton.dataset.batchEventBound = 'true';
        log('"立即填表"按钮已成功绑定。', 'success');
    }
}

function bindReorganizeButton() {
    const reorganizeBtn = document.getElementById('reorganize-table-btn');
    
    if (reorganizeBtn) {
        if (reorganizeBtn.dataset.reorganizeEventBound) return;
        
        reorganizeBtn.addEventListener('click', async (event) => {
            const settings = extension_settings[extensionName];
            const tableSystemEnabled = settings.table_system_enabled !== false;
            
            if (!tableSystemEnabled) {
                event.preventDefault();
                toastr.warning('表格系统总开关已关闭，请先启用总开关。');
                return;
            }

            try {
                const { reorganizeTableContent } = await import('../core/table-system/reorganizer.js');
                await reorganizeTableContent();
            } catch (error) {
                console.error('[内存储司] 重新整理功能导入失败:', error);
                toastr.error('重新整理功能启动失败，请检查系统状态。');
            }
        });
        
        reorganizeBtn.dataset.reorganizeEventBound = 'true';
        log('"重新整理"按钮已成功绑定。', 'success');
    }
}


function bindFloorFillButtons() {
    const selectedFloorsBtn = document.getElementById('fill-selected-floors-btn');
    const currentFloorBtn = document.getElementById('fill-current-floor-btn');
    const rollbackBtn = document.getElementById('rollback-and-refill-btn');
    
    if (selectedFloorsBtn) {

        if (selectedFloorsBtn.dataset.floorEventBound) return;
        
        selectedFloorsBtn.addEventListener('click', (event) => {
            const settings = extension_settings[extensionName];
            const tableSystemEnabled = settings.table_system_enabled !== false;
            
            if (!tableSystemEnabled) {
                event.preventDefault();
                toastr.warning('表格系统总开关已关闭，请先启用总开关。');
                return;
            }
            
            const startFloorInput = document.getElementById('floor-start-input');
            const endFloorInput = document.getElementById('floor-end-input');
            
            const startFloor = parseInt(startFloorInput.value, 10);
            const endFloor = parseInt(endFloorInput.value, 10);
            
            if (!startFloor || !endFloor) {
                toastr.warning('请输入有效的起始楼层和结束楼层。');
                return;
            }
            
            if (startFloor > endFloor) {
                toastr.warning('起始楼层不能大于结束楼层。');
                return;
            }
            
            if (startFloor < 1) {
                toastr.warning('楼层不能小于1。');
                return;
            }

            import('../core/table-system/batch-filler.js').then(module => {
                module.startFloorRangeFilling(startFloor, endFloor);
            });
        });
        
        selectedFloorsBtn.dataset.floorEventBound = 'true';
        log('"选定楼层填表"按钮已成功绑定。', 'success');
    }
    
    if (currentFloorBtn) {
        if (currentFloorBtn.dataset.currentEventBound) return;
        
        currentFloorBtn.addEventListener('click', (event) => {
            const settings = extension_settings[extensionName];
            const tableSystemEnabled = settings.table_system_enabled !== false;
            
            if (!tableSystemEnabled) {
                event.preventDefault();
                toastr.warning('表格系统总开关已关闭，请先启用总开关。');
                return;
            }

            import('../core/table-system/batch-filler.js').then(module => {
                module.startCurrentFloorFilling();
            });
        });
        
        currentFloorBtn.dataset.currentEventBound = 'true';
        log('"填当前楼层"按钮已成功绑定。', 'success');
    }

    if (rollbackBtn) {
        if (rollbackBtn.dataset.rollbackEventBound) return;

        rollbackBtn.addEventListener('click', async (event) => {
            const settings = extension_settings[extensionName];
            const tableSystemEnabled = settings.table_system_enabled !== false;
            
            if (!tableSystemEnabled) {
                event.preventDefault();
                toastr.warning('表格系统总开关已关闭，请先启用总开关。');
                return;
            }

            if (confirm('您确定要将表格状态回退到上一楼，并使用最新消息重新填表吗？')) {
                try {
                    await TableManager.rollbackAndRefill();
                } catch (error) {
                    console.error('[内存储司] 回退重填功能失败:', error);
                    toastr.error('回退重填失败，请检查系统状态。');
                }
            }
        });

        rollbackBtn.dataset.rollbackEventBound = 'true';
        log('"回退重填"按钮已成功绑定。', 'success');
    }
}

function bindTemplateEditors() {
    const ruleEditor = document.getElementById('ai-rule-template-editor');
    const ruleSaveBtn = document.getElementById('ai-rule-template-save-btn');
    const ruleRestoreBtn = document.getElementById('ai-rule-template-restore-btn');

    const flowEditor = document.getElementById('ai-flow-template-editor');
    const flowSaveBtn = document.getElementById('ai-flow-template-save-btn');
    const flowRestoreBtn = document.getElementById('ai-flow-template-restore-btn');

    if (!ruleEditor || !flowEditor) {
        log('无法找到指令模板编辑器，绑定失败。', 'warn');
        return;
    }

    ruleEditor.value = TableManager.getBatchFillerRuleTemplate();
    flowEditor.value = TableManager.getBatchFillerFlowTemplate();

    ruleSaveBtn.addEventListener('click', () => {
        TableManager.saveBatchFillerRuleTemplate(ruleEditor.value);
        toastr.success('规则提示词已保存。');
        log('批量填表-规则提示词已保存。', 'success');
    });

    flowSaveBtn.addEventListener('click', () => {
        TableManager.saveBatchFillerFlowTemplate(flowEditor.value);
        toastr.success('流程提示词已保存。');
        log('批量填表-流程提示词已保存。', 'success');
    });

    ruleRestoreBtn.addEventListener('click', () => {
        if (confirm('您确定要将规则提示词恢复为默认设置吗？')) {
            ruleEditor.value = DEFAULT_AI_RULE_TEMPLATE;
            TableManager.saveBatchFillerRuleTemplate(ruleEditor.value);
            toastr.info('规则提示词已恢复为默认。');
            log('批量填表-规则提示词已恢复默认。', 'info');
        }
    });

    flowRestoreBtn.addEventListener('click', () => {
        if (confirm('您确定要将流程提示词恢复为默认设置吗？')) {
            flowEditor.value = DEFAULT_AI_FLOW_TEMPLATE;
            TableManager.saveBatchFillerFlowTemplate(flowEditor.value);
            toastr.info('流程提示词已恢复为默认。');
            log('批量填表-流程提示词已恢复默认。', 'info');
        }
    });

    log('指令模板编辑器已成功绑定。', 'success');
}

function bindNccsApiEvents() {
    const settings = extension_settings[extensionName];
    
    if (settings.nccsEnabled === undefined) settings.nccsEnabled = false;
    if (settings.nccsApiMode === undefined) settings.nccsApiMode = 'openai_test';
    if (settings.nccsApiUrl === undefined) settings.nccsApiUrl = 'https://api.openai.com/v1';
    if (settings.nccsApiKey === undefined) settings.nccsApiKey = '';
    if (settings.nccsModel === undefined) settings.nccsModel = '';
    if (settings.nccsMaxTokens === undefined) settings.nccsMaxTokens = 2000;
    if (settings.nccsTemperature === undefined) settings.nccsTemperature = 0.7;
    if (settings.nccsTavernProfile === undefined) settings.nccsTavernProfile = '';

    const enabledToggle = document.getElementById('nccs-api-enabled');
    const configDiv = document.getElementById('nccs-api-config');
    const modeSelect = document.getElementById('nccs-api-mode');
    const urlInput = document.getElementById('nccs-api-url');
    const keyInput = document.getElementById('nccs-api-key');
    const modelInput = document.getElementById('nccs-api-model');
    const maxTokensSlider = document.getElementById('nccs-max-tokens');
    const maxTokensValue = document.getElementById('nccs-max-tokens-value');
    const temperatureSlider = document.getElementById('nccs-temperature');
    const temperatureValue = document.getElementById('nccs-temperature-value');
    const presetSelect = document.getElementById('nccs-sillytavern-preset');
    const testButton = document.getElementById('nccs-test-connection');
    const fetchModelsButton = document.getElementById('nccs-fetch-models');

    if (!enabledToggle || !configDiv) return;

    enabledToggle.checked = settings.nccsEnabled;
    if (modeSelect) modeSelect.value = settings.nccsApiMode;
    if (urlInput) urlInput.value = settings.nccsApiUrl;
    if (keyInput) keyInput.value = settings.nccsApiKey;
    if (modelInput) modelInput.value = settings.nccsModel;
    if (maxTokensSlider) {
        maxTokensSlider.value = settings.nccsMaxTokens;
        if (maxTokensValue) maxTokensValue.textContent = settings.nccsMaxTokens;
    }
    if (temperatureSlider) {
        temperatureSlider.value = settings.nccsTemperature;
        if (temperatureValue) temperatureValue.textContent = settings.nccsTemperature;
    }
    if (presetSelect) presetSelect.value = settings.nccsTavernProfile || '';

    const updateConfigVisibility = () => {
        configDiv.style.display = enabledToggle.checked ? 'block' : 'none';
    };
    updateConfigVisibility();

    const updateModeBasedVisibility = () => {
        if (!modeSelect) return;
        const isSillyTavernMode = modeSelect.value === 'sillytavern_preset';
        const isOpenAIMode = modeSelect.value === 'openai_test';

        const presetContainer = presetSelect?.closest('.amily2_opt_settings_block');
        if (presetContainer) {
            presetContainer.style.display = isSillyTavernMode ? 'block' : 'none';
        }

        const fieldsToHideInPresetMode = [
            { element: urlInput, containerId: null },
            { element: keyInput, containerId: null },
            { element: modelInput, containerId: null },
            { element: maxTokensSlider, containerId: null },
            { element: temperatureSlider, containerId: null }
        ];

        fieldsToHideInPresetMode.forEach(({ element }) => {
            if (element) {
                const container = element.closest('.amily2_opt_settings_block');
                if (container) {
                    container.style.display = isSillyTavernMode ? 'none' : 'block';
                }
            }
        });

        const buttonsContainer = testButton?.closest('.nccs-button-row');
        if (buttonsContainer) {
            buttonsContainer.style.display = 'flex'; 
        }
    };
    updateModeBasedVisibility();

    enabledToggle.addEventListener('change', () => {
        settings.nccsEnabled = enabledToggle.checked;
        saveSettingsDebounced();
        updateConfigVisibility();
        log(`Nccs API ${enabledToggle.checked ? '已启用' : '已禁用'}`, 'info');
    });

    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            settings.nccsApiMode = modeSelect.value;
            saveSettingsDebounced();
            updateModeBasedVisibility();
            log(`Nccs API模式已切换为: ${modeSelect.value}`, 'info');
        });
    }

    if (urlInput) {
        const saveUrl = () => {
            settings.nccsApiUrl = urlInput.value;
            saveSettingsDebounced();
        };
        
        urlInput.addEventListener('blur', saveUrl);
    }

    if (keyInput) {
        const saveKey = () => {
            settings.nccsApiKey = keyInput.value;
            saveSettingsDebounced();
        };
        
        keyInput.addEventListener('blur', saveKey);
    }

    if (modelInput) {
        const saveModel = () => {
            settings.nccsModel = modelInput.value;
            saveSettingsDebounced();
        };
        
        modelInput.addEventListener('blur', saveModel);
        modelInput.addEventListener('input', saveModel);
    }

    if (maxTokensSlider && maxTokensValue) {
        maxTokensSlider.addEventListener('input', () => {
            maxTokensValue.textContent = maxTokensSlider.value;
        });
        maxTokensSlider.addEventListener('change', () => {
            settings.nccsMaxTokens = parseInt(maxTokensSlider.value);
            saveSettingsDebounced();
        });
    }

    if (temperatureSlider && temperatureValue) {
        temperatureSlider.addEventListener('input', () => {
            temperatureValue.textContent = temperatureSlider.value;
        });
        temperatureSlider.addEventListener('change', () => {
            settings.nccsTemperature = parseFloat(temperatureSlider.value);
            saveSettingsDebounced();
        });
    }

    if (presetSelect) {
        presetSelect.addEventListener('change', () => {
            settings.nccsTavernProfile = presetSelect.value;
            saveSettingsDebounced();
        });
    }

    if (testButton) {
        testButton.addEventListener('click', async () => {
            testButton.disabled = true;
            testButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 测试中...';
            
            try {
                const success = await testNccsApiConnection();
                if (success) {
                    toastr.success('Nccs API连接测试成功！');
                    log('Nccs API连接测试成功', 'success');
                } else {
                    toastr.error('Nccs API连接测试失败，请检查配置');
                    log('Nccs API连接测试失败', 'error');
                }
            } catch (error) {
                toastr.error('Nccs API连接测试出错：' + error.message);
                log('Nccs API连接测试出错：' + error.message, 'error');
            } finally {
                testButton.disabled = false;
                testButton.innerHTML = '<i class="fas fa-plug"></i> 测试连接';
            }
        });
    }

    if (fetchModelsButton) {
        fetchModelsButton.addEventListener('click', async () => {
            fetchModelsButton.disabled = true;
            fetchModelsButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 获取中...';

            if (urlInput) {
                settings.nccsApiUrl = urlInput.value;
            }
            if (keyInput) {
                settings.nccsApiKey = keyInput.value;
            }
            saveSettingsDebounced();
            
            try {
                const models = await fetchNccsModels();
                if (models && models.length > 0) {
                    let modelSelect = document.getElementById('nccs-api-model-select');
                    if (!modelSelect) {
                        modelSelect = document.createElement('select');
                        modelSelect.id = 'nccs-api-model-select';
                        modelSelect.className = 'text_pole';
                        modelInput.parentNode.insertBefore(modelSelect, modelInput.nextSibling);
                    }

                    modelSelect.innerHTML = '<option value="">-- 请选择模型 --</option>';
                    models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id || model.name;
                        option.textContent = model.name || model.id;
                        if ((model.id || model.name) === settings.nccsModel) {
                            option.selected = true;
                        }
                        modelSelect.appendChild(option);
                    });

                    modelInput.style.display = 'none';
                    modelSelect.style.display = 'block';

                    modelSelect.addEventListener('change', () => {
                        const selectedModel = modelSelect.value;
                        settings.nccsModel = selectedModel;
                        modelInput.value = selectedModel;
                        saveSettingsDebounced();
                    });

                    toastr.success(`成功获取 ${models.length} 个模型`);
                    log(`Nccs API获取到 ${models.length} 个模型`, 'success');
                } else {
                    toastr.warning('未获取到可用模型');
                    log('Nccs API未获取到可用模型', 'warn');
                }
            } catch (error) {
                toastr.error('获取模型失败：' + error.message);
                log('Nccs API获取模型失败：' + error.message, 'error');
            } finally {
                fetchModelsButton.disabled = false;
                fetchModelsButton.innerHTML = '<i class="fas fa-download"></i> 获取模型';
            }
        });
    }

    const loadSillyTavernPresets = async () => {
        if (!presetSelect) return;
        try {
            const context = getContext();
            if (!context?.extensionSettings?.connectionManager?.profiles) {
                throw new Error('无法获取SillyTavern配置文件列表');
            }
            
            const profiles = context.extensionSettings.connectionManager.profiles;

            const currentProfileId = settings.nccsTavernProfile;

            presetSelect.innerHTML = '';
            presetSelect.appendChild(new Option('选择预设', '', false, false));
            
            if (profiles && profiles.length > 0) {
                profiles.forEach(profile => {
                    const isSelected = profile.id === currentProfileId;
                    const option = new Option(profile.name, profile.id, isSelected, isSelected);
                    presetSelect.appendChild(option);
                });
                log(`成功加载 ${profiles.length} 个SillyTavern配置文件`, 'success');
            } else {
                log('未找到可用的SillyTavern配置文件', 'warn');
            }
        } catch (error) {
            log('加载SillyTavern预设失败：' + error.message, 'error');
        }
    };

    if (modeSelect && presetSelect) {
        modeSelect.addEventListener('change', () => {
            if (modeSelect.value === 'sillytavern_preset') {
                loadSillyTavernPresets();
            }
        });

        if (settings.nccsApiMode === 'sillytavern_preset') {
            loadSillyTavernPresets();
        }
    }

    log('Nccs API事件绑定完成', 'success');
}

function bindChatTableDisplaySetting() {
    const settings = extension_settings[extensionName];
    const showInChatToggle = document.getElementById('show-table-in-chat-toggle');
    const continuousRenderToggle = document.getElementById('render-on-every-message-toggle');

    if (!showInChatToggle || !continuousRenderToggle) {
        log('找不到聊天内表格相关的开关，绑定失败。', 'warn');
        return;
    }

    // Initialize states from settings
    showInChatToggle.checked = settings.show_table_in_chat === true;
    continuousRenderToggle.checked = settings.render_on_every_message === true;

    // Function to update the dependency
    const updateContinuousRenderState = () => {
        if (showInChatToggle.checked) {
            continuousRenderToggle.disabled = false;
            continuousRenderToggle.closest('.control-block-with-switch').style.opacity = '1';
        } else {
            continuousRenderToggle.disabled = true;
            continuousRenderToggle.closest('.control-block-with-switch').style.opacity = '0.5';
        }
    };

    // Initial state update
    updateContinuousRenderState();

    // Event listener for the main toggle
    showInChatToggle.addEventListener('change', () => {
        settings.show_table_in_chat = showInChatToggle.checked;
        saveSettingsDebounced();
        toastr.info(`聊天内表格显示已${showInChatToggle.checked ? '开启' : '关闭'}。`);
        updateContinuousRenderState();
    });

    // Event listener for the continuous render toggle
    continuousRenderToggle.addEventListener('change', () => {
        settings.render_on_every_message = continuousRenderToggle.checked;
        saveSettingsDebounced();
        toastr.info(`持续渲染最新消息功能已${continuousRenderToggle.checked ? '开启' : '关闭'}。请切换聊天以应用更改。`);
    });

    log('聊天内表格显示设置及其依赖关系已成功绑定。', 'success');
}
