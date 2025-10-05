import { getMemoryState, getHighlights } from '../core/table-system/manager.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../utils/settings.js';

const TABLE_CONTAINER_ID = 'amily2-chat-table-container';
const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

function renderTablesToHtml(tables, highlights) {
    if (!tables || tables.length === 0) {
        return '';
    }

    let html = '';
    tables.forEach((table, tableIndex) => {
        if (table.rows && table.rows.length > 0) {
            html += `<details class="amily2-chat-table-details">`;
            html += `<summary class="amily2-chat-table-summary">${table.name}</summary>`;
            html += `<div class="amily2-chat-table" id="amily2-chat-table-${tableIndex}">`;
            html += '<table>';
            
            html += '<thead><tr>';
            table.headers.forEach(header => {
                html += `<th>${header}</th>`;
            });
            html += '</tr></thead>';

            html += '<tbody>';
            table.rows.forEach((row, rowIndex) => {
                html += '<tr>';
                row.forEach((cell, colIndex) => {
                    const highlightKey = `${tableIndex}-${rowIndex}-${colIndex}`;
                    const isHighlighted = highlights.has(highlightKey);
                    const highlightClass = isHighlighted ? ' amily2-cell-highlight' : '';
                    html += `<td class="${highlightClass}">${cell}</td>`;
                });
                html += '</tr>';
            });
            html += '</tbody>';

            html += '</table>';
            html += '</div>';
            html += `</details>`;
        }
    });

    return html;
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

    setTimeout(() => {
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
            container.innerHTML = htmlContent;
            lastMessage.appendChild(container);
            bindSwipePreventer(container); 
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
