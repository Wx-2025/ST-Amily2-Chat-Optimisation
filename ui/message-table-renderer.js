import { getMemoryState, getHighlights } from '../core/table-system/manager.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../utils/settings.js';

const TABLE_CONTAINER_ID = 'amily2-chat-table-container';

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
        } else {
            console.warn('[Amily2] 未找到最后一条消息的容器，无法插入表格。');
        }
    }, 0);
}
