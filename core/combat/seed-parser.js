import { createCombatant, normalizeCombatMode } from './combatant.js';

const PROFILE_HEADER = /^【战斗档案·(.+?)】\s*$/gm;

/**
 * Parse one or more L2 worldbook combat profiles into engine-neutral combatants.
 * Unknown fields are retained as metadata for mode-specific resolvers.
 */
export function parseCombatProfiles(text, options = {}) {
    const source = String(text ?? '');
    const headers = [...source.matchAll(PROFILE_HEADER)];
    const profiles = [];

    for (let index = 0; index < headers.length; index++) {
        const header = headers[index];
        const bodyStart = header.index + header[0].length;
        const bodyEnd = index + 1 < headers.length ? headers[index + 1].index : source.length;
        profiles.push(parseCombatProfile(header[1].trim(), source.slice(bodyStart, bodyEnd), options));
    }
    return profiles;
}

export function parseCombatProfile(name, body, options = {}) {
    const fields = {};
    const skills = [];
    let inSkills = false;

    for (const rawLine of String(body ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^技能\s*[:：]\s*$/.test(line)) {
            inSkills = true;
            continue;
        }
        if (inSkills && line.startsWith('-')) {
            skills.push(parseSkill(line.slice(1).trim(), skills.length));
            continue;
        }

        const pair = line.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
        if (pair) {
            inSkills = false;
            fields[pair[1].trim()] = pair[2].trim();
        }
    }

    const hp = numberOrDefault(fields.HP, options.defaultHp ?? 10);
    return {
        ...createCombatant({
            id: `${name}:${options.instance ?? 1}`,
            name,
            faction: fields.阵营 ?? options.defaultFaction ?? '中立',
            mode: normalizeCombatMode(fields.模式, options.defaultMode),
            hp,
            maxHp: numberOrDefault(fields.最大HP, hp),
            attackLevel: numberOrDefault(fields.攻击等级, 1),
            defenseLevel: numberOrDefault(fields.防御等级, 1),
            attackPower: numberOrDefault(fields.攻击力, 0),
            defensePower: numberOrDefault(fields.防御力, 0),
            speed: numberOrDefault(fields.速度, 0),
            sanity: numberOrDefault(fields.SP ?? fields.理智 ?? fields.sanity, 0),
            resource: fields.资源 ?? '-',
            statuses: fields.当前状态 ?? '',
            notes: fields.备注 ?? '',
            passives: splitList(fields.被动),
            skills,
        }),
        metadata: fields,
    };
}

function parseSkill(raw, index) {
    const [name = '', type = '攻击', formula = '-', cost = '-', effects = '-'] = raw
        .split('|')
        .map(part => part.trim());
    return {
        id: `skill-${index + 1}`,
        name: name || `未命名技能${index + 1}`,
        type: type || '攻击',
        formula: formula || '-',
        cost: cost || '-',
        effects: effects || '-',
    };
}

function splitList(value) {
    return String(value ?? '')
        .split(/[，,]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function numberOrDefault(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
