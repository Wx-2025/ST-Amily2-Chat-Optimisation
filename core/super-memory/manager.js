import { extension_settings, getContext } from "/scripts/extensions.js";
import { extensionName } from "../../utils/settings.js";
import { amilyHelper } from "../tavern-helper/main.js";
import { generateIndex } from "./smart-indexer.js";
import { syncToLorebook, ensureMemoryBook, updateTransientHint, getMemoryBookName } from "./lorebook-bridge.js";
import { getMemoryState } from "../table-system/manager.js";
import { TABLE_UPDATED_EVENT, inferTableRole } from "../table-system/events-schema.js";
import { eventSource, event_types } from "/script.js";
import { handleArchiveUpdate } from "../archive-manager.js";

/* ── [AMILY2-MODIFIED] ── pipeline integration: awaitSync() export ── */
let isInitialized = false;
let updateQueue = [];
let isProcessing = false;
let _syncPromise = null; // tracks the running processQueue() promise for pipeline awaiting

/**
 * [AMILY2-MODIFIED] Pipeline integration:
 * Allows MessagePipeline Stage 4 to await the super-memory sync triggered
 * by the AMILY2_TABLE_UPDATED CustomEvent during Stage 3.
 */
export async function awaitSync() {
    if (_syncPromise) await _syncPromise;
}

export async function initializeSuperMemory() {
    const userType = parseInt(localStorage.getItem("plugin_user_type") || "0");
    if (userType < 2) {
        console.warn('[Amily2-SuperMemory] 权限不足 (Type < 2)，拒绝初始化超级记忆系统。');
        if (window.$) $('#sm-system-status').text('未授权').css('color', 'red');
        return;
    }

    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) {
        console.log('[Amily2-SuperMemory] 功能已禁用 (super_memory_enabled = false)。');
        if (window.$) $('#sm-system-status').text('已禁用').css('color', 'gray');
        return;
    }

    if (isInitialized) {
        if (window.$) $('#sm-system-status').text('运行中').css('color', '#4caf50');
        return;
    }
    console.log('[Amily2-SuperMemory] 初始化核心管理器...');
    
    if (!amilyHelper) {
        console.error('[Amily2-SuperMemory] 致命错误：AmilyHelper 未就绪。');
        return;
    }

    document.addEventListener(TABLE_UPDATED_EVENT, handleTableUpdate);

    // 【修复】CHAT_CHANGED 时不再主动 forceSyncAll：
    // 表格系统在 index.js 的 CHAT_CHANGED 里延迟 100ms 才 loadTables()，
    // 此处立即同步会把【旧聊天】的表格内容写进【新角色】的记忆世界书（竞态污染；
    // 两边表名不同时旧表条目无 GC 兜底，会永久残留）。
    // 无需自行补同步：loadTables() 三个分支结尾都会 dispatchAllTablesUpdate()，
    // 新状态会经 pushUpdate 自动入队。这里只负责确保新角色的记忆世界书存在。
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        const settings = extension_settings[extensionName] || {};
        if (settings.super_memory_enabled === false) return;
        await checkWorldBookStatus();
    });

    await checkWorldBookStatus();

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

/**
 * Bus 直调路径：由 TableSystem 通过 query('SuperMemory').pushUpdate(payload) 调用。
 * 接受纯对象 payload（events-schema.js 中 createTableUpdateEvent 的 detail 结构）。
 */
export function pushUpdate(payload) {
    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) return;

    // 楼层数检查：聊天消息数不足时跳过同步
    const minFloor = settings.superMemory_minTriggerFloor ?? 0;
    if (minFloor > 0) {
        const chatLength = getContext()?.chat?.length ?? 0;
        if (chatLength < minFloor) {
            console.log(`[Amily2-SuperMemory] 当前楼层 ${chatLength} < 最低触发楼层 ${minFloor}，跳过同步。`);
            return;
        }
    }

    const { tableName, data, role, headers, rowStatuses } = payload;
    console.log(`[Amily2-SuperMemory] 收到表格更新 (Bus): ${tableName} (Role: ${role})`);

    updateQueue.push({ tableName, data, role, headers, rowStatuses });
    // 【修复】队列正忙时不可覆盖 _syncPromise：旧实现每次都赋值 processQueue()，
    // 而 processQueue 在 isProcessing 时立即返回（已 resolve 的空 Promise），
    // 导致 Pipeline Stage 4 的 awaitSync() 穿透、在同步未完成时放行后续阶段。
    // 正在跑的 drain 循环会自然吃掉刚入队的项，无需新起 Promise。
    if (!isProcessing) {
        _syncPromise = processQueue();
    }

    // Bus 路径下 document event 不再分发，需直接通知归档管理器
    handleArchiveUpdate(payload);
}

/** CustomEvent 降级路径（Bus 未就绪时的兜底监听器） */
function handleTableUpdate(event) {
    // Bus 已就绪时 pushUpdate 已由 dispatchTableUpdate 直调，跳过避免重复处理
    if (window.Amily2Bus?.query('SuperMemory')?.pushUpdate) return;
    pushUpdate(event.detail);
}

async function processQueue() {
    if (isProcessing || updateQueue.length === 0) return;
    isProcessing = true;

    try {
        while (updateQueue.length > 0) {

            const consolidatedTasks = new Map();
            const currentBatch = [...updateQueue];
            updateQueue.length = 0; // 清空队列
            
            for (const task of currentBatch) {
                consolidatedTasks.set(task.tableName, task);
            }
            
            if (currentBatch.length > consolidatedTasks.size) {
                console.log(`[Amily2-SuperMemory] 队列优化: 将 ${currentBatch.length} 个事件合并为 ${consolidatedTasks.size} 个操作。`);
            }

            for (const task of consolidatedTasks.values()) {
                await processUpdateTask(task);
            }
        }

        // 【修复】移除 saveStateToMetadata()：msg.metadata 不是 ST 的持久化字段
        // （消息体标准位是 msg.extra），写入后会蒸发，恢复路径永远找不到东西——
        // 整条"元数据状态保存/恢复"链路是死代码。表格状态的唯一持久化信源是
        // 表格系统自己的 msg.extra.amily2_tables_data（infra/persistence.js）。

    } catch (error) {
        console.error('[Amily2-SuperMemory] 处理更新队列失败:', error);
    } finally {
        isProcessing = false;
        if (updateQueue.length > 0) {
            _syncPromise = processQueue();
        }
    }
}

async function processUpdateTask(task) {
    const { tableName, data, role, hint, headers, rowStatuses } = task;

    const settings = extension_settings[extensionName] || {};
    const tableSettings = settings.superMemory_tableSettings?.[tableName] || {};

    if (tableSettings.sync === false) {
        console.log(`[Amily2-SuperMemory] 表格 ${tableName} 已配置为不写入世界书，跳过同步。`);
        return;
    }

    const isIndexConstant = tableSettings.constant !== false;

    const activeData = data.filter((_, i) => !rowStatuses || rowStatuses[i] !== 'pending-deletion');
    const indexText = generateIndex(activeData, headers, role, tableName);
    
    const allTables = getMemoryState();
    const tableIndex = allTables.findIndex(t => t.name === tableName);
    const depth = 8001 + (tableIndex >= 0 ? tableIndex : 99);

    await syncToLorebook(tableName, data, indexText, role, headers, rowStatuses, depth, isIndexConstant);

    if (hint) {
        console.log(`[Amily2-SuperMemory] 应用主动记忆提示: ${hint}`);
        await updateTransientHint(hint);
    }
    
    console.log(`[Amily2-SuperMemory] 任务完成: ${tableName}`);
    
    updateDashboardCounters();
}

// 【已停用 2026-06-12】saveStateToMetadata / tryRestoreStateFromMetadata：
// msg.metadata 不是 ST 持久化字段（同 secondary-filler 修过的坑），写了会蒸发、
// 读永远为空——整条链路判定为从未真正工作过。若它"工作"了反而更糟：恢复出的
// 过期副本会覆盖表格系统从 msg.extra.amily2_tables_data 恢复的正确状态（双信源打架）。
// 表格状态的持久化与恢复完全交由表格系统（loadTables / saveStateToMessage）。
//
// 原实现注释保留（原作者代码，不排除存在未知副作用依赖；确认稳定几个版本后再清）：
//
// const METADATA_KEY = 'Amily2_Memory_Data';
//
// async function saveStateToMetadata() {
//     const context = getContext();
//     if (!context.chat || context.chat.length === 0) return;
//
//     const lastMsgIndex = context.chat.length - 1;
//     const lastMsg = context.chat[lastMsgIndex];
//
//     const currentState = getMemoryState();
//
//     if (!lastMsg.metadata) lastMsg.metadata = {};
//
//     lastMsg.metadata[METADATA_KEY] = JSON.parse(JSON.stringify(currentState));
//
//     if (context.saveChat) {
//         await context.saveChat();
//     }
//
//     console.log(`[Amily2-SuperMemory] 状态已保存至消息 #${lastMsgIndex}`);
// }
// （原调用点：processQueue 的 while 循环结束后 `await saveStateToMetadata();`）
//
// export async function tryRestoreStateFromMetadata() {
//     const context = getContext();
//     if (!context.chat || context.chat.length === 0) return;
//
//     let foundState = null;
//     let foundIndex = -1;
//
//     for (let i = context.chat.length - 1; i >= 0; i--) {
//         const msg = context.chat[i];
//         if (msg.metadata && msg.metadata[METADATA_KEY]) {
//             foundState = msg.metadata[METADATA_KEY];
//             foundIndex = i;
//             break;
//         }
//     }
//
//     if (foundState) {
//         console.log(`[Amily2-SuperMemory] 发现历史状态 (Msg #${foundIndex})，正在恢复...`);
//         if (typeof loadMemoryState === 'function') {  // 需从 table-system/manager.js 导入 loadMemoryState
//             loadMemoryState(foundState);
//             await forceSyncAll();
//         } else {
//             console.warn('[Amily2-SuperMemory] table-system 缺少 loadMemoryState 方法，无法恢复状态。');
//         }
//     } else {
//         console.log('[Amily2-SuperMemory] 未在聊天记录中发现历史状态，使用默认/当前状态。');
//     }
// }
// （原调用点：initializeSuperMemory 与 CHAT_CHANGED 监听器内，各一次，后接 forceSyncAll；
//   Bus 暴露：SuperMemoryService 的 tryRestoreStateFromMetadata，已一并停用）

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

    // 楼层数检查
    const settings = extension_settings[extensionName] || {};
    const minFloor = settings.superMemory_minTriggerFloor ?? 0;
    if (minFloor > 0) {
        const chatLength = getContext()?.chat?.length ?? 0;
        if (chatLength < minFloor) {
            console.log(`[Amily2-SuperMemory] 全量同步跳过：当前楼层 ${chatLength} < 最低触发楼层 ${minFloor}。`);
            return;
        }
    }

    const tables = getMemoryState();

    if (!tables || tables.length === 0) {
        console.warn('[Amily2-SuperMemory] 没有可同步的表格数据。');
        return;
    }

    for (const table of tables) {
        updateQueue.push({
            tableName: table.name,
            data: table.rows,
            headers: table.headers,
            rowStatuses: table.rowStatuses || [],
            role: inferTableRole(table.name), // 复用 events-schema 的统一推断，避免两处逻辑漂移
        });
    }

    if (!isProcessing) {
        _syncPromise = processQueue();
    }
    await _syncPromise;
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
