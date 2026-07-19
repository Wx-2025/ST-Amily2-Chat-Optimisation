import { COMBATANT_COLUMNS, combatantToTableRow } from './combatant.js';

export const COMBAT_TABLE_NAMES = Object.freeze({
    STATE: '战斗角色状态',
    SUMMARY: '战斗回合摘要',
});

export const COMBAT_SUMMARY_COLUMNS = Object.freeze([
    '回合', '行动者', '技能/书页', '目标', '结果', '伤害', '状态变动', '资源变动',
]);

/** Create the two persistent L3 tables without touching the live table store. */
export function createCombatTables(combatants = []) {
    ensureUniqueNames(combatants);
    return [
        {
            name: COMBAT_TABLE_NAMES.STATE,
            headers: [...COMBATANT_COLUMNS],
            rows: combatants.map(combatantToTableRow),
            rowStatuses: combatants.map(() => 'normal'),
            note: 'combatSchemaVersion:1；引擎维护 HP/资源/状态，死亡保留行且状态写 dead。',
            rule_add: '开战时由战斗引擎插入参战角色；禁止 LLM 自行添加战斗角色。',
            rule_delete: '战斗中不删除角色行；死亡角色保留并在当前状态中写 dead。',
            rule_update: '仅战斗引擎或用户手动编辑可更新 HP、资源值、当前状态和备注。',
        },
        {
            name: COMBAT_TABLE_NAMES.SUMMARY,
            headers: [...COMBAT_SUMMARY_COLUMNS],
            rows: [],
            rowStatuses: [],
            note: 'combatSchemaVersion:1；仅保存摘要，不保存逐骰或逐硬币明细。',
            rule_add: '每次战斗行动结算后由战斗引擎追加一行摘要。',
            rule_delete: '不删除历史回合摘要。',
            rule_update: '不修改既有回合摘要。',
        },
    ];
}

/**
 * Build table operations after a resolver returns its next combatant states.
 * The caller executes them through the existing TableSystem service.
 */
export function createCombatStateUpdateOperations(tableState, combatants) {
    const stateTableIndex = findCombatTableIndex(tableState, COMBAT_TABLE_NAMES.STATE);
    const stateTable = tableState[stateTableIndex];
    const rowByName = new Map(stateTable.rows.map((row, index) => [row[0], index]));

    return combatants.map(combatant => {
        const rowIndex = rowByName.get(combatant.name);
        if (rowIndex === undefined) {
            throw new Error(`Combatant "${combatant.name}" is not present in the combat state table.`);
        }
        return {
            op: 'updateRow',
            tableIndex: stateTableIndex,
            rowIndex,
            data: rowToData(combatantToTableRow(combatant)),
        };
    });
}

export function createRoundSummaryOperation(tableState, summary) {
    const tableIndex = findCombatTableIndex(tableState, COMBAT_TABLE_NAMES.SUMMARY);
    const row = [
        String(summary.round ?? '-'),
        String(summary.actor ?? '-'),
        String(summary.skill ?? '-'),
        String(summary.target ?? '-'),
        String(summary.result ?? '-'),
        String(summary.damage ?? 0),
        String(summary.statusChange ?? '-'),
        String(summary.resourceChange ?? '-'),
    ];
    return { op: 'insertRow', tableIndex, data: rowToData(row) };
}

export function findCombatTableIndex(tableState, tableName) {
    const index = (tableState || []).findIndex(table => table?.name === tableName);
    if (index < 0) throw new Error(`Combat table "${tableName}" is not initialized.`);
    return index;
}

function rowToData(row) {
    return Object.fromEntries(row.map((value, index) => [String(index), String(value ?? '-')]));
}

function ensureUniqueNames(combatants) {
    const names = new Set();
    for (const combatant of combatants) {
        if (names.has(combatant.name)) {
            throw new Error(`Duplicate combatant name "${combatant.name}". Add a unique suffix before initialization.`);
        }
        names.add(combatant.name);
    }
}
