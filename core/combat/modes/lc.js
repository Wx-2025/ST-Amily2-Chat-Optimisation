import { CombatReport } from '../report.js';

/**
 * LC (Limbus Company) coin resolution — deterministic, replayable.
 * Rules authority: docs/fight/rule.md (体系二) + 战斗数据层架构.md §5.
 *
 * Skill algorithm is exclusive (no mixing):
 *   - normal/unbreakable coins → S 阶段逐击累加 (cumulative hits)
 *   - multiply coins            → S 阶段逐次累乘 (cumulative multiplier)
 *   - subtract coins            → S 阶段逐击累加 with negative contribution
 */

// ── 技能解析 ──────────────────────────────────────────────────────

const COIN_TOKEN = /\{([^}]+)\}/g;

/**
 * Parse an LC skill formula into a normalized coin set.
 * Accepted formula shapes (examples):
 *   "{+4}{+4}{+4}"          → 3 normal coins, power +4
 *   "{×2}{×2}"              → 2 multiply coins (×2 each)
 *   "{×3}"                  → 1 multiply coin (×3)
 *   "{-12}{-12}{-12}"       → 3 subtract coins, divisor 12
 *   "{+2★}"                 → 1 unbreakable coin, power +2
 * Mixed shapes inside one skill are rejected (algorithm must be unique).
 */
export function parseLcSkill(skill) {
    const formula = String(skill?.formula ?? '').trim();
    if (!formula) throw new Error(`LC skill "${skill?.name ?? '?'}" has no formula.`);
    const rawCoins = [];
    for (const match of formula.matchAll(COIN_TOKEN)) {
        rawCoins.push(parseCoinToken(match[1].trim()));
    }
    if (!rawCoins.length) throw new Error(`LC skill "${skill?.name ?? '?'}" has no coins: ${formula}`);

    const algorithm = detectAlgorithm(rawCoins, skill?.name ?? '?');
    return {
        name: skill?.name ?? '未命名技能',
        basePower: numeric(skill?.basePower ?? skill?.base ?? skill?.基础威力, 0),
        coins: rawCoins,
        algorithm, // 'cumulative' | 'multiply'
        cost: skill?.cost ?? '-',
        speed: numeric(skill?.speed ?? skill?.速度, 0),
        effects: skill?.effects ?? '-',
    };
}

function parseCoinToken(token) {
    const unbreakable = token.endsWith('★');
    const core = unbreakable ? token.slice(0, -1).trim() : token;

    // multiply: ×N
    const mul = core.match(/^[×x]\s*(\d+(?:\.\d+)?)$/i);
    if (mul) {
        return { type: 'multiply', multiplier: Number(mul[1]), unbreakable };
    }
    // subtract: -N
    const sub = core.match(/^[-−]\s*(\d+(?:\.\d+)?)$/);
    if (sub) {
        return { type: 'subtract', divisor: Number(sub[1]), unbreakable };
    }
    // normal: +N
    const norm = core.match(/^[+]?\s*(\d+(?:\.\d+)?)$/);
    if (norm) {
        return { type: 'normal', power: Number(norm[1]), unbreakable };
    }
    throw new Error(`Unparseable LC coin token: "${token}"`);
}

function detectAlgorithm(coins, skillName) {
    const hasMultiply = coins.some(c => c.type === 'multiply');
    const hasOther = coins.some(c => c.type !== 'multiply');
    if (hasMultiply && hasOther) {
        throw new Error(`LC skill "${skillName}" mixes multiply coins with others — algorithm must be unique.`);
    }
    return hasMultiply ? 'multiply' : 'cumulative';
}

// ── SP / 正面率 ───────────────────────────────────────────────────

/**
 * LC sanity (SP) ∈ [-45, +45]. Heads probability = 50% + SP%.
 * Used by SeededRandom.chance() for deterministic coin flips.
 */
export function headsProbability(sanity) {
    const sp = clamp(numeric(sanity, 0), -45, 45);
    return clamp(0.5 + sp / 100, 0.05, 0.95);
}

// ── 等级优势（与 lor.js 同公式） ─────────────────────────────────

export function calculateLevelAdvantage(ownLevel, opposingLevel) {
    return Math.max(0, Math.floor((Number(ownLevel) - Number(opposingLevel)) / 3));
}

// ── R 阶段：拼点（一次投掷比总威力 → 破坏 → reflip） ─────────────

/**
 * Resolve the clash (R) phase: both sides flip all coins once, compare total
 * clash power; loser shatters one coin, may reflip remaining; repeat until one
 * side is exhausted, then hand off to the S (settlement) phase.
 *
 * Returns the surviving coin states for each side (coins still in play after R).
 */
function resolveClashPhase({ round, sequence, attacker, attackerSkill, defender, defenderSkill, rng, report }) {
    const attackAdvantage = calculateLevelAdvantage(attacker.attackLevel, defender.defenseLevel);
    const defenseAdvantage = calculateLevelAdvantage(defender.defenseLevel, attacker.attackLevel);
    const attackerCoins = attackerSkill.coins.map((coin, i) => ({ ...coin, index: i, alive: true, lastFace: null }));
    const defenderCoins = (defenderSkill?.coins ?? []).map((coin, i) => ({ ...coin, index: i, alive: true, lastFace: null }));

    let clashRound = 0; // actual clash rounds fought (for SP delta)
    while (attackerCoins.some(c => c.alive) && defenderCoins.some(c => c.alive)) {
        clashRound++;
        flipCoins(attackerCoins, attacker.sanity, rng, round, `A${clashRound}`, attacker.name);
        flipCoins(defenderCoins, defender.sanity, rng, round, `D${clashRound}`, defender.name);

        const attackTotal = clashPower(attackerSkill, attackerCoins, attackAdvantage);
        const defenseTotal = defenderCoins.length
            ? clashPower(defenderSkill, defenderCoins, defenseAdvantage)
            : 0;

        const result = attackTotal > defenseTotal ? 'Aw'
            : attackTotal < defenseTotal ? 'Bw'
            : 'Draw';

        const winnerName = result === 'Aw' ? attacker.name : result === 'Bw' ? defender.name : null;
        const tags = clashTags(result, Math.abs(attackTotal - defenseTotal), attacker.name, defender.name);

        report.addClash({
            sequence: sequence.value++,
            attacker: attacker.name,
            attackerValues: coinContributionList(attackerSkill, attackerCoins),
            defender: defender.name,
            defenderValues: coinContributionList(defenderSkill, defenderCoins),
            result,
            tags,
            note: `${attackTotal} vs ${defenseTotal}`,
        });

        if (result === 'Draw') break;

        // loser shatters one coin
        const loserCoins = result === 'Aw' ? defenderCoins : attackerCoins;
        const loserSkill = result === 'Aw' ? defenderSkill : attackerSkill;
        const loserName = result === 'Aw' ? defender.name : attacker.name;
        const shattered = shatterOne(loserCoins, loserSkill, rng, round, loserName);
        if (!shattered) {
            // all remaining are unbreakable → clamp to 1 and stop clashing
            break;
        }
    }

    return { attackerCoins, defenderCoins, attackAdvantage, defenseAdvantage, clashRounds: clashRound };
}

// ── SP 变动规则（R 阶段拼点胜负驱动） ──────────────────────────────

/**
 * Skill polarity: subtract-only skills are 'inverse' (SP delta flipped),
 * everything else (normal/multiply/unbreakable) is 'normal'.
 * Inverse lets a subtract build 'win → go madder (SP↓ → subtract hits harder)',
 * mirroring the normal build's 'win → sharper (SP↑ → heads rate↑)'.
 */
function skillPolarity(skill) {
    const coins = skill?.coins ?? [];
    if (!coins.length) return 'normal';
    return coins.every(c => c.type === 'subtract') ? 'inverse' : 'normal';
}

/**
 * SP delta from clash outcome.
 *   winner: +(10 + clashRounds)
 *   loser:  -(clashRounds)
 * Inverse polarity flips both signs (subtract-build snowball in reverse).
 */
function clashSpDelta({ won, polarity, clashRounds }) {
    const rounds = Math.max(1, numeric(clashRounds, 1));
    let delta = won ? (10 + rounds) : -rounds;
    if (polarity === 'inverse') delta = -delta;
    return delta;
}

function flipCoins(coins, sanity, rng, round, sideLabel, actorName) {
    const prob = headsProbability(sanity);
    for (const coin of coins) {
        if (!coin.alive) continue;
        const label = `LC:R${round}:${sideLabel}:coin${coin.index + 1}@${actorName}`;
        coin.lastFace = rng.chance(prob, label) ? 'heads' : 'tails';
    }
}

/** Per-coin clash contribution (multiply → ×N on heads; others → power/-divisor). */
function coinClashContribution(skill, coin) {
    if (!coin.alive) return null;
    if (coin.lastFace === 'tails') return skill.algorithm === 'multiply' ? 1 : 0;
    // heads
    if (coin.type === 'multiply') return coin.multiplier;
    if (coin.type === 'subtract') return -coin.divisor;
    return coin.power; // normal / unbreakable
}

/** Total clash power for a side (not damage — only decides win/loss & shatter). */
function clashPower(skill, coins, advantage) {
    if (skill.algorithm === 'multiply') {
        // 基础点数 × Π(倍率) + 等级优势
        let product = skill.basePower;
        for (const coin of coins) {
            if (!coin.alive) continue;
            const v = coinClashContribution(skill, coin);
            product *= (v ?? 1);
        }
        return product + advantage;
    }
    // cumulative: 基础 + Σ(贡献) + 硬币数×优势
    let sum = skill.basePower;
    let aliveCount = 0;
    for (const coin of coins) {
        if (!coin.alive) continue;
        aliveCount++;
        sum += coinClashContribution(skill, coin) ?? 0;
    }
    return sum + aliveCount * advantage;
}

/** Formatted contribution list for report [a+b+c]; null → '—', 0 stays. */
function coinContributionList(skill, coins) {
    return coins.map(coin => coinClashContribution(skill, coin));
}

/**
 * Shatter one normal/subtract coin (loser's side). Unbreakable coins are not
 * shattered — their contribution is clamped to 1 in S phase instead. Returns
 * true if a coin was shattered, false if none could be (all unbreakable).
 */
function shatterOne(coins, skill, rng, round, actorName) {
    const breakable = coins.find(c => c.alive && !c.unbreakable && c.type !== 'multiply');
    if (!breakable) {
        // multiply-unbreakable or all-unbreakable: no shatter, clamp in S phase
        return false;
    }
    breakable.alive = false;
    breakable.lastFace = null;
    return true;
}

// ── S 阶段：攻击结算（SP 先结算 → 逐枚重投锁定 → 按算法结算） ────

/**
 * Resolve the settlement (S) phase for the winning side's surviving coins
 * striking the losing side. Strict order:
 *   1. settle SP changes from clash outcome
 *   2. re-flip surviving coins with the post-SP heads probability
 *   3. each coin locks after flipping → one hit/attack
 *   4. compute damage by algorithm (cumulative hits / cumulative multiplier)
 *   5. level advantage applied once to total damage (not per hit)
 */
function resolveSettlementPhase({ round, sequence, striker, strikerSkill, strikerCoins, target, advantage, spDelta, report }) {
    // ① SP settlement
    const sanityBefore = striker.sanity;
    const sanityAfter = clamp(numeric(striker.sanity, 0) + numeric(spDelta, 0), -45, 45);
    report.addSettlement({
        sequence: sequence.value++,
        actor: striker.name,
        change: sanityAfter !== sanityBefore ? `SP${sanityAfter > sanityBefore ? '+' : ''}${sanityAfter - sanityBefore}` : '',
        tags: sanityAfter > sanityBefore ? ['士气高涨'] : sanityAfter < sanityBefore ? ['士气下挫'] : [],
    });

    // ② re-flip surviving coins with post-SP probability, lock each
    const surviving = strikerCoins.filter(c => c.alive);
    const prob = headsProbability(sanityAfter);
    for (const coin of surviving) {
        const label = `LC:S${round}:coin${coin.index + 1}@${striker.name}`;
        coin.lastFace = rng.chance(prob, label) ? 'heads' : 'tails';
        coin.locked = true;
    }

    // ④ damage by algorithm
    let totalDamage;
    if (strikerSkill.algorithm === 'multiply') {
        totalDamage = settleMultiply(strikerSkill, surviving, round, sequence, striker.name, report);
    } else {
        totalDamage = settleCumulative(strikerSkill, surviving, advantage, round, sequence, striker.name, report);
    }

    // ⑤ level advantage applied once to total
    if (strikerSkill.algorithm === 'multiply') {
        totalDamage += advantage;
    }
    // cumulative already bakes advantage into each hit per rule.md

    return { damage: Math.max(0, totalDamage), sanityAfter };
}

/** S 阶段 · 乘算逐次累乘: 投一枚→锁定→一次攻击；未投=×1。 */
function settleMultiply(skill, surviving, round, sequence, actorName, report) {
    let lockedProduct = 1;
    let total = 0;
    surviving.forEach((coin, i) => {
        const multiplier = coin.lastFace === 'heads' ? coin.multiplier : 1;
        lockedProduct *= multiplier;
        const hitPower = skill.basePower * lockedProduct;
        total += hitPower;
        report.addSettlement({
            sequence: sequence.value++,
            actor: actorName,
            values: [`${skill.basePower}×${formatProduct(coin, lockedProduct)}`],
            tags: i === 0
                ? [multiplier > 1 ? '倍率爆发' : '爆发落空']
                : [multiplier > 1 ? '倍率爆发' : '爆发落空', '累乘'],
        });
    });
    return total;
}

/** S 阶段 · 逐击累加 (普通/不可破坏/减算): 第i击=基础+Σ(前i枚贡献)+优势。 */
function settleCumulative(skill, surviving, advantage, round, sequence, actorName, report) {
    let runningSum = 0;
    let total = 0;
    surviving.forEach((coin, i) => {
        const contribution = coinContribution(skill, coin);
        runningSum += contribution;
        const hitPower = skill.basePower + runningSum + advantage;
        total += hitPower;
        report.addSettlement({
            sequence: sequence.value++,
            actor: actorName,
            values: [skill.basePower, ...surviving.slice(0, i + 1).map(c => coinContribution(skill, c))],
            tags: [injuryTag(hitPower), i > 0 ? '累加' : ''].filter(Boolean),
        });
    });
    return total;
}

/** Per-coin settlement contribution (unbreakable shattered in R → 1). */
function coinContribution(skill, coin) {
    if (coin.unbreakable && coin.clampedTo1) return 1;
    if (coin.lastFace === 'tails') return 0;
    if (coin.type === 'subtract') return -coin.divisor;
    return coin.power; // normal / unbreakable
}

// ── 总入口 ────────────────────────────────────────────────────────

/**
 * Deterministically resolve one LC clash + settlement.
 * @param {object} args
 * @param {number} args.round
 * @param {object} args.attacker    combatant (attacker)
 * @param {object} args.attackerSkill  LC skill object {name, formula, basePower, ...}
 * @param {object} args.defender    combatant (defender)
 * @param {object|null} args.defenderSkill  LC defense skill, or null (unopposed)
 * @param {SeededRandom} args.rng   deterministic random source
 */
export function resolveLcAction({ round, attacker, attackerSkill, defender, defenderSkill = null, rng }) {
    if (!rng || typeof rng.chance !== 'function') throw new Error('LC resolution requires a deterministic random source (rng.chance).');
    if (!attacker || !defender) throw new Error('LC resolution requires attacker and defender.');

    const aSkill = parseLcSkill(attackerSkill);
    const dSkill = defenderSkill ? parseLcSkill(defenderSkill) : null;

    const report = new CombatReport(round);
    const sequence = { value: 1 };

    const { attackerCoins, defenderCoins, attackAdvantage, defenseAdvantage, clashRounds } = resolveClashPhase({
        round, sequence, attacker, attackerSkill: aSkill, defender, defenderSkill: dSkill, rng, report,
    });

    // determine clash winner
    const attackerAlive = attackerCoins.some(c => c.alive);
    const defenderAlive = defenderCoins.some(c => c.alive);
    const attackerWins = attackerAlive && !defenderAlive;
    const defenderWins = defenderAlive && !attackerAlive;

    // clamp unbreakable coins that survived R without shatter (contribution → 1 in S)
    [attackerCoins, defenderCoins].forEach(coins => {
        coins.forEach(c => {
            if (c.alive && c.unbreakable) c.clampedTo1 = true;
        });
    });

    // SP delta from clash outcome: winner +(10+rounds), loser -(rounds);
    // inverse-polarity (subtract-only) build flips both signs.
    // Unopposed (no defender skill) = attacker win with 1 clash round.
    const effectiveRounds = dSkill ? clashRounds : 1;
    const aPolarity = skillPolarity(aSkill);
    const dPolarity = skillPolarity(dSkill);
    let spDeltaAttacker = dSkill
        ? clashSpDelta({ won: attackerWins, polarity: aPolarity, clashRounds: effectiveRounds })
        : clashSpDelta({ won: true, polarity: aPolarity, clashRounds: 1 });
    let spDeltaDefender = dSkill
        ? clashSpDelta({ won: defenderWins, polarity: dPolarity, clashRounds: effectiveRounds })
        : 0;

    let damageToAttacker = 0;
    let damageToDefender = 0;

    // S phase: only the side that still has coins AND won (or is unopposed) strikes
    if (attackerWins || (attackerAlive && !dSkill)) {
        const result = resolveSettlementPhase({
            round, sequence,
            striker: attacker, strikerSkill: aSkill, strikerCoins: attackerCoins,
            target: defender, advantage: attackAdvantage, spDelta: spDeltaAttacker, report,
        });
        damageToDefender = result.damage;
    } else if (defenderWins) {
        const result = resolveSettlementPhase({
            round, sequence,
            striker: defender, strikerSkill: dSkill, strikerCoins: defenderCoins,
            target: attacker, advantage: defenseAdvantage, spDelta: spDeltaDefender, report,
        });
        damageToAttacker = result.damage;
    } else {
        // Draw or mutual survival: settle SP only
        report.addSettlement({
            sequence: sequence.value++,
            actor: attacker.name,
            change: '',
            tags: ['势均'],
        });
    }

    const nextAttacker = applyDamage(attacker, damageToAttacker);
    const nextDefender = applyDamage(defender, damageToDefender);
    nextAttacker.sanity = clamp(numeric(attacker.sanity, 0) + spDeltaAttacker, -45, 45);
    nextDefender.sanity = clamp(numeric(defender.sanity, 0) + spDeltaDefender, -45, 45);

    return {
        mode: 'LC',
        round,
        attacker: nextAttacker,
        defender: nextDefender,
        attackerSkill: aSkill.name,
        defenderSkill: dSkill?.name ?? null,
        damage: { toAttacker: damageToAttacker, toDefender: damageToDefender },
        spDelta: { attacker: spDeltaAttacker, defender: spDeltaDefender },
        flags: { attackerWins, defenderWins, draw: !attackerWins && !defenderWins },
        report,
        reportText: report.toText(),
    };
}

// ── 辅助 ──────────────────────────────────────────────────────────

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
    const loser = result === 'Aw' ? defenderName : attackerName;
    if (delta >= 10) return [`${winner}碾压`, `${loser}招式被打散`];
    if (delta >= 4) return [`${winner}压制`, `${loser}招式被打散`];
    return [`${winner}险胜`, `${loser}招式被打散`];
}

function injuryTag(damage) {
    if (damage >= 20) return '致命';
    if (damage >= 12) return '重伤';
    if (damage >= 5) return '轻伤';
    return '擦伤';
}

function formatProduct(coin, lockedProduct) {
    // render like "1×2" so the report shows base×product context compactly
    return coin.lastFace === 'heads' ? `…×${coin.multiplier}=${lockedProduct}` : `…×1=${lockedProduct}`;
}

function numeric(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
