import { ingestTextToHanlinyuan, getSettings } from './rag-processor.js';
import { deleteRow, insertRow, updateRow } from './table-system/manager.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../utils/settings.js';

let isArchiving = false;

export function initializeArchiveManager() {
    document.addEventListener('AMILY2_TABLE_UPDATED', handleTableUpdate);
    console.log('[归档管理器] 已启动，正在监控表格状态...');
}

async function handleTableUpdate(event) {
    const { tableName, data, role } = event.detail;
    const settings = getSettings();

    if (!settings.archive || !settings.archive.enabled) return;

    const targetTable = settings.archive.targetTable || '总结表';
    const threshold = settings.archive.threshold || 20;

    if (tableName !== targetTable) return;

    if (isArchiving) return;

    let hasNotice = false;
    
    if (data.length > 0 && data[0][2] && data[0][2].includes('已自动归档')) {
        hasNotice = true;
        realRows = data.slice(1);
    }

    if (realRows.length > threshold) {
        console.log(`[归档管理器] 检测到 ${targetTable} 行数 (${realRows.length}) 超过阈值 (${threshold})，开始归档...`);
        await performArchive(data, hasNotice, targetTable);
    }
}

async function performArchive(allRows, hasNotice, targetTable) {
    isArchiving = true;
    const settings = getSettings();
    const batchSize = settings.archive.batchSize || 10;

    try {

        const startIndex = hasNotice ? 1 : 0;
        const rowsToArchive = allRows.slice(startIndex, startIndex + batchSize);

        if (rowsToArchive.length === 0) return;

        const tables = getMemoryState();
        const outlineTable = tables ? tables.find(t => t.name === '总体大纲') : null;
        const outlineMap = new Map();
        
        if (outlineTable && outlineTable.rows) {
            outlineTable.rows.forEach(row => {
                if (row[0]) outlineMap.set(row[0], row[1] || '无大纲内容');
            });
        }

        const archiveText = rowsToArchive.map(row => {
            const index = row[0] || '未知索引';
            const timeSpan = row[1] || '未知时间';
            const summary = row[2] || '无内容';
            const outline = outlineMap.get(index) || '无大纲关联';
            
            return `[历史总结归档] [索引: ${index}] [时间: ${timeSpan}] [大纲: ${outline}]\n${summary}`;
        }).join('\n\n');

        const fullText = archiveText;

        console.log('[归档管理器] 正在将旧总结录入翰林院...');

        const result = await ingestTextToHanlinyuan(
            fullText, 
            'manual', 
            { sourceName: '历史总结归档' },
            (progress) => console.log(`[归档进度] ${progress.message}`)
        );

        if (result.success) {
            console.log('[归档管理器] 录入成功，正在清理表格...');

            const indicesToDelete = [];
            for (let i = 0; i < rowsToArchive.length; i++) {
                indicesToDelete.push(startIndex + i);
            }

            for (let i = indicesToDelete.length - 1; i >= 0; i--) {
                await deleteRow(findTableIndex(targetTable), indicesToDelete[i]);
            }
            const noticeText = `（已自动归档 ${rowsToArchive.length} 条历史记录至翰林院，可随时询问找回）`;
            const noticeRowData = {
                0: 'SYSTEM',
                1: '---',
                2: noticeText
            };

            if (hasNotice) {

                await updateRow(findTableIndex(targetTable), 0, noticeRowData);
            } else {

                await insertRow(findTableIndex(targetTable), 0, 'above');
                await updateRow(findTableIndex(targetTable), 0, noticeRowData);
            }

            console.log('[归档管理器] 归档流程完成。');
        } else {
            console.error('[归档管理器] RAG 录入失败，取消清理。', result.error);
        }

    } catch (error) {
        console.error('[归档管理器] 执行出错:', error);
    } finally {
        isArchiving = false;
    }
}

import { getMemoryState } from './table-system/manager.js';

function findTableIndex(name) {
    const tables = getMemoryState();
    if (!tables) return -1;
    return tables.findIndex(t => t.name === name);
}
