export const COMBAT_MODES = Object.freeze({
    LOR: 'LoR',
    LC: 'LC',
    DND: 'DND',
});

export const COMBATANT_COLUMNS = Object.freeze([
    '角色名', '阵营', '模式', 'HP', '最大HP', '攻击等级', '防御等级', '速度', '资源值', '当前状态', '备注',
]);

const MODE_ALIASES = new Map([
    ['lor', COMBAT_MODES.LOR],
    ['图书馆', COMBAT_MODES.LOR],
    ['lc', COMBAT_MODES.LC],
    ['limbus', COMBAT_MODES.LC],
    ['边狱', COMBAT_MODES.LC],
    ['dnd', COMBAT_MODES.DND],
    ['d&d', COMBAT_MODES.DND],
]);

export function normalizeCombatMode(value, fallback = COMBAT_MODES.LC) {
    if (!value) return fallback;
    const normalized = String(value).trim();
    if (Object.values(COMBAT_MODES).includes(normalized)) return normalized;
    return MODE_ALIASES.get(normalized.toLowerCase()) || fallback;
}

export function parseResource(value) {
    const raw = String(value ?? '').trim();
    const match = raw.match(/^([^:：]+)\s*[:：]\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return { type: raw || '-', value: null, raw };
    return { type: match[1].trim(), value: Number(match[2]), raw };
}

export function formatResource(resource) {
    if (!resource?.type) return '-';
    return Number.isFinite(resource.value) ? `${resource.type}:${resource.value}` : resource.type;
}

export function parseStatuses(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(String);
    return String(value ?? '')
        .split(/[，,]/)
        .map(item => item.trim())
        .filter(Boolean);
}

export function createCombatant(input = {}) {
    const maxHp = positiveInteger(input.maxHp ?? input.hp, 10);
    const hp = clamp(integer(input.hp, maxHp), 0, maxHp);
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('Combatant name is required.');

    return {
        id: String(input.id ?? name),
        name,
        faction: String(input.faction ?? '中立').trim() || '中立',
        mode: normalizeCombatMode(input.mode),
        hp,
        maxHp,
        attackLevel: integer(input.attackLevel, 1),
        defenseLevel: integer(input.defenseLevel, 1),
        attackPower: integer(input.attackPower, 0),
        defensePower: integer(input.defensePower, 0),
        speed: integer(input.speed, 0),
        sanity: clamp(integer(input.sanity, 0), -45, 45),
        resource: parseResource(input.resource),
        statuses: parseStatuses(input.statuses),
        notes: String(input.notes ?? '').trim(),
        passives: Array.isArray(input.passives) ? input.passives.filter(Boolean) : [],
        skills: Array.isArray(input.skills) ? input.skills : [],
    };
}

export function combatantToTableRow(combatant) {
    return [
        combatant.name,
        combatant.faction,
        combatant.mode,
        String(combatant.hp),
        String(combatant.maxHp),
        String(combatant.attackLevel),
        String(combatant.defenseLevel),
        String(combatant.speed),
        formatResource(combatant.resource),
        combatant.statuses.join(','),
        combatant.notes || '-',
    ];
}

function integer(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
    return Math.max(1, integer(value, fallback));
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
