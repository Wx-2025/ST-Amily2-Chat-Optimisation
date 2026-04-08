import { getContext, extension_settings } from '/scripts/extensions.js';
import { saveChat, saveSettingsDebounced } from '/script.js';
import { log } from './logger.js';
import { executeCommands } from './executor.js';
import { fillWithSecondaryApi } from './secondary-filler.js';
import { getChatPiece, saveChatDebounced } from '../../utils/utils.js';
import { extensionName } from '../../utils/settings.js';
import { DEFAULT_AI_RULE_TEMPLATE, DEFAULT_AI_FLOW_TEMPLATE } from './settings.js';
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { TABLE_UPDATED_EVENT, createTableUpdateEvent, inferTableRole } from './events-schema.js';

const TABLE_DATA_KEY = 'amily2_tables_data'; // Key for multiple tables

// 用于在内存中缓存当前表格状态数组
let currentTablesState = null;
// 用于记录需要高亮的单元格
let highlightedCells = new Set();
// 用于记录被更新过的表格
let updatedTables = new Set();

function dispatchTableUpdate(tableIndex) {
    // 检查 Super Memory 功能开关
    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) return;

    if (!currentTablesState || !currentTablesState[tableIndex]) return;
    const table = currentTablesState[tableIndex];
    const role = inferTableRole(table.name);

    // 优先走 Bus 直调（避免 DOM 事件广播）
    const smBus = window.Amily2Bus?.query('SuperMemory');
    if (smBus?.pushUpdate) {
        smBus.pushUpdate({ tableName: table.name, data: table.rows, headers: table.headers, rowStatuses: table.rowStatuses ?? [], role });
    } else {
        // 降级：CustomEvent（Bus 未就绪时的初始化阶段）
        document.dispatchEvent(createTableUpdateEvent(table));
    }
    log(`[SuperMemory] Dispatched update for ${table.name} (role: ${role})`, 'info');
}

function dispatchAllTablesUpdate() {
    if (!currentTablesState) return;
    log('[SuperMemory] Dispatching update events for ALL tables...', 'info');
    currentTablesState.forEach((_, index) => {
        dispatchTableUpdate(index);
    });
}

/**
 * 主动触发所有表格同步到 SuperMemory（Pipeline 变更后调用）。
 * 确保同步的是当前最新的 currentTablesState，而非 loadTables() 时的旧状态。
 */
export function triggerSync() {
    dispatchAllTablesUpdate();
}

export function addHighlight(tableIndex, rowIndex, colIndex) {
    const key = `${tableIndex}-${rowIndex}-${colIndex}`;
    highlightedCells.add(key);
}

export function getHighlights() {
    return highlightedCells;
}

export function clearHighlights() {
    if (highlightedCells.size > 0) {
        highlightedCells.clear();
        log('已清除所有单元格高亮标记。', 'info');
    }
}

export function getUpdatedTables() {
    return updatedTables;
}

export function clearUpdatedTables() {
    if (updatedTables.size > 0) {
        updatedTables.clear();
        log('已清除所有表格的更新标记。', 'info');
    }
}

export function setMemoryState(newState) {
    currentTablesState = newState;
}

export function loadMemoryState(state) {
    if (!state) return;
    setMemoryState(state);
    // 触发 UI 刷新
    renderTables();
    updateOrInsertTableInChat();
    log('[SuperMemory] 已从元数据恢复内存状态并刷新 UI。', 'info');
}

export function saveMemoryState() {
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            // 注意：这里不强制 saveChat()，以免过于频繁
            // 但如果是在生成结束后调用，应该 saveChat
            // 目前主要依靠 SuperMemory 的 saveStateToMetadata 调用 saveChat
            return true;
        }
    }
    return false;
}

export function getMemoryState() {
    return currentTablesState;
}

// 预设模板内容 (直接嵌入，避免异步文件读取的复杂性)
const defaultTemplate = {
    "tables": [
        {
          "name": "时空栏",
          "headers": [
            "日期",
            "时段",
            "时间",
            "地点",
            "此地角色"
          ],
          "note": "【核心作用】此表格用于精确追踪故事发生的即时时空背景，确保时间与空间的连续性。它应该始终只包含一行，代表当前的“镜头”位置。\n【字段详解】\n- 日期: 格式为'YYYY-MM-DD'。若日期未知，请根据上下文合理推断或设定一个初始日期，如'大夏3年-9月-10日'。\n- 时段: 严格遵循规定（凌晨：0-5时；早晨：5-8时；上午：8-11时；中午：11-13时；下午：13-16时；傍晚：16-19时；晚上：19-24时）。\n- 时间: 格式为'HH:MM'。若时间未知，可根据时段估算，如'08:30'。\n- 地点: 描述当前场景发生的具体位置，应尽可能精确，例如'XX街的咖啡馆'而非'城里'。\n- 此地角色: 列出当前场景中所有在场且参与互动的主要角色，用'/'分隔。",
          "rule_add": "【触发条件】当故事开始，且此表格为空时，必须立即根据初始场景创建第一行。",
          "rule_delete": "【触发条件】任何时候，如果此表格的行数超过一行，必须删除旧的行，只保留最新、最准确的一行。",
          "rule_update": "【触发条件】当以下任一情况发生时，必须更新此行：\n1. 时间发生显著跳跃（例如，'几小时后'、'第二天'）。\n2. 角色从一个地点移动到另一个地点。\n3. 场景中关键角色的出入导致在场人员发生变化。",
          "charLimitRules": {},
          "rowLimitRule": 1,
          "rows": []
        },
        {
          "name": "角色栏",
          "headers": [
            "角色名",
            "外貌",
            "身形",
            "衣着",
            "性格",
            "身份",
            "职业",
            "与<user>关系",
            "爱好",
            "住所",
            "其他重要信息"
          ],
          "note": "【核心作用】此表格是角色关系和状态的核心数据库，用于记录所有在故事中出现的重要角色的详细信息。\n【字段详解】\n- 角色名: 角色的唯一标识。\n- 外貌: 描述五官、发型、发色、肤色等面部特征。\n- 身形: 描述身高、体型、肌肉状况、特殊身体标记（如伤疤）等。\n- 衣着: 描述角色当前或标志性的穿着，包括服装、配饰等。\n- 性格: 概括角色的核心性格特质，使用1-3个关键词，如'勇敢/鲁莽/忠诚'。\n- 身份: 角色的社会背景或出身，如'贵族后裔'、'流浪者'。\n- 职业: 角色赖以谋生的工作或职责，如'佣兵'、'学者'。\n- 与<user>关系: 描述该角色与主角<user>之间的社会或情感关系，如'盟友'、'导师'、'敌人'。\n- 爱好: 角色的兴趣和消遣活动。\n- 住所: 角色的常住地。\n- 其他重要信息: 记录任何不属于以上类别但对角色至关重要的信息，如特殊能力、过去的经历等。",
          "rule_add": "【触发条件】当一个有名有姓的角色首次出现，并与<user>或当前剧情发生有意义的互动时，必须为其创建新的一行。",
          "rule_delete": "【触发条件】当一个角色被确认永久性死亡（非假死或失踪），且其存在不再对后续剧情有直接影响时，可以删除该行。",
          "rule_update": "【触发条件】当角色的任何信息发生持久性或关键性变化时，必须更新对应单元格。例如：\n1. 外貌/身形/衣着发生永久性改变（如断肢、换上新装备）。\n2. 性格因重大事件而扭转。\n3. 身份或职业发生变更（如继承王位、被解雇）。\n4. 与<user>的关系发生根本性转变（如从敌人变为盟友）。",
          "charLimitRules": {
            "10": 30
          },
          "rowLimitRule": 0,
          "rows": []
        },
        {
            "name": "关系栏",
            "headers": [
              "主动方",
              "被动方",
              "关系",
              "详情"
            ],
            "columnWidths": [],
            "note": "【核心作用】专门用于记录除主角<user>以外的角色之间的复杂人际关系网（NPC to NPC）。\n【字段详解】\n- 主动方: 关系的发起者或主体（例如'艾克'）。\n- 被动方: 关系的接收者或对象（例如'莉娜'）。\n- 关系: 用简短的词汇描述两者之间的关系本质，如'暗恋'、'世仇'、'师徒'。\n- 详情: 对这段关系的具体描述或背景补充。",
            "rule_add": "【触发条件】当两个NPC之间展现出明确的、非临时性的人际关系时，应添加新行。",
            "rule_delete": "【触发条件】当两个NPC之间的关系彻底断绝且不再影响剧情，或者其中一方彻底消失/死亡时，可以删除。",
            "rule_update": "【触发条件】当两个NPC之间的关系性质发生转变（如从'盟友'变为'背叛者'）时，必须更新。",
            "charLimitRules": {},
            "rowLimitRule": 0,
            "rows": [],
            "rowStatuses": []
          },
        {
          "name": "任务栏",
          "headers": [
            "任务名",
            "类型",
            "详情",
            "状态",
            "执行者",
            "地点",
            "开始时间/结束时间",
            "结果"
          ],
          "note": "【核心作用】追踪故事中的主要情节线、目标和挑战。只记录对剧情发展有重大影响的“任务”，忽略日常琐事。\n【字段详解】\n- 任务名: 任务的简洁概括，如'寻找失落的神器'。\n- 类型: 任务的分类，如'主线'、'支线'、'个人'、'约定'。\n- 详情: 对任务目标和背景的简要描述。\n- 状态: 任务的当前进展，如'未开始'、'进行中'、'已完成'、'已失败'、'已取消'。\n- 执行者: 负责完成此任务的角色名。\n- 地点: 任务关键环节发生的地点。\n- 开始时间/结束时间: 记录任务的起止时间，格式'YYYY-MM-DD'，若未结束则结束时间留空。\n- 结果: 任务完成或失败后的最终结果。",
          "rule_add": "【触发条件】当以下情况发生时，应添加新行：\n1. 角色接下一个明确的、有目标的委托或命令。\n2. 角色们达成一个具体的、需要在未来执行的约定。\n3. 角色为自己设定一个长期的、关键性的目标。",
          "rule_delete": "【触发条件】当任务列表超过10行时，优先删除最早的、已经“已完成”且与当前剧情关联度最低的任务。如果存在内容完全重复的任务，应删除。",
          "rule_update": "【触发条件】当任务的“状态”发生任何变化时，必须更新。例如，从'进行中'变为'已完成'。当任务的“详情”或“结果”有新的关键信息补充时，也应更新。",
          "charLimitRules": {},
          "rowLimitRule": 10,
          "rows": []
        },
        {
          "name": "物品栏",
          "headers": [
            "物品名",
            "类型",
            "详情",
            "状态",
            "拥有者",
            "重要原因"
          ],
          "note": "【核心作用】记录那些在故事中具有特殊功能、背景或情感价值的关键物品。普通物品不应记录。\n【字段详解】\n- 物品名: 物品的名称。\n- 类型: 物品的分类，如'武器'、'道具'、'信物'、'关键物品'。\n- 详情: 描述物品的外观、材质和已知功能。\n- 状态: 物品的当前状况，如'完好'、'破损'、'能量耗尽'。\n- 拥有者: 当前持有该物品的角色名。\n- 重要原因: 解释该物品为何重要，例如'是解开谜题的钥匙'或'是母亲的遗物'。",
          "rule_add": "【触发条件】当一个物品被明确赋予了特殊意义（如被赠予、在关键事件中扮演重要角色）或展示出独特功能时，应为其创建条目。",
          "rule_delete": "【触发条件】当一个物品被彻底摧毁、消耗完毕或永久失去其特殊意义时，可以删除。",
          "rule_update": "【触发条件】当物品的“状态”（如被损坏）、“拥有者”（如被转交或被盗）或“详情”（如发现了新功能）发生变化时，必须更新。",
          "charLimitRules": {},
          "rowLimitRule": 0,
          "rows": []
        },
        {
          "name": "技能栏",
          "headers": [
            "技能名",
            "技能效果"
          ],
          "note": "【核心作用】专门用于记录主角<user>掌握的各种技能、魔法、被动能力或特殊专长。\n【字段详解】\n- 技能名: 技能的正式名称。\n- 技能效果: 清晰、简洁地描述该技能使用时产生的具体效果、消耗和限制条件。",
          "rule_add": "【触发条件】当<user>在故事中首次成功施展或习得一个全新的、表格中未记录的技能时，必须添加。",
          "rule_delete": "【触发条件】如果发现表格中存在两个描述完全相同的重复技能，应删除其中一个。如果记录了非<user>的技能，应立即删除。",
          "rule_update": "【触发条件】当一个已知技能的效果发生进化、变异或被添加了新的限制/效果时（例如，技能升级），必须更新其“技能效果”描述。",
          "charLimitRules": {},
          "rowLimitRule": 0,
          "rows": []
        },
        {
          "name": "设定栏",
          "headers": [
            "类型",
            "具体描述"
          ],
          "note": "【核心作用】此表格记录了来自<user>的、超越故事本身的“元指令”或世界观设定，拥有最高解释权。内容应被严格遵守，禁止AI自行修改。\n【字段详解】\n- 类型: 指令的分类，如'世界观设定'、'剧情走向要求'、'角色行为禁令'。\n- 具体描述: 完整、准确地记录<user>提出的具体要求。",
          "rule_add": "【触发条件】当<user>通过括号、旁白或其他明确的“第四面墙”方式，提出关于故事背景、规则或未来走向的指令时，必须记录于此。",
          "rule_delete": "【触发条件】只能在<user>明确表示要移除或废弃某条设定时，才能删除对应行。",
          "rule_update": "【触发条件】只能在<user>明确表示要修改某条设定时，才能更新对应行的描述。",
          "charLimitRules": {},
          "rowLimitRule": 0,
          "rows": []
    }
  ]
};


function getDefaultTables() {
    log('从预设模板生成默认表格...', 'info');
    // 直接深拷贝预设中的表格数组
    const tables = JSON.parse(JSON.stringify(defaultTemplate.tables));
    tables.forEach(table => {
        table.charLimitRule = { columnIndex: -1, limit: 0 };
        table.rowLimitRule = 0;
        table.columnWidths = [];


    });
    return tables;
}

export function loadTables(stopIndex = -1) {
    const context = getContext();
    // 1. 检查聊天记录中是否已有表格数据
    if (context && context.chat && context.chat.length > 0) {
        const startIndex = (stopIndex === -1 ? context.chat.length - 1 : stopIndex - 1);
        for (let i = startIndex; i >= 0; i--) {
            const message = context.chat[i];
            if (message.extra && message.extra[TABLE_DATA_KEY]) {
                log(`在第 ${i} 条消息中找到基准表格数据。`, 'info');
                // 加载状态时，必须完全信任并还原消息中存储的状态，
                // 不应与当前内存状态进行任何合并，否则会导致回退时状态不一致。
                let loadedState = JSON.parse(JSON.stringify(message.extra[TABLE_DATA_KEY]));
                
                loadedState.forEach(table => {
                    if (table.note === undefined) table.note = '无';
                    if (table.rule_add === undefined) table.rule_add = '允许';
                    if (table.rule_delete === undefined) table.rule_delete = '允许';
                    if (table.rule_update === undefined) table.rule_update = '允许';
                    
                    // **【多列规则兼容性改造】**
                    if (table.charLimitRule && !table.charLimitRules) {
                        table.charLimitRules = {};
                        if (table.charLimitRule.columnIndex !== -1 && table.charLimitRule.limit > 0) {
                            table.charLimitRules[table.charLimitRule.columnIndex] = table.charLimitRule.limit;
                        }
                    }
                    // 删除旧字段，确保数据结构统一
                    delete table.charLimitRule;

                    if (table.rowLimitRule === undefined) table.rowLimitRule = 0;
                    if (table.columnWidths === undefined) table.columnWidths = [];
                    
                    // 【延迟删除】如果旧数据没有状态数组，则初始化一个
                    if (!table.rowStatuses) {
                        table.rowStatuses = Array(table.rows.length).fill('normal');
                    }
                });

                currentTablesState = loadedState;
                // 【Amily2-SuperMemory】状态加载后，触发全量同步
                dispatchAllTablesUpdate();
                return currentTablesState;
            }
        }
    }

    // 2. 如果聊天记录中没有数据（新聊天），则尝试加载全局预设
    if (extension_settings[extensionName]?.global_table_preset) {
        log('未在聊天记录中找到表格，正在加载全局预设...', 'info');
        try {
            const globalPreset = extension_settings[extensionName].global_table_preset;
            currentTablesState = JSON.parse(JSON.stringify(globalPreset.tables));
            
            // 【V140.9 Bug修复】当加载全局预设时，也一并加载其中包含的指令模板
            if (globalPreset.batchFillerRuleTemplate !== undefined) {
                saveBatchFillerRuleTemplate(globalPreset.batchFillerRuleTemplate);
            }
            if (globalPreset.batchFillerFlowTemplate !== undefined) {
                saveBatchFillerFlowTemplate(globalPreset.batchFillerFlowTemplate);
            }

            // 【Amily2-SuperMemory】加载全局预设后，触发全量同步
            dispatchAllTablesUpdate();
            return currentTablesState;
        } catch (error) {
            log(`加载全局预设失败: ${error.message}`, 'error');
        }
    }

    // 3. 如果全局预设也不存在或加载失败，则使用默认模板
    log('未找到任何表格数据或全局预设，使用默认模板。', 'info');
    currentTablesState = getDefaultTables();
    // 【Amily2-SuperMemory】加载默认模板后，触发全量同步
    dispatchAllTablesUpdate();
    return currentTablesState;
}

export function saveStateToMessage(stateToSave, targetMessage) {
    if (!stateToSave || !targetMessage) {
        log('缺少状态或目标消息，无法保存。', 'error');
        return false;
    }

    if (!targetMessage.extra) {
        targetMessage.extra = {};
    }

    targetMessage.extra[TABLE_DATA_KEY] = JSON.parse(JSON.stringify(stateToSave));
    log(`表格状态已准备写入消息 [${targetMessage.mes.substring(0, 20)}...]`, 'info');
    return true;
}

export function saveTables(sourceAction = '未知操作') {
    log(`UI操作 "${sourceAction}" 已更新内存状态。`, 'info');
    // 不再直接调用 saveChatDebounced()，交由上层处理
    return true;
}

export function deleteColumn(tableIndex, colIndex) {
    const tables = getMemoryState();
    if (!tables[tableIndex] || colIndex < 0 || colIndex >= tables[tableIndex].headers.length) {
        log(`删除列失败：在表格 ${tableIndex} 中找不到索引为 ${colIndex} 的列。`, 'error');
        return;
    }

    // 删除表头
    tables[tableIndex].headers.splice(colIndex, 1);

    // 删除每一行中对应的单元格
    tables[tableIndex].rows.forEach(row => {
        if (row.length > colIndex) {
            row.splice(colIndex, 1);
        }
    });

    if (tables[tableIndex].columnWidths && tables[tableIndex].columnWidths.length > colIndex) {
        tables[tableIndex].columnWidths.splice(colIndex, 1);
    }

    log(`成功删除了表格 ${tableIndex} 的第 ${colIndex + 1} 列。`, 'success');
    saveTables(tables);
    dispatchTableUpdate(tableIndex);
}

export function moveRow(tableIndex, rowIndex, direction) {
    const tables = getMemoryState();
    const table = tables[tableIndex];
    if (!table || rowIndex < 0 || rowIndex >= table.rows.length) return;

    const newIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
    if (newIndex < 0 || newIndex >= table.rows.length) return;

    const [movedRow] = table.rows.splice(rowIndex, 1);
    table.rows.splice(newIndex, 0, movedRow);

    // 【延迟删除】同步移动状态
    if (table.rowStatuses && table.rowStatuses.length === table.rows.length + 1) {
        const [movedStatus] = table.rowStatuses.splice(rowIndex, 1);
        table.rowStatuses.splice(newIndex, 0, movedStatus);
    }

    log(`成功将表格 ${tableIndex} 的第 ${rowIndex + 1} 行移动到第 ${newIndex + 1} 行。`, 'success');
    saveTables(tables);
    dispatchTableUpdate(tableIndex);
}

export function insertRow(tableIndex, data, position = 'below') {
    const tables = getMemoryState();
    const table = tables[tableIndex];
    if (!table) {
        log(`插入行失败：找不到索引为 ${tableIndex} 的表格。`, 'error');
        return;
    }

    // 将 insertIndex 的计算提前，解决“暂时性死区”问题
    let insertIndex;
    if (typeof data === 'number') {
        insertIndex = position === 'above' ? data : data + 1;
    } else {
        insertIndex = table.rows.length; // 默认在末尾插入
    }
    // 确保索引在有效范围内
    if (insertIndex < 0) insertIndex = 0;
    if (insertIndex > table.rows.length) insertIndex = table.rows.length;

    const newRow = new Array(table.headers.length).fill('');
    
    // 如果 data 是一个对象，则用它来填充新行
    if (typeof data === 'object' && data !== null) {
        for (const colIndex in data) {
            const cIndex = parseInt(colIndex, 10);
            if (!isNaN(cIndex) && cIndex < newRow.length) {
                newRow[cIndex] = data[colIndex];
                // 现在 insertIndex 已经有值了
                addHighlight(tableIndex, insertIndex, cIndex);
            }
        }
    }

    table.rows.splice(insertIndex, 0, newRow);
    // 【延迟删除】同步更新状态数组
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.splice(insertIndex, 0, 'normal');

    updatedTables.add(tableIndex); // 【V15.2 新增】标记表格为已更新
    dispatchTableUpdate(tableIndex);
    log(`成功在表格 ${table.name} (索引 ${tableIndex}) 的第 ${insertIndex + 1} 行位置插入了新行。`, 'success');
    
    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(tables, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}


export function addRow(tableIndex) {
    if (!currentTablesState || !currentTablesState[tableIndex]) return;
    const table = currentTablesState[tableIndex];
    const colCount = table.headers.length;
    const newRow = Array(colCount).fill('');
    table.rows.push(newRow);
    // 【延迟删除】同步更新状态数组
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.push('normal');
    updatedTables.add(tableIndex); // 【V15.2 新增】标记表格为已更新
    dispatchTableUpdate(tableIndex);
    const logMessage = `表格 [${table.name}] 新增了一行。`;
    log(logMessage, 'info');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function addColumn(tableIndex) {
    if (!currentTablesState || !currentTablesState[tableIndex]) return;
    const table = currentTablesState[tableIndex];
    const newHeader = `新列 ${table.headers.length + 1}`;
    table.headers.push(newHeader);
    table.rows.forEach(row => row.push(''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.push(null);
    const logMessage = `表格 [${table.name}] 新增了一列。`;
    log(logMessage, 'info');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function updateHeader(tableIndex, colIndex, value) {
    if (!currentTablesState || !currentTablesState[tableIndex] || currentTablesState[tableIndex].headers[colIndex] === undefined) {
        return;
    }
    const tableName = currentTablesState[tableIndex].name;
    const originalHeader = currentTablesState[tableIndex].headers[colIndex];
    currentTablesState[tableIndex].headers[colIndex] = value;
    const logMessage = `表格 [${tableName}] 的表头“${originalHeader}”已更新为“${value}”。`;
    log(logMessage, 'info');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export async function deleteRow(tableIndex, rowIndex) {
    const table = currentTablesState?.[tableIndex];
    if (!table || !table.rows[rowIndex]) return;

    // 兼容性检查
    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length).fill('normal');
    }

    table.rowStatuses[rowIndex] = 'pending-deletion';
    updatedTables.add(tableIndex); // 【V15.2 新增】标记表格为已更新
    const logMessage = `表格 [${table.name}] 的第 ${rowIndex + 1} 行已标记为待删除。`;
    log(logMessage, 'info');

    // 立即保存状态并触发UI重绘
    const context = getContext();
    if (context.chat?.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            await saveChat();
            renderTables(); // 重新渲染以显示更改
            
            // 【SuperMemory 联动】触发更新事件
            dispatchTableUpdate(tableIndex);
            
            return;
        }
    }
    await saveChatDebounced();
    renderTables();
    // 【SuperMemory 联动】触发更新事件
    dispatchTableUpdate(tableIndex);
}

export async function restoreRow(tableIndex, rowIndex) {
    const table = currentTablesState?.[tableIndex];
    if (!table || !table.rows[rowIndex] || !table.rowStatuses) return;

    table.rowStatuses[rowIndex] = 'normal';
    updatedTables.add(tableIndex); // 【V15.2 新增】标记表格为已更新
    const logMessage = `表格 [${table.name}] 的第 ${rowIndex + 1} 行已恢复。`;
    log(logMessage, 'info');

    const context = getContext();
    if (context.chat?.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            await saveChat();
            renderTables(); // 重新渲染以显示更改
            // 【SuperMemory 联动】触发更新事件 (修复恢复行后世界书不更新的 Bug)
            dispatchTableUpdate(tableIndex);
            return;
        }
    }
    await saveChatDebounced();
    renderTables();
    // 【SuperMemory 联动】触发更新事件
    dispatchTableUpdate(tableIndex);
}

export function commitPendingDeletions() {
    if (!currentTablesState) return false;
    let deletionCount = 0;

    currentTablesState.forEach((table, tableIndex) => {
        if (!table.rowStatuses || table.rowStatuses.length === 0) return;
        let tableHadDeletions = false;
        // 必须从后向前遍历，以避免在 splice 期间破坏索引
        for (let i = table.rows.length - 1; i >= 0; i--) {
            if (table.rowStatuses[i] === 'pending-deletion') {
                table.rows.splice(i, 1);
                table.rowStatuses.splice(i, 1);
                deletionCount++;
                tableHadDeletions = true;
            }
        }
        if (tableHadDeletions) {
            updatedTables.add(tableIndex); // 【V15.2 新增】标记表格为已更新
        }
    });

    if (deletionCount > 0) {
        log(`已提交并永久删除了 ${deletionCount} 行。`, 'info');
        
        // 【SuperMemory 联动】为所有受影响的表格触发更新事件
        if (updatedTables.size > 0) {
            updatedTables.forEach(tableIndex => {
                dispatchTableUpdate(tableIndex);
            });
        }
        
        return true; // 表示状态已更改，需要保存
    }
    return false; // 表示没有更改
}


export function insertColumn(tableIndex, colIndex, position) {
    if (!currentTablesState || !currentTablesState[tableIndex]) return;
    const table = currentTablesState[tableIndex];
    
    const insertAt = position === 'left' ? colIndex : colIndex + 1;
    const newHeader = `新列`;

    // 插入表头
    table.headers.splice(insertAt, 0, newHeader);
    // 在每一行中插入空单元格
    table.rows.forEach(row => row.splice(insertAt, 0, ''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.splice(insertAt, 0, null);

    const logMessage = `表格 [${table.name}] 在第 ${colIndex + 1} 列的${position === 'left' ? '左侧' : '右侧'}插入了新列。`;
    log(logMessage, 'info');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function moveColumn(tableIndex, colIndex, direction) {
    if (!currentTablesState || !currentTablesState[tableIndex]) return;
    const table = currentTablesState[tableIndex];
    const headers = table.headers;
    const rows = table.rows;

    const targetIndex = direction === 'left' ? colIndex - 1 : colIndex + 1;

    // 边界检查
    if (targetIndex < 0 || targetIndex >= headers.length) {
        log(`无法移动列：索引 ${colIndex} 已在边界。`, 'warn');
        return;
    }

    // 移动表头
    const [headerToMove] = headers.splice(colIndex, 1);
    headers.splice(targetIndex, 0, headerToMove);

    // 移动每一行中的单元格
    rows.forEach(row => {
        const [cellToMove] = row.splice(colIndex, 1);
        row.splice(targetIndex, 0, cellToMove);
    });

    if (table.columnWidths && table.columnWidths.length > colIndex) {
        const [widthToMove] = table.columnWidths.splice(colIndex, 1);
        table.columnWidths.splice(targetIndex, 0, widthToMove);
    }

    const logMessage = `表格 [${table.name}] 的列“${headerToMove}”已向${direction === 'left' ? '左' : '右'}移动。`;
    log(logMessage, 'info');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function deleteTable(tableIndex) {
    if (!currentTablesState || !currentTablesState[tableIndex]) {
        return;
    }
    const tableName = currentTablesState[tableIndex].name;
    currentTablesState.splice(tableIndex, 1);
    const logMessage = `表格 [${tableName}] 已被成功废黜。`;
    log(logMessage, 'success');
    // toastr.success(logMessage, '敕令已达'); // 【V28.0】根据指示，移除弹窗

    // 与 addTable 保持一致，强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat(); // 直接调用，不防抖
            log('废黜表格后的状态已强制写入最新消息并立即保存。', 'success');
            return;
        }
    }

    log('无法找到可锚定的消息或保存失败，删除操作可能不会被持久化！', 'error');
    saveChatDebounced(); // Fallback
}

export function addTable(tableName) {
    if (!tableName || !tableName.trim()) {
        log('无法创建表格：名称不能为空。', 'error');
        toastr.error('表格名称不能为空。', '创建失败');
        return;
    }
    if (!currentTablesState) {
        loadTables(); // 确保状态已加载
    }

    // 检查重名
    if (currentTablesState.some(table => table.name === tableName.trim())) {
        log(`无法创建表格：名为 "${tableName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${tableName}" 的表格已存在。`, '创建失败');
        return;
    }

    const newTable = {
        name: tableName.trim(),
        headers: ['新列 1'], // 默认带有一列
        rows: [],
        rowStatuses: [], // 【延迟删除】
        columnWidths: [],
        note: '这是一个新创建的表格。',
        rule_add: '允许',
        rule_delete: '允许',
        rule_update: '允许',
        charLimitRules: {}, // **【核心修正】** 初始化为新的多列规则空对象
        rowLimitRule: 0
    };

    currentTablesState.push(newTable);
    const logMessage = `已成功创建新表格：[${tableName.trim()}]。`;
    log(logMessage, 'success');
    // toastr.success(logMessage, '敕令已达'); // 【V28.0】根据指示，移除弹窗

    // 【V19.0 最终统一修正】回归有效的即时保存逻辑
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat(); // 直接调用，不防抖
            log('新表格状态已强制写入最新消息并立即保存。', 'success');
            return;
        }
    }
    
    log('无法找到可锚定的消息或保存失败，新表格可能不会被持久化！', 'error');
    saveChatDebounced(); // Fallback
}

export function renameTable(tableIndex, newName) {
    if (!currentTablesState || !currentTablesState[tableIndex]) {
        log('重命名失败：表格不存在。', 'error');
        toastr.error('表格不存在。', '重命名失败');
        return;
    }
    const trimmedName = newName.trim();
    if (!trimmedName) {
        log('重命名失败：名称不能为空。', 'error');
        toastr.error('表格名称不能为空。', '重命名失败');
        return;
    }
    // 检查重名（排除自身）
    if (currentTablesState.some((table, index) => index !== tableIndex && table.name === trimmedName)) {
        log(`重命名失败：名为 "${trimmedName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${trimmedName}" 的表格已存在。`, '重命名失败');
        return;
    }

    const oldName = currentTablesState[tableIndex].name;
    currentTablesState[tableIndex].name = trimmedName;
    log(`表格 "${oldName}" 已重命名为 "${trimmedName}"。`, 'success');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function moveTable(tableIndex, direction) {
    if (!currentTablesState || !currentTablesState[tableIndex]) {
        return;
    }

    const newIndex = direction === 'up' ? tableIndex - 1 : tableIndex + 1;

    // 边界检查
    if (newIndex < 0 || newIndex >= currentTablesState.length) {
        log(`无法移动表格：索引 ${tableIndex} 已在边界。`, 'warn');
        return;
    }

    // 交换元素
    const temp = currentTablesState[tableIndex];
    currentTablesState[tableIndex] = currentTablesState[newIndex];
    currentTablesState[newIndex] = temp;

    const logMessage = `表格 [${temp.name}] 的顺序已调整。`;
    log(logMessage, 'success');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            log('表格顺序调整后的状态已强制写入最新消息并立即保存。', 'success');
            return;
        }
    }

    log('无法找到可锚定的消息或保存失败，顺序调整可能不会被持久化！', 'error');
    saveChatDebounced(); // Fallback
}


export function updateTableRules(tableIndex, newRules) {
    if (!currentTablesState || !currentTablesState[tableIndex]) {
        return;
    }
    const table = currentTablesState[tableIndex];
    table.note = newRules.note;
    table.rule_add = newRules.rule_add;
    table.rule_delete = newRules.rule_delete;
    table.rule_update = newRules.rule_update;
    table.charLimitRules = newRules.charLimitRules; // 使用新的多列规则对象
    table.rowLimitRule = newRules.rowLimitRule;
    table.simplifyRowThreshold = newRules.simplifyRowThreshold; // 【V146.0】保存历史内容简化阈值
    
    // 删除旧的单列规则字段，保持数据清洁
    delete table.charLimitRule;

    const logMessage = `表格 [${table.name}] 的规则已更新。`;
    log(logMessage, 'info');

    // 强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function updateRow(tableIndex, rowIndex, data) {
    if (!currentTablesState || !currentTablesState[tableIndex]) {
        log(`AI指令错误：尝试在不存在的表格索引 ${tableIndex} 中操作。`, 'error');
        return;
    }
    const table = currentTablesState[tableIndex];

    // 如果行不存在，则视为在末尾新增一行
    if (rowIndex >= table.rows.length) {
        log(`AI指令意图更新不存在的行 (rowIndex: ${rowIndex})，已智能转换为在表格 [${table.name}] 末尾新增一行。`, 'warn');
        insertRow(tableIndex, data); // 直接调用 insertRow，它现在有正确的保存逻辑
        return;
    }

    // 如果行存在，则正常更新
    const row = table.rows[rowIndex];
    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < row.length) {
            row[cIndex] = data[cIndex];
            // 【V134.0 新增】为被更新的单元格添加高亮
            addHighlight(tableIndex, rowIndex, cIndex);
        }
    }
    
    updatedTables.add(tableIndex); // 【V15.2 新增】标记表格为已更新
    dispatchTableUpdate(tableIndex);
    const logMessage = `AI 指令更新了表格 [${table.name}] 的第 ${rowIndex + 1} 行。`;
    log(logMessage, 'info');

    // 统一为强制立即保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced(); // Fallback
}

export function clearAllTables() {
    if (!currentTablesState) {
        log('无法清空：当前表格状态为空。', 'error');
        return;
    }

    // 1. 只清空每个表格的 rows 和 rowStatuses 数组
    currentTablesState.forEach((table, tableIndex) => {
        if (table.rows.length > 0) {
            updatedTables.add(tableIndex); // 【V15.2 新增】如果表格原本有数据，则标记为已更新
        }
        table.rows = [];
        table.rowStatuses = [];
    });
    log('所有表格的行数据已在内存中清空。', 'warn');

    // 【Amily2-SuperMemory】清空后触发全量同步
    dispatchAllTablesUpdate();

    // 2. 强制保存更新后的状态
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            log('清空行数据后的状态已强制写入最新消息并立即保存。', 'success');
            toastr.success('所有表格的剧情内容已清空。', '操作完成');
            return;
        }
    }

    // Fallback
    log('无法找到可锚定的消息或保存失败，清空操作可能不会被持久化！', 'error');
    saveChatDebounced();
}


function checkTableRules(table) {
    let warnings = [];

    // 1. 检查行数限制 (逻辑不变)
    if (table.rowLimitRule && table.rowLimitRule > 0 && table.rows.length > table.rowLimitRule) {
        warnings.push(`【当前（${table.name}）超出规定（${table.rowLimitRule}）行，请结合剧情缩减至（${table.rowLimitRule}）行以下，但切莫完全删除。】`);
    }

    // 2. **【核心改造】** 检查多列字符限制
    const charLimitRules = table.charLimitRules || {};
    // 遍历所有设置了规则的列
    for (const colIndexStr in charLimitRules) {
        const colIndex = parseInt(colIndexStr, 10);
        const limit = charLimitRules[colIndex];

        if (limit > 0 && colIndex >= 0 && colIndex < table.headers.length) {
            const colName = table.headers[colIndex];
            const offendingRows = []; // 收集违规的行号

            table.rows.forEach((row, rowIndex) => {
                // 【延迟删除】跳过待删除的行
                if (table.rowStatuses && table.rowStatuses[rowIndex] === 'pending-deletion') {
                    return;
                }
                const cellContent = row[colIndex] || '';
                if (cellContent.length > limit) {
                    // 【V140.5 细节修正】根据用户反馈，行号应从0开始，与AI视角下的rowIndex保持一致
                    offendingRows.push(rowIndex); 
                }
            });

            // 如果有违规的行，则生成聚合后的警告信息
            if (offendingRows.length > 0) {
                const rowNumbers = offendingRows.join('、');
                warnings.push(`【当前（${table.name}）第（${rowNumbers}）行（${colName}）列，字符超出规定（${limit}）字限制，请进行缩减。】`);
            }
        }
    }

    return warnings.join('\n');
}

export function convertTablesToCsvString() {
    if (!currentTablesState) {
        loadTables();
    }
    if (!currentTablesState) {
        return '';
    }

    let fullString = '';
    currentTablesState.forEach((table, tableIndex) => {
        // 1. 表格标题
        fullString += `\n* ${tableIndex}:${table.name}\n`;

        // 2. 说明
        fullString += `【说明】:\n${table.note || '无'}\n`;

        // 3. 表格内容 (Markdown 格式)
        const tagName = table.name.replace(/\s/g, '') + '内容';
        fullString += `<${tagName}>\n`;
        const headerWithIndex = ['rowIndex', ...table.headers.map((h, i) => `${i}:${h}`)];
        fullString += `| ${headerWithIndex.join(' | ')} |\n`;
        fullString += `|${headerWithIndex.map(() => '---').join('|')}|\n`;

        const activeRows = table.rows.filter((row, i) => !table.rowStatuses || table.rowStatuses[i] !== 'pending-deletion');

        if (activeRows.length === 0) {
            fullString += '（该表当前内容为空）\n';
        } else {
            const simplifyThreshold = table.simplifyRowThreshold || 0;
            let simplifiedCount = 0;

            table.rows.forEach((row, rowIndex) => {
                // 【延迟删除】注入时，跳过待删除的行
                if (table.rowStatuses && table.rowStatuses[rowIndex] === 'pending-deletion') {
                    return;
                }

                // 【V146.0】历史内容简化逻辑
                if (simplifyThreshold > 0 && rowIndex < simplifyThreshold) {
                    // 仅在第一行简化时输出一次提示行，避免刷屏
                    if (simplifiedCount === 0) {
                         // 计算被简化的列数，生成占位符
                        const placeholderCells = row.map(() => '---已锁定---');
                        fullString += `| ${rowIndex} | ${placeholderCells.join(' | ')} |\n`;
                        fullString += `| ... | ${row.map(() => '...').join(' | ')} |\n`;
                    }
                    // 如果是最后一行被简化的行
                    if (rowIndex === simplifyThreshold - 1) {
                         const placeholderCells = row.map(() => '---已锁定---');
                         fullString += `| ${rowIndex} | ${placeholderCells.join(' | ')} |\n`;
                    }
                    simplifiedCount++;
                    return; // 跳过具体内容的输出
                }

                if (Array.isArray(row)) {
                    const rowCells = row.map(cell => {
                        const cellContent = (cell === null || cell === undefined || cell === '') ? '未知' : String(cell);
                        // 替换管道符以避免破坏Markdown表格结构
                        return cellContent.replace(/\|/g, '｜');
                    });
                    fullString += `| ${rowIndex} | ${rowCells.join(' | ')} |\n`;
                }
            });

            if (simplifiedCount > 0) {
                fullString += `\n【系统提示】：表格前 ${simplifiedCount} 行（索引 0 到 ${simplifiedCount - 1}）的历史内容已简化并锁定，无需读取或修改。请专注于后续行的内容。\n`;
            }
        }

        // 【V140.4 最终逻辑修正】根据用户最终指示，警告信息始终在主流程提示词（{{{Amily2TableData}}}）中注入
        const warnings = checkTableRules(table);
        if (warnings) {
            fullString += `${warnings}\n`;
        }
        fullString += `</${tagName}>\n`;

        // 4. 规则
        fullString += `【增加】: ${table.rule_add || '允许'}\n`;
        fullString += `【删除】: ${table.rule_delete || '允许'}\n`;
        fullString += `【修改】: ${table.rule_update || '允许'}\n`;

        // 5. 分隔符
        if (tableIndex < currentTablesState.length - 1) {
            fullString += '\n---\n';
        }
    });

    return fullString;
}

export function convertSelectedTablesToCsvString(selectedIndices) {
    if (!currentTablesState) {
        loadTables();
    }
    if (!currentTablesState) {
        return '';
    }

    let fullString = '';
    
    currentTablesState.forEach((table, tableIndex) => {
        const isSelected = selectedIndices.includes(tableIndex);

        // 1. 表格标题
        fullString += `\n* ${tableIndex}:${table.name}`;
        if (!isSelected) {
            fullString += ' (本表格无需重新整理，仅供参考)';
        }
        fullString += '\n';

        // 2. 说明
        fullString += `【说明】:\n${table.note || '无'}\n`;

        // 3. 表格内容 (Markdown 格式)
        const tagName = table.name.replace(/\s/g, '') + '内容';
        fullString += `<${tagName}>\n`;
        const headerWithIndex = ['rowIndex', ...table.headers.map((h, i) => `${i}:${h}`)];
        fullString += `| ${headerWithIndex.join(' | ')} |\n`;
        fullString += `|${headerWithIndex.map(() => '---').join('|')}|\n`;

        if (isSelected) {
            // 如果是选中的表格，包含完整内容
            const activeRows = table.rows.filter((row, i) => !table.rowStatuses || table.rowStatuses[i] !== 'pending-deletion');

            if (activeRows.length === 0) {
                fullString += '（该表当前内容为空）\n';
            } else {
                const simplifyThreshold = table.simplifyRowThreshold || 0;
                let simplifiedCount = 0;

                table.rows.forEach((row, rowIndex) => {
                    // 【延迟删除】注入时，跳过待删除的行
                    if (table.rowStatuses && table.rowStatuses[rowIndex] === 'pending-deletion') {
                        return;
                    }

                    // 【V146.0】历史内容简化逻辑
                    if (simplifyThreshold > 0 && rowIndex < simplifyThreshold) {
                        if (simplifiedCount === 0) {
                            const placeholderCells = row.map(() => '---已锁定---');
                            fullString += `| ${rowIndex} | ${placeholderCells.join(' | ')} |\n`;
                            fullString += `| ... | ${row.map(() => '...').join(' | ')} |\n`;
                        }
                        if (rowIndex === simplifyThreshold - 1) {
                             const placeholderCells = row.map(() => '---已锁定---');
                             fullString += `| ${rowIndex} | ${placeholderCells.join(' | ')} |\n`;
                        }
                        simplifiedCount++;
                        return;
                    }

                    if (Array.isArray(row)) {
                        const rowCells = row.map(cell => {
                            const cellContent = (cell === null || cell === undefined || cell === '') ? '未知' : String(cell);
                            // 替换管道符以避免破坏Markdown表格结构
                            return cellContent.replace(/\|/g, '｜');
                        });
                        fullString += `| ${rowIndex} | ${rowCells.join(' | ')} |\n`;
                    }
                });

                if (simplifiedCount > 0) {
                    fullString += `\n【系统提示】：表格前 ${simplifiedCount} 行（索引 0 到 ${simplifiedCount - 1}）的历史内容已简化并锁定，无需读取或修改。请专注于后续行的内容。\n`;
                }
            }

            // 警告信息
            const warnings = checkTableRules(table);
            if (warnings) {
                fullString += `${warnings}\n`;
            }
        } else {
            // 如果未选中，仅展示表头作为结构参考，不包含行数据
            fullString += '（此处省略未选中的表格内容，仅提供表头供索引参考）\n';
        }
        fullString += `</${tagName}>\n`;

        // 4. 规则
        if (isSelected) {
            fullString += `【增加】: ${table.rule_add || '允许'}\n`;
            fullString += `【删除】: ${table.rule_delete || '允许'}\n`;
            fullString += `【修改】: ${table.rule_update || '允许'}\n`;
        } else {
            fullString += `【操作权限】: 禁止修改此表格\n`;
        }

        // 5. 分隔符
        if (tableIndex < currentTablesState.length - 1) {
            fullString += '\n---\n';
        }
    });

    return fullString;
}

export function convertTablesToCsvStringForContentOnly() {
    const tables = getMemoryState();
    if (!tables || tables.length === 0) {
        return '';
    }

    let outputString = '';
    tables.forEach(table => {
        outputString += `\n<${table.name}>\n`;

        // 1. 生成Markdown表头
        const headerLine = `| ${table.headers.join(' | ')} |`;
        outputString += headerLine + '\n';

        // 2. 生成Markdown分隔符
        const separatorLine = `|${table.headers.map(() => '---').join('|')}|`;
        outputString += separatorLine + '\n';

        // 3. 生成数据行
        const activeRows = table.rows.filter((row, i) => !table.rowStatuses || table.rowStatuses[i] !== 'pending-deletion');

        if (activeRows.length > 0) {
            activeRows.forEach(row => {
                if (Array.isArray(row)) {
                    // 为保持表格结构，将空单元格替换为空格
                    const rowContent = row.map(cell => (cell === null || cell === undefined || cell === '') ? ' ' : cell.toString());
                    const rowLine = `| ${rowContent.join(' | ')} |`;
                    outputString += rowLine + '\n';
                }
            });
        } else {
            outputString += '（该表当前内容为空）\n';
        }

        outputString += `</${table.name}>\n`;
    });

    return outputString.trim();
}

// 初始化时加载一次数据
loadTables();

export function getBatchFillerRuleTemplate() {
    return extension_settings[extensionName]?.batch_filler_rule_template ?? DEFAULT_AI_RULE_TEMPLATE;
}

export function saveBatchFillerRuleTemplate(template) {
    extension_settings[extensionName].batch_filler_rule_template = template;
    saveSettingsDebounced();
}

export function getBatchFillerFlowTemplate() {
    return extension_settings[extensionName]?.batch_filler_flow_template ?? DEFAULT_AI_FLOW_TEMPLATE;
}

export function saveBatchFillerFlowTemplate(template) {
    extension_settings[extensionName].batch_filler_flow_template = template;
    saveSettingsDebounced();
}

export function getAiFlowTemplateForInjection() {
    return extension_settings[extensionName]?.amily2_ai_template ?? DEFAULT_AI_FLOW_TEMPLATE;
}

export async function updateTableFromText(textContent, options = {}) {
    const settings = extension_settings[extensionName] || {};
    if (settings.table_system_enabled === false) {
        log('表格系统总开关已关闭，跳过 <Amily2Edit> 标签处理。', 'info');
        return;
    }

    if (!textContent) {
        log('AI返回内容为空，无法更新表格。', 'warn');
        return;
    }

    // 使用 executor.js 进行推演
    const { finalState, hasChanges, changes } = executeCommands(textContent, currentTablesState);

    if (!hasChanges) {
        log('AI指令未产生任何实质性变更。', 'info');
        return;
    }

    // 更新内存状态
    setMemoryState(finalState);

    // 如果指定了立即删除（如批量填表时），则立即提交待删除行
    if (options.immediateDelete) {
        commitPendingDeletions();
    }
    
    // 标记已更新的表格并处理高亮
    changes.forEach(change => {
        updatedTables.add(change.tableIndex);
        if (change.type === 'update' || change.type === 'insert') {
             if (change.rowIndex !== undefined && change.colIndex !== undefined) {
                 addHighlight(change.tableIndex, change.rowIndex, change.colIndex);
             }
        }
    });

    log(`成功执行了 ${changes.length} 处变更。`, 'success');

    // 触发更新事件 (去重)
    const affectedTables = [...new Set(changes.map(c => c.tableIndex))];
    affectedTables.forEach(tableIndex => {
        dispatchTableUpdate(tableIndex);
    });

    // 一次性保存
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            await saveChat(); // 使用 await 确保保存完成
            toastr.success('已根据AI的指示成功更新表格！', '填表完成');
            // 触发 UI 刷新
            document.dispatchEvent(new CustomEvent('amily2-force-ui-reload'));
            return;
        }
    }
    
    saveChatDebounced();
    toastr.success('已根据AI的指示成功更新表格！', '填表完成');
    document.dispatchEvent(new CustomEvent('amily2-force-ui-reload'));
}

export function saveAiTemplate(template) {
    extension_settings[extensionName].amily2_ai_template = template;
    saveSettingsDebounced();
}

export function getAiTemplate() {
    return getAiFlowTemplateForInjection();
}

function exportPresetBase(includeData = false) {
    if (!currentTablesState) {
        log('无法导出：当前表格状态为空。', 'error');
        toastr.error('没有可导出的表格数据。');
        return;
    }

    let tablesToExport;
    let version;
    let fileNameSuffix;

    if (includeData) {
        // 完整备份
        tablesToExport = JSON.parse(JSON.stringify(currentTablesState));
        version = "Amily2-Table-Preset-v2.0-full";
        fileNameSuffix = "完整备份";
    } else {
        // 纯净预设
        tablesToExport = currentTablesState.map(table => ({
            name: table.name,
            headers: table.headers,
            columnWidths: table.columnWidths || [],
            note: table.note,
            rule_add: table.rule_add,
            rule_delete: table.rule_delete,
            rule_update: table.rule_update,
            charLimitRules: table.charLimitRules || {}, // 【V140.6 修正】导出新的多列规则
            rowLimitRule: table.rowLimitRule || 0,   // 【V140.6 修正】导出新行数规则
            // simplifyRowThreshold: 不导出此字段，因为它是针对当前聊天进度的临时设置
            rows: [], // 确保纯净版有空的rows数组
            rowStatuses: [], // 【延迟删除】纯净预设也应为空
        }));
        version = "Amily2-Table-Preset-v2.0-clean";
        fileNameSuffix = "纯净预设";
    }

    const preset = {
        version: "Amily2-Table-Preset-v3.0-separated_templates", // 新版本号
        batchFillerRuleTemplate: getBatchFillerRuleTemplate(),
        batchFillerFlowTemplate: getBatchFillerFlowTemplate(),
        tables: tablesToExport,
    };

    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amily2-${fileNameSuffix}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log(`【${fileNameSuffix}】已成功导出。`, 'success');
    toastr.success(`【${fileNameSuffix}】已开始下载。`, '导出成功');
}

export function exportPreset() {
    exportPresetBase(false);
}

export function exportPresetFull() {
    exportPresetBase(true);
}

export function importPreset(onImported) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = event => {
            try {
                const preset = JSON.parse(event.target.result);

                // 数据校验
                if (!preset.version || !Array.isArray(preset.tables)) {
                    throw new Error('文件格式无效或缺少版本号/表格数据。');
                }

                // 【V27.0 新增】导入前增加二次确认
                const confirmation = window.confirm(
                    "【警告】\n\n导入操作将完全覆盖您当前的AI指令模板和所有表格（包括结构和内容）。\n\n此操作不可逆，是否确定要继续？"
                );

                if (!confirmation) {
                    log('用户取消了导入操作。', 'info');
                    toastr.info('导入操作已取消。');
                    return;
                }


                // 1. 更新 AI 模板
                if (preset.version === "Amily2-Table-Preset-v3.0-separated_templates") {
                    saveBatchFillerRuleTemplate(preset.batchFillerRuleTemplate || '');
                    saveBatchFillerFlowTemplate(preset.batchFillerFlowTemplate || '');
                    saveAiTemplate(preset.injectionFlowTemplate || ''); // 保存注入模板
                } else if (preset.aiRuleTemplate !== undefined && preset.aiFlowTemplate !== undefined) { // 兼容 v2.1
                    saveBatchFillerRuleTemplate(preset.aiRuleTemplate || '');
                    saveBatchFillerFlowTemplate(preset.aiFlowTemplate || '');
                    saveAiTemplate(preset.aiFlowTemplate || ''); // 旧版中，注入和流程模板是同一个
                } else if (preset.aiTemplate) { // 兼容 v2.0
                    saveBatchFillerRuleTemplate(''); // 旧版没有规则模板，置空
                    saveBatchFillerFlowTemplate(preset.aiTemplate || '');
                    saveAiTemplate(preset.aiTemplate || '');
                } else {
                    // 如果所有模板字段都不存在，为了向前兼容，不做强制要求，只记录一个警告
                    log('导入的预设中缺少指令模板字段，模板将不会被更新。', 'warn');
                }

                // 2. 直接使用导入的数据完全覆盖当前状态
                const importedTables = preset.tables;
                
                // 【V140.6 修正】数据结构校验和兼容性处理
                importedTables.forEach(table => {
                    if (table.name === undefined || table.headers === undefined || table.rows === undefined) {
                        throw new Error(`导入的表格数据格式不正确: ${JSON.stringify(table)}`);
                    }
                    // 为旧版或不规范的预设补充基础规则字段
                    if (table.note === undefined) table.note = '无';
                    if (table.rule_add === undefined) table.rule_add = '允许';
                    if (table.rule_delete === undefined) table.rule_delete = '允许';
                    if (table.rule_update === undefined) table.rule_update = '允许';

                    // **【多列规则兼容性改造】**
                    // 检查是否存在旧的单列规则，并且不存在新的多列规则
                    if (table.charLimitRule && !table.charLimitRules) {
                        table.charLimitRules = {};
                        // 如果旧规则有效，则转换它
                        if (table.charLimitRule.columnIndex !== -1 && table.charLimitRule.limit > 0) {
                            table.charLimitRules[table.charLimitRule.columnIndex] = table.charLimitRule.limit;
                        }
                    }
                    // 如果连新的多列规则字段都没有，则初始化为空对象
                    else if (table.charLimitRules === undefined) {
                        table.charLimitRules = {};
                    }
                    
                    // 删除旧字段，确保数据结构统一
                    delete table.charLimitRule;

                    // 【延迟删除】兼容性处理
                    if (!table.rowStatuses) {
                        table.rowStatuses = Array(table.rows.length).fill('normal');
                    }

                    // 确保行数限制规则存在，否则设为0
                    if (table.rowLimitRule === undefined) {
                        table.rowLimitRule = 0;
                    }
                    if (table.columnWidths === undefined) {
                        table.columnWidths = [];
                    }
                });

                // 更新内存状态
                setMemoryState(importedTables);
                
                // 【Amily2-SuperMemory】导入后触发全量同步
                dispatchAllTablesUpdate();

                // 3. 强制保存
                const context = getContext();
                if (context.chat && context.chat.length > 0) {
                    const lastMessage = context.chat[context.chat.length - 1];
                    if (saveStateToMessage(getMemoryState(), lastMessage)) {
                        saveChat();
                        log('导入的预设已强制写入最新消息并立即保存。', 'success');
                    }
                } else {
                    saveChatDebounced(); // Fallback
                }

                log('预设已成功导入并应用。', 'success');
                toastr.success('预设已成功导入！', '导入成功');

                // 4. 执行回调，刷新UI
                if (typeof onImported === 'function') {
                    onImported();
                }

            } catch (error) {
                log(`导入预设失败: ${error.message}`, 'error');
                toastr.error(`导入失败：${error.message}`, '错误');
            }
        };
        reader.readAsText(file);
    };

    input.click();
}

export async function rollbackState() {
    const context = getContext();
    if (!context || !context.chat || context.chat.length < 2) {
        log('无法回退：聊天记录不足。', 'warn');
        toastr.warning('聊天记录不足，无法执行回退操作。');
        return false;
    }

    const chat = context.chat;
    const lastMessageIndex = chat.length - 1;
    const lastMessage = chat[lastMessageIndex];

    // 1. 加载倒数第二条消息的状态
    log(`正在尝试从第 ${lastMessageIndex - 1} 条消息加载表格状态...`, 'info');
    const previousState = loadTables(lastMessageIndex);

    if (!previousState) {
        log('未能在上一楼找到可用的表格状态，无法回退。', 'error');
        toastr.error('未能在上一楼找到可用的表格状态。');
        return false;
    }

    // 2. 将加载的状态设置为当前内存状态并立即持久化
    setMemoryState(previousState);
    if (saveStateToMessage(previousState, lastMessage)) {
        await saveChat();
        log('已成功将回退后的状态保存至最新消息。', 'success');
    } else {
        log('回退状态保存失败，操作中止。', 'error');
        toastr.error('未能保存回退状态，操作中止。');
        return false;
    }

    // 3. 重新渲染UI以显示回退后的状态
    renderTables();
    updateOrInsertTableInChat();
    log('UI已更新以显示回退后的状态。', 'info');
    return true;
}


export async function rollbackAndRefill() {
    // 检查表格系统总开关
    const settings = extension_settings[extensionName] || {};
    if (settings.table_system_enabled === false) {
        log('表格系统总开关已关闭，跳过回退填表。', 'info');
        toastr.info('表格系统总开关已关闭，无法执行回退填表。');
        return;
    }
    
    toastr.info('正在执行回退并重新填表...');
    const rollbackSuccess = await rollbackState();
    
    if (!rollbackSuccess) {
        toastr.error('状态回退失败，已中止操作。');
        return;
    }
    
    toastr.success('状态回退成功，准备重新填表...');
    
    const context = getContext();
    const lastMessage = context.chat[context.chat.length - 1];

    try {
        await fillWithSecondaryApi(lastMessage, true);
        log('回退并重新填表操作完成。', 'success');
        // 填表函数自己有成功提示，这里不再重复
    } catch (error) {
        log(`回退重填过程中发生错误: ${error.message}`, 'error');
        toastr.error(`重新填表失败: ${error.message}`);
    }
}

export function updateColumnWidth(tableIndex, colIndex, width) {
    if (!currentTablesState || !currentTablesState[tableIndex]) return;
    const table = currentTablesState[tableIndex];
    if (!table.columnWidths) {
        table.columnWidths = [];
    }
    // Ensure array is long enough
    while (table.columnWidths.length < table.headers.length) {
        table.columnWidths.push(null);
    }
    table.columnWidths[colIndex] = width;

    // Persist the change
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (saveStateToMessage(currentTablesState, lastMessage)) {
            saveChat();
            return;
        }
    }
    saveChatDebounced();
}


export function isCurrentTablesEmpty() {
    const tables = getMemoryState();
    if (!tables || tables.length === 0) {
        return true; // 没有表格当然是空的
    }
    // 检查是否所有表格都没有行
    return tables.every(table => !table.rows || table.rows.length === 0);
}

export function clearGlobalPreset() {
    if (extension_settings[extensionName] && extension_settings[extensionName].global_table_preset) {
        const confirmation = window.confirm(
            "【清除全局预设】\n\n您确定要清除已设置的全局预设吗？\n\n清除后，新聊天将恢复使用扩展内置的默认表格模板。"
        );

        if (confirmation) {
            delete extension_settings[extensionName].global_table_preset;
            saveSettingsDebounced();
            log('全局预设已被清除。', 'success');
            toastr.success('全局预设已清除，新聊天将使用默认模板。', '操作成功');
        } else {
            log('用户取消了清除全局预设的操作。', 'info');
            toastr.info('操作已取消。');
        }
    } else {
        log('无需清除，当前未设置任何全局预设。', 'info');
        toastr.info('当前没有设置全局预设。', '提示');
    }
}

export function importGlobalPreset(onImported) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = event => {
            try {
                const preset = JSON.parse(event.target.result);

                if (!preset.version || !Array.isArray(preset.tables)) {
                    throw new Error('文件格式无效或缺少版本号/表格数据。');
                }

                const confirmation = window.confirm(
                    "【全局预设导入】\n\n这将把选定的预设设置为所有新聊天的默认表格。\n\n此操作将覆盖任何已存在的全局预设，是否确定？"
                );

                if (!confirmation) {
                    log('用户取消了全局预设导入操作。', 'info');
                    toastr.info('操作已取消。');
                    return;
                }

                // 创建一个纯净的预设副本，不包含任何行数据
                const cleanTables = preset.tables.map(table => ({
                    name: table.name,
                    headers: table.headers,
                    note: table.note,
                    rule_add: table.rule_add,
                    rule_delete: table.rule_delete,
                    rule_update: table.rule_update,
                    rows: [], // 关键：确保 rows 为空数组
                }));

                // 将纯净预设保存到 extension_settings
                if (!extension_settings[extensionName]) {
                    extension_settings[extensionName] = {};
                }
                extension_settings[extensionName].global_table_preset = {
                    version: preset.version,
                    tables: cleanTables,
                    batchFillerRuleTemplate: preset.batchFillerRuleTemplate,
                    batchFillerFlowTemplate: preset.batchFillerFlowTemplate,
                };
                
                saveSettingsDebounced();
                if (preset.version === "Amily2-Table-Preset-v3.0-separated_templates") {
                    saveBatchFillerRuleTemplate(preset.batchFillerRuleTemplate || '');
                    saveBatchFillerFlowTemplate(preset.batchFillerFlowTemplate || '');
                    saveAiTemplate(preset.injectionFlowTemplate || '');
                } else if (preset.aiRuleTemplate !== undefined && preset.aiFlowTemplate !== undefined) {
                    saveBatchFillerRuleTemplate(preset.aiRuleTemplate || '');
                    saveBatchFillerFlowTemplate(preset.aiFlowTemplate || '');
                    saveAiTemplate(preset.aiFlowTemplate || '');
                } else if (preset.aiTemplate) {
                    saveBatchFillerRuleTemplate('');
                    saveBatchFillerFlowTemplate(preset.aiTemplate || '');
                    saveAiTemplate(preset.aiTemplate || '');
                }

                log('全局预设已成功导入并保存到扩展设置中。', 'success');
                toastr.success('全局预设已设置！新聊天将默认使用此预设。', '设置成功');

                // 导入成功后，执行回调
                if (typeof onImported === 'function') {
                    onImported();
                }

            } catch (error) {
                log(`导入全局预设失败: ${error.message}`, 'error');
                toastr.error(`导入失败：${error.message}`, '错误');
            }
        };
        reader.readAsText(file);
    };

    input.click();
}
