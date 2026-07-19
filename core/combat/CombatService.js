import { SeededRandom } from './random.js';
import { combatantToTableRow, formatResource } from './combatant.js';
import { parseCombatProfiles } from './seed-parser.js';
import { CombatReport } from './report.js';
import { resolveLorAction } from './modes/lor.js';
import { resolveLcAction } from './modes/lc.js';
import {
    createCombatTables,
    createCombatStateUpdateOperations,
    createRoundSummaryOperation,
} from './table-adapter.js';

const COMBAT_TABLE_DEFINITIONS = Object.freeze([
    {
        id: 'combat.state',
        owner: 'CombatSystem',
        schemaVersion: 1,
        name: '战斗角色状态',
        columns: [
            ['name', '角色名'], ['faction', '阵营'], ['mode', '模式'], ['hp', 'HP'], ['maxHp', '最大HP'],
            ['attackLevel', '攻击等级'], ['defenseLevel', '防御等级'], ['speed', '速度'], ['resource', '资源值'],
            ['statuses', '当前状态'], ['notes', '备注'],
        ].map(([id, label]) => ({ id, label, type: 'string' })),
        note: '由 CombatSystem 维护的战斗角色运行状态。',
    },
    {
        id: 'combat.rounds',
        owner: 'CombatSystem',
        schemaVersion: 1,
        name: '战斗回合摘要',
        columns: [
            ['round', '回合'], ['actor', '行动者'], ['skill', '技能/书页'], ['target', '目标'],
            ['result', '结果'], ['damage', '伤害'], ['statusChange', '状态变动'], ['resourceChange', '资源变动'],
        ].map(([id, label]) => ({ id, label, type: 'string' })),
        note: '由 CombatSystem 追加的回合级摘要。',
    },
]);

let combatBusContext = null;
let definitionRegistration = null;

/**
 * Combat foundation service. Resolvers remain pure; table persistence is an
 * explicit orchestration step so callers can replay or preview first.
 */
export function createEncounterFromSeeds(seedText, options = {}) {
    const combatants = parseCombatProfiles(seedText, options);
    return {
        schemaVersion: 1,
        seed: String(options.seed ?? Date.now()),
        combatants,
        tableRows: combatants.map(combatantToTableRow),
        tables: createCombatTables(combatants),
    };
}

/** Create a new encounter and persist its initial state through TableSystem. */
export async function startEncounterFromSeeds(seedText, options = {}) {
    const encounter = createEncounterFromSeeds(seedText, options);
    await ensureCombatTables();

    const combatants = [];
    for (const combatant of encounter.combatants) {
        const result = await combatBusContext.callService('TableSystem', 'mutateOwnedRecord', {
            tableId: 'combat.state',
            action: 'insert',
            values: combatantToRecordValues(combatant),
        });
        combatants.push({ ...combatant, recordId: result.recordId });
    }
    return { ...encounter, combatants };
}

/** Persist a resolver result. Resolver inputs must originate from startEncounterFromSeeds(). */
export async function persistCombatResolution(result) {
    if (!result?.attacker?.recordId || !result?.defender?.recordId) {
        throw new Error('Combat result is missing table record ids. Start the encounter through startEncounterFromSeeds().');
    }
    await ensureCombatTables();

    await Promise.all([
        combatBusContext.callService('TableSystem', 'mutateOwnedRecord', {
            tableId: 'combat.state',
            action: 'update',
            recordId: result.attacker.recordId,
            values: combatantToRecordValues(result.attacker),
        }),
        combatBusContext.callService('TableSystem', 'mutateOwnedRecord', {
            tableId: 'combat.state',
            action: 'update',
            recordId: result.defender.recordId,
            values: combatantToRecordValues(result.defender),
        }),
    ]);

    await combatBusContext.callService('TableSystem', 'mutateOwnedRecord', {
        tableId: 'combat.rounds',
        action: 'insert',
        values: {
            round: result.round,
            actor: result.attacker.name,
            skill: result.attackerSkill || '-',
            target: result.defender.name,
            result: result.flags?.attackerWins === false && result.flags?.defenderWins ? '拼点败'
                : result.damage?.toDefender > 0 ? '拼点胜' : '势均',
            damage: result.damage?.toDefender ?? 0,
            statusChange: summarizeStatusChange(result.attacker, result.defender),
            resourceChange: summarizeResourceChange(result),
        },
    });
    return result;
}

setTimeout(() => {
    try {
        const context = window.Amily2Bus?.register('CombatSystem');
        if (!context) {
            console.warn('[CombatSystem] Amily2Bus 尚未就绪，服务注册跳过。');
            return;
        }
        combatBusContext = context;
        context.expose({
            createEncounterFromSeeds,
            startEncounterFromSeeds,
            ensureCombatTables,
            persistCombatResolution,
            createRandom: seed => new SeededRandom(seed),
            createReport: round => new CombatReport(round),
            resolveLoR: resolveLorAction,
            resolveLC: resolveLcAction,
            createCombatTables,
            createCombatStateUpdateOperations,
            createRoundSummaryOperation,
        });
        registerCombatTableDefinitions(context);
        context.log('CombatService', 'info', '战斗系统基础服务已注册。');
    } catch (error) {
        console.error('[CombatSystem] 服务注册失败:', error);
    }
}, 0);

function registerCombatTableDefinitions(context) {
    definitionRegistration = Promise.all(COMBAT_TABLE_DEFINITIONS.map(definition => (
        callTableServiceWhenReady(context, 'registerTableDefinition', definition)
    )));
    definitionRegistration.catch(error => {
        console.error('[CombatSystem] 战斗表定义注册失败:', error);
    });
}

async function ensureCombatTables() {
    if (!combatBusContext) throw new Error('CombatSystem is not registered on Amily2Bus.');
    await definitionRegistration;
    await Promise.all(COMBAT_TABLE_DEFINITIONS.map(definition => (
        callTableServiceWhenReady(combatBusContext, 'ensureRegisteredTable', definition.id)
    )));
}

async function callTableServiceWhenReady(context, method, ...args) {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            return await context.callService('TableSystem', method, ...args);
        } catch (error) {
            if (!isTableServiceUnavailable(error)) throw error;
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw lastError || new Error('TableSystem service did not become available.');
}

function isTableServiceUnavailable(error) {
    return String(error?.message || error).includes("Service 'TableSystem' is not available.");
}

function combatantToRecordValues(combatant) {
    return {
        name: combatant.name,
        faction: combatant.faction,
        mode: combatant.mode,
        hp: combatant.hp,
        maxHp: combatant.maxHp,
        attackLevel: combatant.attackLevel,
        defenseLevel: combatant.defenseLevel,
        speed: combatant.speed,
        resource: formatResource(combatant.resource),
        statuses: (combatant.statuses || []).join(','),
        notes: combatant.notes || '-',
    };
}

function summarizeStatusChange(attacker, defender) {
    const attackerStatus = (attacker.statuses || []).join(',') || '-';
    const defenderStatus = (defender.statuses || []).join(',') || '-';
    return `${attacker.name}:${attackerStatus}; ${defender.name}:${defenderStatus}`;
}

function summarizeResourceChange(result) {
    if (!result.spDelta) return '-';
    return `${result.attacker.name}:SP${formatSigned(result.spDelta.attacker)}; ${result.defender.name}:SP${formatSigned(result.spDelta.defender)}`;
}

function formatSigned(value) {
    const number = Number(value) || 0;
    return number >= 0 ? `+${number}` : String(number);
}
