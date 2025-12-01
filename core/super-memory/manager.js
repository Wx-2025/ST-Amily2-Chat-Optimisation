import { extension_settings, getContext } from "/scripts/extensions.js";
import { extensionName } from "../../utils/settings.js";
import { amilyHelper } from "../tavern-helper/main.js";
import { generateIndex } from "./smart-indexer.js";
import { syncToLorebook, ensureMemoryBook, updateTransientHint, getMemoryBookName } from "./lorebook-bridge.js";
import { getMemoryState, loadMemoryState, saveMemoryState } from "../table-system/manager.js";
import { eventSource, event_types } from "/script.js";

let isInitialized = false;
let updateQueue = [];
let isProcessing = false;
let lastChatId = null;

const METADATA_KEY = 'Amily2_Memory_Data';

export async function initializeSuperMemory() {
    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) {
        console.log('[Amily2-SuperMemory] 功能已禁用 (super_memory_enabled = false)。');
        if (window.$) $('#sm-system-status').text('已禁用').css('color', 'gray');
        return;
    }

    if (isInitialized) return;
    console.log('[Amily2-SuperMemory] 初始化核心管理器...');
    
    if (!amilyHelper) {
        console.error('[Amily2-SuperMemory] 致命错误：AmilyHelper 未就绪。');
        return;
    }

    document.addEventListener('AMILY2_TABLE_UPDATED', handleTableUpdate);
    
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        const settings = extension_settings[extensionName] || {};
        if (settings.super_memory_enabled === false) return;

        console.log('[Amily2-SuperMemory] 检测到聊天切换，正在刷新记忆状态...');
        await checkWorldBookStatus();
        
        await tryRestoreStateFromMetadata();
        
        await forceSyncAll();
    });
    
    await checkWorldBookStatus();
    
    await tryRestoreStateFromMetadata();
    
    await forceSyncAll(); 

    isInitialized = true;
    console.log('[Amily2-SuperMemory] 核心管理器初始化完成。');
    
    if (window.$) {
        $('#sm-system-status').text('运行中').css('color', '#4caf50');
    }
}

async function checkWorldBookStatus() {
    try {
        await ensureMemoryBook();
    } catch (error) {
        console.error('[Amily2-SuperMemory] 检查世界书状态失败:', error);
    }
}

function handleTableUpdate(event) {
    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) return;

    const { tableName, data, role, hint, headers, rowStatuses } = event.detail; 
    console.log(`[Amily2-SuperMemory] 检测到表格更新: ${tableName} (Role: ${role})`);
    
    updateQueue.push({ tableName, data, role, hint, headers, rowStatuses });
    processQueue();
}

async function processQueue() {
    if (isProcessing || updateQueue.length === 0) return;
    isProcessing = true;

    try {
        while (updateQueue.length > 0) {
            // 【V153.1 性能优化】合并同类项
            // 批量填表可能会在短时间内触发大量同表的更新事件。
            // 我们只需要处理每个表格在该批次中的最后一次（最新）状态即可。
            const consolidatedTasks = new Map();
            
            // 取出当前队列中的所有任务
            const currentBatch = [...updateQueue];
            updateQueue.length = 0; // 清空队列
            
            for (const task of currentBatch) {
                // 后面的任务会覆盖前面的任务，确保只保留最新状态
                consolidatedTasks.set(task.tableName, task);
            }
            
            if (currentBatch.length > consolidatedTasks.size) {
                console.log(`[Amily2-SuperMemory] 队列优化: 将 ${currentBatch.length} 个事件合并为 ${consolidatedTasks.size} 个操作。`);
            }

            // 执行合并后的任务
            for (const task of consolidatedTasks.values()) {
                await processUpdateTask(task);
            }
        }
        
        await saveStateToMetadata();
        
    } catch (error) {
        console.error('[Amily2-SuperMemory] 处理更新队列失败:', error);
    } finally {
        isProcessing = false;
        // 如果在处理期间又有新任务进入队列，重新触发处理
        if (updateQueue.length > 0) {
            processQueue();
        }
    }
}

async function processUpdateTask(task) {
    const { tableName, data, role, hint, headers, rowStatuses } = task;
    
    const activeData = data.filter((_, i) => !rowStatuses || rowStatuses[i] !== 'pending-deletion');
    const indexText = generateIndex(activeData, role, tableName);
    
    const allTables = getMemoryState();
    const tableIndex = allTables.findIndex(t => t.name === tableName);
    const depth = 8001 + (tableIndex >= 0 ? tableIndex : 99);

    await syncToLorebook(tableName, data, indexText, role, headers, rowStatuses, depth);

    if (hint) {
        console.log(`[Amily2-SuperMemory] 应用主动记忆提示: ${hint}`);
        await updateTransientHint(hint);
    }
    
    console.log(`[Amily2-SuperMemory] 任务完成: ${tableName}`);
    
    updateDashboardCounters();
}

async function saveStateToMetadata() {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;

    const lastMsgIndex = context.chat.length - 1;
    const lastMsg = context.chat[lastMsgIndex];
    
    const currentState = getMemoryState();
    
    if (!lastMsg.metadata) lastMsg.metadata = {};
    
    lastMsg.metadata[METADATA_KEY] = JSON.parse(JSON.stringify(currentState));
    
    if (context.saveChat) {
        await context.saveChat(); 
    }
    
    console.log(`[Amily2-SuperMemory] 状态已保存至消息 #${lastMsgIndex}`);
}

export async function tryRestoreStateFromMetadata() {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return;

    let foundState = null;
    let foundIndex = -1;

    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (msg.metadata && msg.metadata[METADATA_KEY]) {
            foundState = msg.metadata[METADATA_KEY];
            foundIndex = i;
            break;
        }
    }

    if (foundState) {
        console.log(`[Amily2-SuperMemory] 发现历史状态 (Msg #${foundIndex})，正在恢复...`);
        if (typeof loadMemoryState === 'function') {
            loadMemoryState(foundState);
            await forceSyncAll();
        } else {
            console.warn('[Amily2-SuperMemory] table-system 缺少 loadMemoryState 方法，无法恢复状态。');
        }
    } else {
        console.log('[Amily2-SuperMemory] 未在聊天记录中发现历史状态，使用默认/当前状态。');
    }
}

function updateDashboardCounters() {
    const tables = getMemoryState();
    if (tables && window.$) {
        $('#sm-index-count').text(`${tables.length} 个索引`);
        const totalRows = tables.reduce((acc, t) => acc + (t.rows ? t.rows.length : 0), 0);
        $('#sm-detail-count').text(`${totalRows} 个详情`);
    }
}

export async function forceSyncAll() {
    console.log('[Amily2-SuperMemory] 正在执行全量同步...');
    const tables = getMemoryState();
    
    if (!tables || tables.length === 0) {
        console.warn('[Amily2-SuperMemory] 没有可同步的表格数据。');
        return;
    }

    for (const table of tables) {
        let role = 'database';
        if (table.name.includes('时空') || table.name.includes('世界钟')) role = 'anchor';
        if (table.name.includes('日志') || table.name.includes('Log')) role = 'log';

        updateQueue.push({
            tableName: table.name,
            data: table.rows,
            headers: table.headers, 
            rowStatuses: table.rowStatuses || [], 
            role: role
        });
    }
    
    await processQueue();
    console.log('[Amily2-SuperMemory] 全量同步完成。');
}

export async function purgeSuperMemory() {
    try {
        console.log('[Amily2-SuperMemory] 开始清空记忆...');
        const bookName = getMemoryBookName();
        const entries = await amilyHelper.getLorebookEntries(bookName);
        
        if (!entries || entries.length === 0) {
            console.log('[Amily2-SuperMemory] 世界书为空，无需清理。');
            return;
        }

        const entriesToDelete = [];
        const prefixes = ['[Amily2]', '【Amily2']; 

        for (const entry of entries) {
            if (entry.comment && prefixes.some(p => entry.comment.startsWith(p))) {
                entriesToDelete.push(entry.uid);
            }
        }

        if (entriesToDelete.length > 0) {
            await amilyHelper.deleteLorebookEntries(bookName, entriesToDelete);
            console.log(`[Amily2-SuperMemory] 已清空 ${entriesToDelete.length} 个条目。`);
            if (window.toastr) toastr.success(`已清空 ${entriesToDelete.length} 条记忆数据`);
        } else {
            if (window.toastr) toastr.info('没有发现需要清空的Amily2记忆数据');
        }
        
        updateDashboardCounters();

    } catch (error) {
        console.error('[Amily2-SuperMemory] 清空失败:', error);
        if (window.toastr) toastr.error('清空失败: ' + error.message);
    }
}
