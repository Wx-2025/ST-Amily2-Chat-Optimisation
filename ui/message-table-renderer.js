import { getMemoryState, getHighlights } from '../core/table-system/manager.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../utils/settings.js';
import { getContext } from '/scripts/extensions.js';

const TABLE_CONTAINER_ID = 'amily2-chat-table-container';
const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

// 【V155.3】注入真正的游戏UI样式 (侧边栏+内容区)
function injectChatTableStyles() {
    if (document.getElementById('amily2-chat-table-styles')) return;
    const style = document.createElement('style');
    style.id = 'amily2-chat-table-styles';
    style.textContent = `
        /* 主容器：游戏面板风格 */
        #amily2-chat-table-container {
            display: flex !important; /* 强制 Flex 布局 */
            flex-direction: row !important; /* 强制横向排列 */
            min-height: 300px;
            max-height: 80vh;
            background: rgba(12, 14, 20, 0.95);
            border: 2px solid #3a4a5e;
            border-radius: 8px;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.8), inset 0 0 30px rgba(0, 0, 0, 0.5);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #c0c0c0;
            margin-top: 15px;
            overflow: hidden;
            position: relative;
            resize: vertical;
        }

        /* 装饰性角落 */
        #amily2-chat-table-container::before {
            content: '';
            position: absolute;
            top: 0; left: 0;
            width: 20px; height: 20px;
            border-top: 2px solid #00bfff;
            border-left: 2px solid #00bfff;
            border-radius: 6px 0 0 0;
            z-index: 2;
        }
        #amily2-chat-table-container::after {
            content: '';
            position: absolute;
            bottom: 0; right: 0;
            width: 20px; height: 20px;
            border-bottom: 2px solid #00bfff;
            border-right: 2px solid #00bfff;
            border-radius: 0 0 6px 0;
            z-index: 2;
        }

        /* 侧边栏：导航菜单 */
        .amily2-game-sidebar {
            width: 140px; /* 加宽以显示文字 */
            background: rgba(20, 25, 35, 0.9);
            border-right: 1px solid #3a4a5e;
            display: flex;
            flex-direction: column;
            align-items: stretch; /* 拉伸以填满宽度 */
            padding: 10px;
            gap: 8px;
            overflow-y: auto;
            flex-shrink: 0;
        }

        .amily2-game-tab {
            height: 40px;
            border-radius: 6px;
            display: flex;
            justify-content: flex-start; /* 左对齐 */
            align-items: center;
            padding: 0 10px;
            cursor: pointer;
            color: #7a8a9e;
            transition: all 0.2s ease;
            position: relative;
            border: 1px solid transparent;
            font-size: 0.9em;
            font-weight: 600;
        }

        .amily2-game-tab i {
            width: 24px;
            text-align: center;
            margin-right: 8px;
        }

        .amily2-game-tab:hover {
            color: #e0e0e0;
            background: rgba(255, 255, 255, 0.05);
        }

        .amily2-game-tab.active {
            color: #fff;
            background: linear-gradient(90deg, rgba(0, 191, 255, 0.25), transparent);
            border-left: 3px solid #00bfff;
            text-shadow: 0 0 8px rgba(0, 191, 255, 0.8);
            box-shadow: inset 5px 0 10px -5px rgba(0, 191, 255, 0.3);
        }

        .amily2-game-tab.active::after {
            display: none; /* 移除原来的三角形指示器 */
        }

        /* 内容区 */
        .amily2-game-content {
            position: absolute;
            left: 140px; top: 0; bottom: 0; right: 0;
            overflow: hidden;
            background: transparent;
            display: flex;
            flex-direction: column;
            z-index: 10;
        }

        /* 扫描线效果 */
        .amily2-game-content::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.1) 50%);
            background-size: 100% 4px;
            pointer-events: none;
            z-index: 1;
            opacity: 0.3;
        }

        .amily2-game-panel {
            display: none;
            width: 100%;
            height: 100%;
            padding: 20px;
            overflow-y: auto;
            box-sizing: border-box;
            position: relative;
            z-index: 10; /* 确保最高层级 */
        }

        .amily2-game-panel.active {
            display: block !important;
            animation: amily2-panel-fade 0.3s ease-out;
        }

        @keyframes amily2-panel-fade {
            from { opacity: 0; transform: translateY(5px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* 面板标题 */
        .amily2-panel-title {
            font-size: 1.2em;
            font-weight: bold;
            color: #00bfff;
            margin-bottom: 15px;
            padding-bottom: 8px;
            border-bottom: 2px solid rgba(0, 191, 255, 0.3);
            text-transform: uppercase;
            letter-spacing: 1px;
            display: flex;
            align-items: center;
        }
        
        .amily2-panel-title i {
            margin-right: 10px;
        }

        /* 表格布局 (RPG风格) */
        .amily2-table-wrapper {
            width: 100%;
            overflow-x: auto; /* 允许横向滚动 */
            -webkit-overflow-scrolling: touch;
            border-radius: 6px;
            border: 1px solid rgba(100, 149, 237, 0.15);
            background: rgba(30, 35, 45, 0.4);
        }

        .amily2-data-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9em;
            white-space: nowrap; /* 防止换行，保持表格整洁 */
        }

        .amily2-data-table th,
        .amily2-data-table td {
            padding: 10px 12px;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        .amily2-data-table th {
            background: rgba(20, 25, 35, 0.8);
            color: #00bfff;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            position: sticky;
            top: 0;
            z-index: 2;
            border-bottom: 2px solid rgba(0, 191, 255, 0.3);
        }

        .amily2-data-table tr:hover {
            background: rgba(255, 255, 255, 0.05);
        }

        .amily2-data-table tr:last-child td {
            border-bottom: none;
        }

        .amily2-data-table td {
            color: #e0e0e0;
        }

        /* 第一列特殊样式 (通常是名称/ID) */
        .amily2-data-table td:first-child {
            font-weight: bold;
            color: #fff;
            border-left: 3px solid transparent;
        }

        .amily2-data-table tr:hover td:first-child {
            border-left-color: #00bfff;
        }

        /* 滚动条 */
        .amily2-game-sidebar::-webkit-scrollbar,
        .amily2-game-panel::-webkit-scrollbar {
            width: 4px;
        }
        .amily2-game-sidebar::-webkit-scrollbar-track,
        .amily2-game-panel::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.2);
        }
        .amily2-game-sidebar::-webkit-scrollbar-thumb,
        .amily2-game-panel::-webkit-scrollbar-thumb {
            background: #3a4a5e;
            border-radius: 2px;
        }

        /* 移动端适配 */
        @media (max-width: 768px) {
            #amily2-chat-table-container {
                flex-direction: column;
                height: auto;
                min-height: 400px;
            }
            .amily2-game-sidebar {
                width: 100% !important;
                height: 50px !important;
                flex-direction: row;
                padding: 0 10px;
                border-right: none;
                border-bottom: 1px solid #3a4a5e;
                overflow-x: auto;
                top: 30px !important;
                bottom: auto !important;
            }
            .amily2-game-content {
                left: 0 !important;
                top: 80px !important;
            }
            .amily2-game-tab {
                flex-shrink: 0;
            }
            .amily2-game-tab.active::after {
                right: auto;
                bottom: -8px;
                top: auto;
                left: 50%;
                transform: translateX(-50%) rotate(90deg);
            }
        }

        /* 折叠功能样式 */
        #amily2-chat-table-container.collapsed {
            min-height: 30px !important;
            height: 30px !important;
            resize: none !important;
            overflow: hidden !important;
            border-bottom: none;
        }

        #amily2-chat-table-container.collapsed .amily2-game-sidebar,
        #amily2-chat-table-container.collapsed .amily2-game-content {
            display: none !important;
        }

        .amily2-table-toggle {
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 30px;
            background: rgba(20, 25, 35, 0.95);
            border-bottom: 1px solid #3a4a5e;
            color: #00bfff;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 100;
            font-size: 0.85em;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 1px;
            transition: all 0.2s;
        }

        .amily2-table-toggle:hover {
            background: rgba(40, 50, 70, 1);
            color: #fff;
        }

        .amily2-table-toggle i {
            margin-right: 8px;
            transition: transform 0.3s;
        }

        #amily2-chat-table-container:not(.collapsed) .amily2-table-toggle i {
            transform: rotate(180deg);
        }
    `;
    document.head.appendChild(style);
}

function getTableIcon(tableName) {
    const lowerName = tableName.toLowerCase();
    if (lowerName.includes('时空') || lowerName.includes('时间') || lowerName.includes('time') || lowerName.includes('clock')) return 'fa-clock';
    if (lowerName.includes('角色') || lowerName.includes('人物') || lowerName.includes('char') || lowerName.includes('person')) return 'fa-user';
    if (lowerName.includes('关系') || lowerName.includes('relation') || lowerName.includes('social')) return 'fa-users';
    if (lowerName.includes('任务') || lowerName.includes('目标') || lowerName.includes('quest') || lowerName.includes('mission')) return 'fa-tasks';
    if (lowerName.includes('物品') || lowerName.includes('道具') || lowerName.includes('item') || lowerName.includes('inventory')) return 'fa-box-open';
    if (lowerName.includes('技能') || lowerName.includes('能力') || lowerName.includes('skill') || lowerName.includes('ability')) return 'fa-bolt';
    if (lowerName.includes('设定') || lowerName.includes('世界') || lowerName.includes('setting') || lowerName.includes('world')) return 'fa-book';
    if (lowerName.includes('总结') || lowerName.includes('大纲') || lowerName.includes('summary') || lowerName.includes('outline')) return 'fa-file-alt';
    if (lowerName.includes('日志') || lowerName.includes('log') || lowerName.includes('record')) return 'fa-clipboard-list';
    return 'fa-table';
}

function renderTablesToHtml(tables, highlights) {
    if (!tables || tables.length === 0) {
        return '';
    }

    // 过滤掉空表格
    const activeTables = tables.map((t, i) => ({...t, originalIndex: i})).filter(t => t.rows && t.rows.length > 0);
    if (activeTables.length === 0) return '';

    // Toggle 按钮
    const toggleHtml = `
        <div class="amily2-table-toggle" title="点击展开/收起">
            <i class="fas fa-chevron-down"></i>
            <span>表格面板 / Data Panel</span>
        </div>
    `;

    // 使用绝对定位强制布局，这是最稳妥的方式，不受 Flex 环境影响
    // top: 30px 留给 toggle 按钮
    let sidebarHtml = '<div class="amily2-game-sidebar" style="position: absolute; left: 0; top: 30px; bottom: 0; width: 140px; overflow-y: auto; border-right: 1px solid #3a4a5e;">';
    let contentHtml = '<div class="amily2-game-content" style="position: absolute; left: 140px; top: 30px; bottom: 0; right: 0; overflow: hidden;">';

    activeTables.forEach((table, index) => {
        const isActive = index === 0 ? 'active' : '';
        const icon = getTableIcon(table.name);
        
        // 侧边栏按钮 (现在包含文字)
        sidebarHtml += `
            <div class="amily2-game-tab ${isActive}" data-target="game-panel-${index}" title="${table.name}">
                <i class="fas ${icon}"></i>
                <span class="tab-text">${table.name}</span>
            </div>
        `;

        // 内容面板 (表格渲染)
        let tableHtml = '';
        
        // 构建表头
        const theadHtml = `
            <thead>
                <tr>
                    ${table.headers.map(header => `<th>${header}</th>`).join('')}
                </tr>
            </thead>
        `;

        // 构建表体
        let tbodyHtml = '<tbody>';
        table.rows.forEach((row, rowIndex) => {
            const rowStatus = table.rowStatuses ? table.rowStatuses[rowIndex] : 'normal';
            if (rowStatus === 'pending-deletion') return;

            tbodyHtml += '<tr>';
            row.forEach((cell, colIndex) => {
                const highlightKey = `${table.originalIndex}-${rowIndex}-${colIndex}`;
                const isHighlighted = highlights.has(highlightKey);
                const style = isHighlighted ? 'style="color: #00ff7f; font-weight: bold;"' : '';
                tbodyHtml += `<td ${style}>${cell}</td>`;
            });
            tbodyHtml += '</tr>';
        });
        tbodyHtml += '</tbody>';

        tableHtml = `
            <div class="amily2-table-wrapper">
                <table class="amily2-data-table">
                    ${theadHtml}
                    ${tbodyHtml}
                </table>
            </div>
        `;

        contentHtml += `
            <div id="game-panel-${index}" class="amily2-game-panel ${isActive}">
                <div class="amily2-panel-title"><i class="fas ${icon}"></i> ${table.name}</div>
                ${tableHtml}
            </div>
        `;
    });

    sidebarHtml += '</div>';
    contentHtml += '</div>';

    return `<div class="amily2-game-ui-wrapper">${toggleHtml}${sidebarHtml}${contentHtml}</div>`;
}

function removeTableContainer() {
    const existingContainer = document.getElementById(TABLE_CONTAINER_ID);
    if (existingContainer) {
        existingContainer.remove();
    }
}

function bindSwipePreventer(container) {
    if (!isTouchDevice()) {
        return;
    }

    let touchstartX = 0;
    let touchstartY = 0;

    container.addEventListener('touchstart', function(event) {
        touchstartX = event.changedTouches[0].screenX;
        touchstartY = event.changedTouches[0].screenY;
    }, { passive: true });

    container.addEventListener('touchmove', function(event) {
        const touchendX = event.changedTouches[0].screenX;
        const touchendY = event.changedTouches[0].screenY;

        const deltaX = Math.abs(touchendX - touchstartX);
        const deltaY = Math.abs(touchendY - touchstartY);

        if (deltaX > deltaY) {
            event.stopPropagation();
        }
    }, { passive: false });
}

export function updateOrInsertTableInChat() {
    injectChatTableStyles(); // 确保样式已注入

    setTimeout(() => {
        const context = getContext();
        if (!context || !context.chat || context.chat.length < 2) {
            removeTableContainer();
            return;
        }

        const settings = extension_settings[extensionName];
        removeTableContainer();

        if (!settings || !settings.show_table_in_chat) {
            return; 
        }

        const tables = getMemoryState();
        
        if (!tables || tables.every(t => !t.rows || t.rows.length === 0)) {
            return; 
        }

        const highlights = getHighlights();
        const htmlContent = renderTablesToHtml(tables, highlights);

        if (!htmlContent) {
            return; 
        }

        const lastMessage = document.querySelector('.last_mes .mes_text');
        if (lastMessage) {
            const container = document.createElement('div');
            container.id = TABLE_CONTAINER_ID;
            
            // 强制内联样式，使用相对定位作为绝对定位子元素的锚点
            container.style.cssText = `
                display: block !important; /* 不再依赖 Flex */
                min-height: 300px;
                max-height: 80vh;
                background: rgba(12, 14, 20, 0.95);
                border: 2px solid #3a4a5e;
                border-radius: 8px;
                margin-top: 15px;
                overflow: hidden;
                position: relative; /* 关键：作为定位锚点 */
                resize: vertical;
                width: 100%;
            `;
            
            container.innerHTML = htmlContent;
            container.classList.add('collapsed'); // 默认折叠

            // On mobile devices, add a specific class to enable horizontal scrolling via CSS
            if (isTouchDevice()) {
                container.classList.add('mobile-table-view');
                container.style.flexDirection = 'column'; // 移动端保持垂直
            }

            lastMessage.appendChild(container);
            bindSwipePreventer(container); 
            
            // 绑定鼠标滚轮横向滚动事件
            const tableWrappers = container.querySelectorAll('.amily2-table-wrapper');
            tableWrappers.forEach(wrapper => {
                wrapper.addEventListener('wheel', (e) => {
                    if (e.deltaY !== 0) {
                        e.preventDefault();
                        wrapper.scrollLeft += e.deltaY;
                    }
                });
            });

            // 绑定折叠按钮事件
            const toggleBtn = container.querySelector('.amily2-table-toggle');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    container.classList.toggle('collapsed');
                });
            }

            // 【V155.3】绑定游戏UI的交互事件
            const tabs = container.querySelectorAll('.amily2-game-tab');
            const panels = container.querySelectorAll('.amily2-game-panel');
            
            tabs.forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.stopPropagation(); // 防止触发消息点击
                    
                    // 移除所有激活状态
                    tabs.forEach(t => t.classList.remove('active'));
                    panels.forEach(p => p.classList.remove('active'));
                    
                    // 激活当前
                    tab.classList.add('active');
                    const targetId = tab.dataset.target;
                    const targetPanel = container.querySelector(`#${targetId}`);
                    if (targetPanel) targetPanel.classList.add('active');
                });
            });

        } else {
            console.warn('[Amily2] 未找到最后一条消息的容器，无法插入表格。');
        }
    }, 0);
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

let chatObserver = null;
const debouncedUpdate = debounce(updateOrInsertTableInChat, 100);

export function startContinuousRendering() {
    if (chatObserver) {
        console.log('[Amily2] Continuous rendering is already active.');
        return;
    }

    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        console.error('[Amily2] Could not find chat container to observe.');
        setTimeout(startContinuousRendering, 500);
        return;
    }

    const observerConfig = { childList: true };

    chatObserver = new MutationObserver((mutationsList, observer) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                let messageAdded = false;
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1 && node.classList.contains('mes')) {
                        messageAdded = true;
                    }
                });

                if (messageAdded) {
                    debouncedUpdate();
                    return; 
                }
            }
        }
    });

    chatObserver.observe(chatContainer, observerConfig);
    console.log('[Amily2] Started continuous table rendering.');
    updateOrInsertTableInChat();
}

export function stopContinuousRendering() {
    if (chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
        removeTableContainer();
        console.log('[Amily2] Stopped continuous table rendering.');
    }
}
