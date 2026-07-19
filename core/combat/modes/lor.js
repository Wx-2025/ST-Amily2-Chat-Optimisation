import { CombatReport } from '../report.js';

/** Parse LoR dice shorthand such as [3-8][4-9]. */
export function parseLorDice(formula) {
    const dice = [];
    for (const match of String(formula ?? '').matchAll(/\[(\d+)\s*-\s*(\d+)\]/g)) {
        const min = Number(match[1]);
        const max = Number(match[2]);
        if (min > max) throw new Error(`Invalid LoR die range: [${min}-${max}]`);
        dice.push({ min, max });
    }
    if (!dice.length) throw new Error(`LoR skill has no dice: ${formula}`);
    return dice;
}

export function calculateLevelAdvantage(ownLevel, opposingLevel) {
    return Math.max(0, Math.floor((Number(ownLevel) - Number(opposingLevel)) / 3));
}

/**
 * Deterministically resolve one LoR attack declaration.
 * The caller supplies a SeededRandom instance so every result can be replayed from its seed.
 */
export function resolveLorAction({ round, attacker, attackerSkill, defender, defenderSkill = null, rng }) {
    if (!rng || typeof rng.int !== 'function') throw new Error('LoR resolution requires a deterministic random source.');
    if (!attacker || !defender) throw new Error('LoR resolution requires attacker and defender.');

    const attackDice = parseLorDice(attackerSkill?.formula);
    const defenseDice = defenderSkill ? parseLorDice(defenderSkill.formula) : [];
    const attackAdvantage = calculateLevelAdvantage(attacker.attackLevel, defender.defenseLevel);
    const defenseAdvantage = calculateLevelAdvantage(defender.defenseLevel, attacker.attackLevel);
    const attackPower = numeric(attacker.attackPower);
    const defensePower = numeric(defender.defensePower);
    const report = new CombatReport(round);
    const clashes = [];

    let damageToAttacker = 0;
    let damageToDefender = 0;
    let attackerWins = 0;
    let defenderWins = 0;
    let sequence = 1;

    const maxPairs = Math.max(attackDice.length, defenseDice.length);
    for (let index = 0; index < maxPairs; index++) {
        const attackDie = attackDice[index];
        const defenseDie = defenseDice[index];
        const attackRoll = attackDie ? rng.int(attackDie.min, attackDie.max, `LoR:R${round}:A:${index + 1}`) : null;
        const defenseRoll = defenseDie ? rng.int(defenseDie.min, defenseDie.max, `LoR:R${round}:D:${index + 1}`) : null;
        const attackTotal = attackRoll === null ? null : attackRoll + attackPower + attackAdvantage;
        const defenseTotal = defenseRoll === null ? null : defenseRoll + defensePower + defenseAdvantage;

        let result = 'Draw';
        let delta = 0;
        if (attackTotal !== null && defenseTotal === null) {
            result = 'Aw';
            delta = attackTotal;
            damageToDefender += delta;
            attackerWins++;
        } else if (attackTotal === null && defenseTotal !== null) {
            result = 'Bw';
            delta = defenseTotal;
            damageToAttacker += delta;
            defenderWins++;
        } else if (attackTotal > defenseTotal) {
            result = 'Aw';
            delta = attackTotal - defenseTotal;
            damageToDefender += delta;
            attackerWins++;
        } else if (defenseTotal > attackTotal) {
            result = 'Bw';
            delta = defenseTotal - attackTotal;
            damageToAttacker += delta;
            defenderWins++;
        }

        const tags = clashTags(result, delta, attacker.name, defender.name);
        report.addClash({
            sequence: sequence++,
            attacker: attacker.name,
            attackerValues: attackRoll === null ? [null] : [attackRoll, attackPower, attackAdvantage],
            defender: defender.name,
            defenderValues: defenseRoll === null ? [null] : [defenseRoll, defensePower, defenseAdvantage],
            result,
            tags,
            note: `${attackTotal ?? '—'} vs ${defenseTotal ?? '—'}`,
        });
        clashes.push({ index: index + 1, attackRoll, defenseRoll, attackTotal, defenseTotal, result, delta });
    }

    const attackerCritical = attackDice.every((die, index) => clashes[index]?.attackRoll === die.max);
    if (attackerCritical && damageToDefender > 0) {
        damageToDefender = Math.floor(damageToDefender * 1.5);
    }

    const perfectBlock = defenseDice.length > 0 && attackerWins === 0 && defenderWins === maxPairs;
    let reflectionDamage = 0;
    if (perfectBlock && damageToAttacker > 0) {
        reflectionDamage = Math.floor(damageToAttacker * 0.5);
        damageToAttacker += reflectionDamage;
    }

    const nextAttacker = applyDamage(attacker, damageToAttacker);
    const nextDefender = applyDamage(defender, damageToDefender);
    const settlementTags = [];
    if (attackerCritical) settlementTags.push('暴击');
    if (perfectBlock) settlementTags.push('完美格挡');

    if (damageToDefender > 0) {
        report.addSettlement({
            sequence: sequence++,
            actor: defender.name,
            change: `HP-${damageToDefender}`,
            tags: [...settlementTags, injuryTag(damageToDefender, defender.maxHp)],
        });
    }
    if (damageToAttacker > 0) {
        report.addSettlement({
            sequence: sequence++,
            actor: attacker.name,
            change: `HP-${damageToAttacker}`,
            tags: reflectionDamage ? ['反震', injuryTag(damageToAttacker, attacker.maxHp)] : [injuryTag(damageToAttacker, attacker.maxHp)],
        });
    }

    return {
        mode: 'LoR',
        round,
        attacker: nextAttacker,
        defender: nextDefender,
        attackerSkill: attackerSkill?.name ?? '未命名技能',
        defenderSkill: defenderSkill?.name ?? null,
        clashes,
        damage: { toAttacker: damageToAttacker, toDefender: damageToDefender, reflection: reflectionDamage },
        flags: { attackerCritical, perfectBlock },
        report,
        reportText: report.toText(),
    };
}

function applyDamage(combatant, damage) {
    const hp = Math.max(0, numeric(combatant.hp) - damage);
    const statuses = [...(combatant.statuses || [])];
    if (damage > numeric(combatant.maxHp) * 0.3 && !statuses.includes('破防')) {
        statuses.push('破防');
    }
    if (hp === 0 && !statuses.includes('dead')) statuses.push('dead');
    return { ...combatant, hp, statuses };
}

function clashTags(result, delta, attackerName, defenderName) {
    if (result === 'Draw') return ['势均'];
    const winner = result === 'Aw' ? attackerName : defenderName;
    if (delta >= 10) return [`${winner}碾压`];
    if (delta >= 4) return [`${winner}压制`];
    return [`${winner}险胜`];
}

function injuryTag(damage, maxHp) {
    if (damage >= numeric(maxHp) * 0.5) return '致命';
    if (damage >= numeric(maxHp) * 0.3) return '重伤';
    if (damage >= numeric(maxHp) * 0.1) return '轻伤';
    return '擦伤';
}

function numeric(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
