/**
 * @file manager.js —— Phase 0 重构后承担"剩余的编排层"。
 *
 * 大部分功能已迁出：
 *   - 状态：infra/store.js (currentTablesState / highlights / updatedTables)
 *   - 持久化：infra/persistence.js (saveStateToMessage / commitToLastMessage)
 *   - 推演：actions/applyOperations.js (executor.js 改造为 legacy formatter)
 *   - 渲染：rendering.js (3 个 toCsv)
 *   - 模板：templates.js
 *   - 预设：preset.js
 *
 * 本文件保留：
 *   - 默认表格模板 + getDefaultTables
 *   - SuperMemory 事件分发（dispatchTableUpdate / dispatchAllTablesUpdate / triggerSync）
 *   - loadTables 的多档回退逻辑
 *   - 16 个 UI 突变（addRow / addColumn / ... / clearAllTables）
 *   - updateTableFromText 编排
 *   - rollbackState / rollbackAndRefill
 *
 * 所有原先 export 的接口一律保留兼容（移走的统一 re-export），调用方零改动。
 *
 * @typedef {import('./dto/Table.js').TableState} TableState
 */

import { getContext, extension_settings } from '/scripts/extensions.js';
import { saveChat } from '/script.js';
import { saveChatDebounced } from '../../utils/utils.js';
import { extensionName } from '../../utils/settings.js';

import { log } from './logger.js';
import { executeCommands } from './executor.js';
import { applyOperations } from './actions/applyOperations.js';
import { fillWithSecondaryApi } from './secondary-filler.js';
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { createTableUpdateEvent, inferTableRole } from './events-schema.js';

// ── 新模块（IAD 拆分后的依赖） ────────────────────────────────────────────
import {
    getState,
    setState,
    addHighlight as _storeAddHighlight,
    getHighlights as _storeGetHighlights,
    clearHighlights as _storeClearHighlights,
    markTableUpdated,
    getUpdatedTables as _storeGetUpdatedTables,
    clearUpdatedTables as _storeClearUpdatedTables,
} from './infra/store.js';

import {
    saveStateToMessage as _persistSaveStateToMessage,
    commitToLastMessage,
    TABLE_DATA_KEY,
} from './infra/persistence.js';

import {
    tablesToCsv,
    tablesToCsvWithSelection,
    tablesToCsvContentOnly,
} from './rendering.js';

import {
    getBatchFillerRuleTemplate as _tplGetBatchFillerRuleTemplate,
    saveBatchFillerRuleTemplate as _tplSaveBatchFillerRuleTemplate,
    getBatchFillerFlowTemplate as _tplGetBatchFillerFlowTemplate,
    saveBatchFillerFlowTemplate as _tplSaveBatchFillerFlowTemplate,
    getAiFlowTemplateForInjection as _tplGetAiFlowTemplateForInjection,
    saveAiTemplate as _tplSaveAiTemplate,
    getAiTemplate as _tplGetAiTemplate,
} from './templates.js';

import {
    exportPreset as _presetExportPreset,
    exportPresetFull as _presetExportPresetFull,
    importPreset as _presetImportPreset,
    clearGlobalPreset as _presetClearGlobalPreset,
    importGlobalPreset as _presetImportGlobalPreset,
} from './preset.js';

// ── 私有：SuperMemory 事件分发 ────────────────────────────────────────────

/**
 * 把单个表格的最新状态推送给 SuperMemory（优先 Bus 直调，降级 CustomEvent）。
 * @param {number} tableIndex
 */
function dispatchTableUpdate(tableIndex) {
    const settings = extension_settings[extensionName] || {};
    if (settings.super_memory_enabled === false) return;

    const state = getState();
    if (!state || !state[tableIndex]) return;
    const table = state[tableIndex];
    const role = inferTableRole(table.name);

    const smBus = window.Amily2Bus?.query('SuperMemory');
    if (smBus?.pushUpdate) {
        smBus.pushUpdate({
            tableName: table.name,
            data: table.rows,
            headers: table.headers,
            rowStatuses: table.rowStatuses ?? [],
            role,
        });
    } else {
        document.dispatchEvent(createTableUpdateEvent(table));
    }
    log(`[SuperMemory] Dispatched update for ${table.name} (role: ${role})`, 'info');
}

/**
 * 触发所有表格的全量同步（Pipeline 变更后调用）。
 */
function dispatchAllTablesUpdate() {
    const state = getState();
    if (!state) return;
    log('[SuperMemory] Dispatching update events for ALL tables...', 'info');
    state.forEach((_, index) => dispatchTableUpdate(index));
}

/**
 * 主动触发所有表格同步到 SuperMemory（外部调用入口）。
 */
export function triggerSync() {
    dispatchAllTablesUpdate();
}

// ── 状态访问（store 包装层） ──────────────────────────────────────────────

export function addHighlight(tableIndex, rowIndex, colIndex) {
    _storeAddHighlight(tableIndex, rowIndex, colIndex);
}

export function getHighlights() {
    return _storeGetHighlights();
}

export function clearHighlights() {
    _storeClearHighlights();
}

export function getUpdatedTables() {
    return _storeGetUpdatedTables();
}

export function clearUpdatedTables() {
    _storeClearUpdatedTables();
}

export function setMemoryState(newState) {
    setState(newState);
}

export function getMemoryState() {
    return getState();
}

export function loadMemoryState(state) {
    if (!state) return;
    setState(state);
    renderTables();
    updateOrInsertTableInChat();
    log('[SuperMemory] 已从元数据恢复内存状态并刷新 UI。', 'info');
}

export function saveMemoryState() {
    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (_persistSaveStateToMessage(getState(), lastMessage)) {
            // 不在此处强制 saveChat，避免高频；调用方决定时机
            return true;
        }
    }
    return false;
}

export function saveStateToMessage(stateToSave, targetMessage) {
    return _persistSaveStateToMessage(stateToSave, targetMessage);
}

// ── 默认模板 ──────────────────────────────────────────────────────────────

const defaultTemplate = {
    "tables": [
        {
          "name": "时空栏",
          "headers": ["日期", "时段", "时间", "地点", "此地角色"],
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
          "headers": ["角色名", "外貌", "身形", "衣着", "性格", "身份", "职业", "与<user>关系", "爱好", "住所", "其他重要信息"],
          "note": "【核心作用】此表格是角色关系和状态的核心数据库，用于记录所有在故事中出现的重要角色的详细信息。\n【字段详解】\n- 角色名: 角色的唯一标识。\n- 外貌: 描述五官、发型、发色、肤色等面部特征。\n- 身形: 描述身高、体型、肌肉状况、特殊身体标记（如伤疤）等。\n- 衣着: 描述角色当前或标志性的穿着，包括服装、配饰等。\n- 性格: 概括角色的核心性格特质，使用1-3个关键词，如'勇敢/鲁莽/忠诚'。\n- 身份: 角色的社会背景或出身，如'贵族后裔'、'流浪者'。\n- 职业: 角色赖以谋生的工作或职责，如'佣兵'、'学者'。\n- 与<user>关系: 描述该角色与主角<user>之间的社会或情感关系，如'盟友'、'导师'、'敌人'。\n- 爱好: 角色的兴趣和消遣活动。\n- 住所: 角色的常住地。\n- 其他重要信息: 记录任何不属于以上类别但对角色至关重要的信息，如特殊能力、过去的经历等。",
          "rule_add": "【触发条件】当一个有名有姓的角色首次出现，并与<user>或当前剧情发生有意义的互动时，必须为其创建新的一行。",
          "rule_delete": "【触发条件】当一个角色被确认永久性死亡（非假死或失踪），且其存在不再对后续剧情有直接影响时，可以删除该行。",
          "rule_update": "【触发条件】当角色的任何信息发生持久性或关键性变化时，必须更新对应单元格。例如：\n1. 外貌/身形/衣着发生永久性改变（如断肢、换上新装备）。\n2. 性格因重大事件而扭转。\n3. 身份或职业发生变更（如继承王位、被解雇）。\n4. 与<user>的关系发生根本性转变（如从敌人变为盟友）。",
          "charLimitRules": { "10": 30 },
          "rowLimitRule": 0,
          "rows": []
        },
        {
            "name": "关系栏",
            "headers": ["主动方", "被动方", "关系", "详情"],
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
          "headers": ["任务名", "类型", "详情", "状态", "执行者", "地点", "开始时间/结束时间", "结果"],
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
          "headers": ["物品名", "类型", "详情", "状态", "拥有者", "重要原因"],
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
          "headers": ["技能名", "技能效果"],
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
          "headers": ["类型", "具体描述"],
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
    const tables = JSON.parse(JSON.stringify(defaultTemplate.tables));
    tables.forEach(table => {
        table.charLimitRule = { columnIndex: -1, limit: 0 };
        table.rowLimitRule = 0;
        table.columnWidths = [];
    });
    return tables;
}

// ── 加载 ──────────────────────────────────────────────────────────────────

export function loadTables(stopIndex = -1) {
    const context = getContext();

    // 1. 优先从聊天记录中找已存的状态
    if (context && context.chat && context.chat.length > 0) {
        const startIndex = (stopIndex === -1 ? context.chat.length - 1 : stopIndex - 1);
        for (let i = startIndex; i >= 0; i--) {
            const message = context.chat[i];
            if (message.extra && message.extra[TABLE_DATA_KEY]) {
                log(`在第 ${i} 条消息中找到基准表格数据。`, 'info');
                let loadedState = JSON.parse(JSON.stringify(message.extra[TABLE_DATA_KEY]));

                loadedState.forEach(table => {
                    if (table.note === undefined) table.note = '无';
                    if (table.rule_add === undefined) table.rule_add = '允许';
                    if (table.rule_delete === undefined) table.rule_delete = '允许';
                    if (table.rule_update === undefined) table.rule_update = '允许';

                    // 多列规则兼容
                    if (table.charLimitRule && !table.charLimitRules) {
                        table.charLimitRules = {};
                        if (table.charLimitRule.columnIndex !== -1 && table.charLimitRule.limit > 0) {
                            table.charLimitRules[table.charLimitRule.columnIndex] = table.charLimitRule.limit;
                        }
                    }
                    delete table.charLimitRule;

                    if (table.rowLimitRule === undefined) table.rowLimitRule = 0;
                    if (table.columnWidths === undefined) table.columnWidths = [];

                    if (!table.rowStatuses) {
                        table.rowStatuses = Array(table.rows.length).fill('normal');
                    }
                });

                setState(loadedState);
                dispatchAllTablesUpdate();
                return getState();
            }
        }
    }

    // 2. 全局预设
    if (extension_settings[extensionName]?.global_table_preset) {
        log('未在聊天记录中找到表格，正在加载全局预设...', 'info');
        try {
            const globalPreset = extension_settings[extensionName].global_table_preset;
            setState(JSON.parse(JSON.stringify(globalPreset.tables)));

            if (globalPreset.batchFillerRuleTemplate !== undefined) {
                _tplSaveBatchFillerRuleTemplate(globalPreset.batchFillerRuleTemplate);
            }
            if (globalPreset.batchFillerFlowTemplate !== undefined) {
                _tplSaveBatchFillerFlowTemplate(globalPreset.batchFillerFlowTemplate);
            }

            dispatchAllTablesUpdate();
            return getState();
        } catch (error) {
            log(`加载全局预设失败: ${error.message}`, 'error');
        }
    }

    // 3. 默认模板
    log('未找到任何表格数据或全局预设，使用默认模板。', 'info');
    setState(getDefaultTables());
    dispatchAllTablesUpdate();
    return getState();
}

export function saveTables(sourceAction = '未知操作') {
    log(`UI操作 "${sourceAction}" 已更新内存状态。`, 'info');
    return true;
}

// ── 16 个 UI 突变 ─────────────────────────────────────────────────────────

export function deleteColumn(tableIndex, colIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex] || colIndex < 0 || colIndex >= tables[tableIndex].headers.length) {
        log(`删除列失败：在表格 ${tableIndex} 中找不到索引为 ${colIndex} 的列。`, 'error');
        return;
    }

    tables[tableIndex].headers.splice(colIndex, 1);
    tables[tableIndex].rows.forEach(row => {
        if (row.length > colIndex) row.splice(colIndex, 1);
    });
    if (tables[tableIndex].columnWidths && tables[tableIndex].columnWidths.length > colIndex) {
        tables[tableIndex].columnWidths.splice(colIndex, 1);
    }

    log(`成功删除了表格 ${tableIndex} 的第 ${colIndex + 1} 列。`, 'success');
    saveTables(tables);
    dispatchTableUpdate(tableIndex);
}

export function moveRow(tableIndex, rowIndex, direction) {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table || rowIndex < 0 || rowIndex >= table.rows.length) return;

    const newIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
    if (newIndex < 0 || newIndex >= table.rows.length) return;

    const [movedRow] = table.rows.splice(rowIndex, 1);
    table.rows.splice(newIndex, 0, movedRow);

    if (table.rowStatuses && table.rowStatuses.length === table.rows.length + 1) {
        const [movedStatus] = table.rowStatuses.splice(rowIndex, 1);
        table.rowStatuses.splice(newIndex, 0, movedStatus);
    }

    log(`成功将表格 ${tableIndex} 的第 ${rowIndex + 1} 行移动到第 ${newIndex + 1} 行。`, 'success');
    saveTables(tables);
    dispatchTableUpdate(tableIndex);
}

export function insertRow(tableIndex, data, position = 'below') {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table) {
        log(`插入行失败：找不到索引为 ${tableIndex} 的表格。`, 'error');
        return;
    }

    let insertIndex;
    if (typeof data === 'number') {
        insertIndex = position === 'above' ? data : data + 1;
    } else {
        insertIndex = table.rows.length;
    }
    if (insertIndex < 0) insertIndex = 0;
    if (insertIndex > table.rows.length) insertIndex = table.rows.length;

    const newRow = new Array(table.headers.length).fill('');

    if (typeof data === 'object' && data !== null) {
        for (const colIndex in data) {
            const cIndex = parseInt(colIndex, 10);
            if (!isNaN(cIndex) && cIndex < newRow.length) {
                newRow[cIndex] = data[colIndex];
                addHighlight(tableIndex, insertIndex, cIndex);
            }
        }
    }

    table.rows.splice(insertIndex, 0, newRow);
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.splice(insertIndex, 0, 'normal');

    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`成功在表格 ${table.name} (索引 ${tableIndex}) 的第 ${insertIndex + 1} 行位置插入了新行。`, 'success');

    commitToLastMessage(tables);
}

export function addRow(tableIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    const colCount = table.headers.length;
    const newRow = Array(colCount).fill('');
    table.rows.push(newRow);
    if (!table.rowStatuses) table.rowStatuses = Array(table.rows.length).fill('normal');
    table.rowStatuses.push('normal');
    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`表格 [${table.name}] 新增了一行。`, 'info');

    commitToLastMessage(tables);
}

export function addColumn(tableIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    const newHeader = `新列 ${table.headers.length + 1}`;
    table.headers.push(newHeader);
    table.rows.forEach(row => row.push(''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.push(null);
    log(`表格 [${table.name}] 新增了一列。`, 'info');

    commitToLastMessage(tables);
}

export function updateHeader(tableIndex, colIndex, value) {
    const tables = getState();
    if (!tables || !tables[tableIndex] || tables[tableIndex].headers[colIndex] === undefined) return;
    const tableName = tables[tableIndex].name;
    const originalHeader = tables[tableIndex].headers[colIndex];
    tables[tableIndex].headers[colIndex] = value;
    log(`表格 [${tableName}] 的表头“${originalHeader}”已更新为“${value}”。`, 'info');

    commitToLastMessage(tables);
}

export async function deleteRow(tableIndex, rowIndex) {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table || !table.rows[rowIndex]) return;

    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length).fill('normal');
    }

    table.rowStatuses[rowIndex] = 'pending-deletion';
    markTableUpdated(tableIndex);
    log(`表格 [${table.name}] 的第 ${rowIndex + 1} 行已标记为待删除。`, 'info');

    const context = getContext();
    if (context.chat?.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (_persistSaveStateToMessage(tables, lastMessage)) {
            await saveChat();
            renderTables();
            dispatchTableUpdate(tableIndex);
            return;
        }
    }
    await saveChatDebounced();
    renderTables();
    dispatchTableUpdate(tableIndex);
}

export async function restoreRow(tableIndex, rowIndex) {
    const tables = getState();
    const table = tables?.[tableIndex];
    if (!table || !table.rows[rowIndex] || !table.rowStatuses) return;

    table.rowStatuses[rowIndex] = 'normal';
    markTableUpdated(tableIndex);
    log(`表格 [${table.name}] 的第 ${rowIndex + 1} 行已恢复。`, 'info');

    const context = getContext();
    if (context.chat?.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (_persistSaveStateToMessage(tables, lastMessage)) {
            await saveChat();
            renderTables();
            dispatchTableUpdate(tableIndex);
            return;
        }
    }
    await saveChatDebounced();
    renderTables();
    dispatchTableUpdate(tableIndex);
}

export function commitPendingDeletions() {
    const tables = getState();
    if (!tables) return false;
    let deletionCount = 0;

    tables.forEach((table, tableIndex) => {
        if (!table.rowStatuses || table.rowStatuses.length === 0) return;
        let tableHadDeletions = false;
        for (let i = table.rows.length - 1; i >= 0; i--) {
            if (table.rowStatuses[i] === 'pending-deletion') {
                table.rows.splice(i, 1);
                table.rowStatuses.splice(i, 1);
                deletionCount++;
                tableHadDeletions = true;
            }
        }
        if (tableHadDeletions) markTableUpdated(tableIndex);
    });

    if (deletionCount > 0) {
        log(`已提交并永久删除了 ${deletionCount} 行。`, 'info');
        const updated = _storeGetUpdatedTables();
        if (updated.size > 0) {
            updated.forEach(tableIndex => dispatchTableUpdate(tableIndex));
        }
        return true;
    }
    return false;
}

export function insertColumn(tableIndex, colIndex, position) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];

    const insertAt = position === 'left' ? colIndex : colIndex + 1;
    table.headers.splice(insertAt, 0, '新列');
    table.rows.forEach(row => row.splice(insertAt, 0, ''));
    if (!table.columnWidths) table.columnWidths = [];
    table.columnWidths.splice(insertAt, 0, null);

    log(`表格 [${table.name}] 在第 ${colIndex + 1} 列的${position === 'left' ? '左侧' : '右侧'}插入了新列。`, 'info');
    commitToLastMessage(tables);
}

export function moveColumn(tableIndex, colIndex, direction) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    const headers = table.headers;
    const rows = table.rows;

    const targetIndex = direction === 'left' ? colIndex - 1 : colIndex + 1;
    if (targetIndex < 0 || targetIndex >= headers.length) {
        log(`无法移动列：索引 ${colIndex} 已在边界。`, 'warn');
        return;
    }

    const [headerToMove] = headers.splice(colIndex, 1);
    headers.splice(targetIndex, 0, headerToMove);

    rows.forEach(row => {
        const [cellToMove] = row.splice(colIndex, 1);
        row.splice(targetIndex, 0, cellToMove);
    });

    if (table.columnWidths && table.columnWidths.length > colIndex) {
        const [widthToMove] = table.columnWidths.splice(colIndex, 1);
        table.columnWidths.splice(targetIndex, 0, widthToMove);
    }

    log(`表格 [${table.name}] 的列“${headerToMove}”已向${direction === 'left' ? '左' : '右'}移动。`, 'info');
    commitToLastMessage(tables);
}

export function deleteTable(tableIndex) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const tableName = tables[tableIndex].name;
    tables.splice(tableIndex, 1);
    log(`表格 [${tableName}] 已被成功废黜。`, 'success');

    const success = commitToLastMessage(tables);
    if (success) {
        log('废黜表格后的状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，删除操作可能不会被持久化！', 'error');
    }
}

export function addTable(tableName) {
    if (!tableName || !tableName.trim()) {
        log('无法创建表格：名称不能为空。', 'error');
        toastr.error('表格名称不能为空。', '创建失败');
        return;
    }
    let tables = getState();
    if (!tables) {
        loadTables();
        tables = getState();
    }

    if (tables.some(table => table.name === tableName.trim())) {
        log(`无法创建表格：名为 "${tableName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${tableName}" 的表格已存在。`, '创建失败');
        return;
    }

    const newTable = {
        name: tableName.trim(),
        headers: ['新列 1'],
        rows: [],
        rowStatuses: [],
        columnWidths: [],
        note: '这是一个新创建的表格。',
        rule_add: '允许',
        rule_delete: '允许',
        rule_update: '允许',
        charLimitRules: {},
        rowLimitRule: 0,
    };

    tables.push(newTable);
    log(`已成功创建新表格：[${tableName.trim()}]。`, 'success');

    const success = commitToLastMessage(tables);
    if (success) {
        log('新表格状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，新表格可能不会被持久化！', 'error');
    }
}

export function renameTable(tableIndex, newName) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) {
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
    if (tables.some((table, index) => index !== tableIndex && table.name === trimmedName)) {
        log(`重命名失败：名为 "${trimmedName}" 的表格已存在。`, 'error');
        toastr.error(`名为 "${trimmedName}" 的表格已存在。`, '重命名失败');
        return;
    }

    const oldName = tables[tableIndex].name;
    tables[tableIndex].name = trimmedName;
    log(`表格 "${oldName}" 已重命名为 "${trimmedName}"。`, 'success');

    commitToLastMessage(tables);
}

export function moveTable(tableIndex, direction) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;

    const newIndex = direction === 'up' ? tableIndex - 1 : tableIndex + 1;
    if (newIndex < 0 || newIndex >= tables.length) {
        log(`无法移动表格：索引 ${tableIndex} 已在边界。`, 'warn');
        return;
    }

    const temp = tables[tableIndex];
    tables[tableIndex] = tables[newIndex];
    tables[newIndex] = temp;

    log(`表格 [${temp.name}] 的顺序已调整。`, 'success');

    const success = commitToLastMessage(tables);
    if (success) {
        log('表格顺序调整后的状态已强制写入最新消息并立即保存。', 'success');
    } else {
        log('无法找到可锚定的消息或保存失败，顺序调整可能不会被持久化！', 'error');
    }
}

export function updateTableRules(tableIndex, newRules) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    table.note = newRules.note;
    table.rule_add = newRules.rule_add;
    table.rule_delete = newRules.rule_delete;
    table.rule_update = newRules.rule_update;
    table.charLimitRules = newRules.charLimitRules;
    table.rowLimitRule = newRules.rowLimitRule;
    table.simplifyRowThreshold = newRules.simplifyRowThreshold;

    delete table.charLimitRule;

    log(`表格 [${table.name}] 的规则已更新。`, 'info');
    commitToLastMessage(tables);
}

export function updateRow(tableIndex, rowIndex, data) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) {
        log(`AI指令错误：尝试在不存在的表格索引 ${tableIndex} 中操作。`, 'error');
        return;
    }
    const table = tables[tableIndex];

    if (rowIndex >= table.rows.length) {
        log(`AI指令意图更新不存在的行 (rowIndex: ${rowIndex})，已智能转换为在表格 [${table.name}] 末尾新增一行。`, 'warn');
        insertRow(tableIndex, data);
        return;
    }

    const row = table.rows[rowIndex];
    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < row.length) {
            row[cIndex] = data[cIndex];
            addHighlight(tableIndex, rowIndex, cIndex);
        }
    }

    markTableUpdated(tableIndex);
    dispatchTableUpdate(tableIndex);
    log(`AI 指令更新了表格 [${table.name}] 的第 ${rowIndex + 1} 行。`, 'info');

    commitToLastMessage(tables);
}

export function clearAllTables() {
    const tables = getState();
    if (!tables) {
        log('无法清空：当前表格状态为空。', 'error');
        return;
    }

    tables.forEach((table, tableIndex) => {
        if (table.rows.length > 0) markTableUpdated(tableIndex);
        table.rows = [];
        table.rowStatuses = [];
    });
    log('所有表格的行数据已在内存中清空。', 'warn');

    dispatchAllTablesUpdate();

    const success = commitToLastMessage(tables);
    if (success) {
        log('清空行数据后的状态已强制写入最新消息并立即保存。', 'success');
        toastr.success('所有表格的剧情内容已清空。', '操作完成');
    } else {
        log('无法找到可锚定的消息或保存失败，清空操作可能不会被持久化！', 'error');
    }
}

// ── 渲染 wrapper（注入当前 state） ────────────────────────────────────────

export function convertTablesToCsvString() {
    let state = getState();
    if (!state) {
        loadTables();
        state = getState();
    }
    return tablesToCsv(state);
}

export function convertSelectedTablesToCsvString(selectedIndices) {
    let state = getState();
    if (!state) {
        loadTables();
        state = getState();
    }
    return tablesToCsvWithSelection(state, selectedIndices);
}

export function convertTablesToCsvStringForContentOnly() {
    return tablesToCsvContentOnly(getState());
}

// ── 模板（re-export） ─────────────────────────────────────────────────────

export const getBatchFillerRuleTemplate = _tplGetBatchFillerRuleTemplate;
export const saveBatchFillerRuleTemplate = _tplSaveBatchFillerRuleTemplate;
export const getBatchFillerFlowTemplate = _tplGetBatchFillerFlowTemplate;
export const saveBatchFillerFlowTemplate = _tplSaveBatchFillerFlowTemplate;
export const getAiFlowTemplateForInjection = _tplGetAiFlowTemplateForInjection;
export const saveAiTemplate = _tplSaveAiTemplate;
export const getAiTemplate = _tplGetAiTemplate;

// ── 文本指令应用（updateTableFromText） ───────────────────────────────────

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

    const { finalState, hasChanges, changes } = executeCommands(textContent, getState());

    if (!hasChanges) {
        log('AI指令未产生任何实质性变更。', 'info');
        return;
    }

    setState(finalState);

    if (options.immediateDelete) {
        commitPendingDeletions();
    }

    changes.forEach(change => {
        markTableUpdated(change.tableIndex);
        if (change.type === 'update' || change.type === 'insert') {
            if (change.rowIndex !== undefined && change.colIndex !== undefined) {
                addHighlight(change.tableIndex, change.rowIndex, change.colIndex);
            }
        }
    });

    log(`成功执行了 ${changes.length} 处变更。`, 'success');

    const affectedTables = [...new Set(changes.map(c => c.tableIndex))];
    affectedTables.forEach(tableIndex => dispatchTableUpdate(tableIndex));

    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (_persistSaveStateToMessage(getState(), lastMessage)) {
            await saveChat();
            toastr.success('已根据AI的指示成功更新表格！', '填表完成');
            document.dispatchEvent(new CustomEvent('amily2-force-ui-reload'));
            return;
        }
    }

    saveChatDebounced();
    toastr.success('已根据AI的指示成功更新表格！', '填表完成');
    document.dispatchEvent(new CustomEvent('amily2-force-ui-reload'));
}

/**
 * 直接从 Operation[] 应用变更（Function Call 路径），跳过文本解析。
 * 后续流程与 updateTableFromText 完全一致。
 *
 * @param {import('./dto/Operation.js').Operation[]} ops
 * @param {Object} options - 同 updateTableFromText 的 options
 */
export async function updateTableFromOps(ops, options = {}) {
    const settings = extension_settings[extensionName] || {};
    if (settings.table_system_enabled === false) return;

    if (!Array.isArray(ops) || ops.length === 0) {
        log('Function Call 返回操作列表为空，无需更新表格。', 'info');
        return;
    }

    const { state, changes } = applyOperations(getState(), ops);

    if (changes.length === 0) {
        log('Function Call 操作未产生任何实质性变更。', 'info');
        return;
    }

    setState(state);

    if (options.immediateDelete) {
        commitPendingDeletions();
    }

    changes.forEach(change => {
        markTableUpdated(change.tableIndex);
        if (change.type === 'update' || change.type === 'insert') {
            if (change.rowIndex !== undefined && change.colIndex !== undefined) {
                addHighlight(change.tableIndex, change.rowIndex, change.colIndex);
            }
        }
    });

    log(`Function Call 成功执行了 ${changes.length} 处变更。`, 'success');

    const affectedTables = [...new Set(changes.map(c => c.tableIndex))];
    affectedTables.forEach(tableIndex => dispatchTableUpdate(tableIndex));

    const context = getContext();
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (_persistSaveStateToMessage(getState(), lastMessage)) {
            await saveChat();
            toastr.success('已根据AI的指示成功更新表格！', '填表完成');
            document.dispatchEvent(new CustomEvent('amily2-force-ui-reload'));
            return;
        }
    }

    saveChatDebounced();
    toastr.success('已根据AI的指示成功更新表格！', '填表完成');
    document.dispatchEvent(new CustomEvent('amily2-force-ui-reload'));
}

// ── 预设（re-export 或 wrapper） ─────────────────────────────────────────

export const exportPreset = _presetExportPreset;
export const exportPresetFull = _presetExportPresetFull;
export const clearGlobalPreset = _presetClearGlobalPreset;
export const importGlobalPreset = _presetImportGlobalPreset;

/**
 * importPreset wrapper：在 setState 之后注入 SuperMemory 全量同步。
 * 兼容旧签名 importPreset(callback) 和新 importPreset({ onAfterApply, onImported })。
 */
export function importPreset(onImportedOrHooks) {
    /** @type {{ onAfterApply?: () => void, onImported?: () => void }} */
    const hooks = typeof onImportedOrHooks === 'function'
        ? { onImported: onImportedOrHooks }
        : (onImportedOrHooks || {});

    return _presetImportPreset({
        onAfterApply: () => {
            dispatchAllTablesUpdate();
            if (hooks.onAfterApply) hooks.onAfterApply();
        },
        onImported: hooks.onImported,
    });
}

// ── 回滚 ──────────────────────────────────────────────────────────────────

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

    log(`正在尝试从第 ${lastMessageIndex - 1} 条消息加载表格状态...`, 'info');
    const previousState = loadTables(lastMessageIndex);

    if (!previousState) {
        log('未能在上一楼找到可用的表格状态，无法回退。', 'error');
        toastr.error('未能在上一楼找到可用的表格状态。');
        return false;
    }

    setState(previousState);
    if (_persistSaveStateToMessage(previousState, lastMessage)) {
        await saveChat();
        log('已成功将回退后的状态保存至最新消息。', 'success');
    } else {
        log('回退状态保存失败，操作中止。', 'error');
        toastr.error('未能保存回退状态，操作中止。');
        return false;
    }

    renderTables();
    updateOrInsertTableInChat();
    log('UI已更新以显示回退后的状态。', 'info');
    return true;
}

export async function rollbackAndRefill() {
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
    } catch (error) {
        log(`回退重填过程中发生错误: ${error.message}`, 'error');
        toastr.error(`重新填表失败: ${error.message}`);
    }
}

// ── 杂项 ──────────────────────────────────────────────────────────────────

export function updateColumnWidth(tableIndex, colIndex, width) {
    const tables = getState();
    if (!tables || !tables[tableIndex]) return;
    const table = tables[tableIndex];
    if (!table.columnWidths) table.columnWidths = [];
    while (table.columnWidths.length < table.headers.length) {
        table.columnWidths.push(null);
    }
    table.columnWidths[colIndex] = width;

    commitToLastMessage(tables);
}

export function isCurrentTablesEmpty() {
    const tables = getState();
    if (!tables || tables.length === 0) return true;
    return tables.every(table => !table.rows || table.rows.length === 0);
}

// ── 模块初始化 ─────────────────────────────────────────────────────────────

// 模块加载时执行一次初始 loadTables
loadTables();
