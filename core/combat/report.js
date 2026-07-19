/** Build the deterministic engine report consumed by the LLM renderer. */
export class CombatReport {
    constructor(round) {
        this.round = round;
        this.events = [];
    }

    addClash({ sequence, attacker, attackerValues, defender, defenderValues, result, tags = [], note = '' }) {
        this.events.push({
            kind: 'clash', sequence, attacker, attackerValues, defender, defenderValues, result, tags, note,
        });
        return this;
    }

    addSettlement({ sequence, actor, values = [], change = '', tags = [], note = '' }) {
        this.events.push({ kind: 'settlement', sequence, actor, values, change, tags, note });
        return this;
    }

    toLines() {
        return this.events.map(event => formatEvent(this.round, event));
    }

    toText() {
        return this.toLines().join('\n');
    }
}

export function formatEvent(round, event) {
    const prefix = event.kind === 'clash' ? 'R' : 'S';
    const identifier = `${prefix}${round}-${event.sequence}`;
    const tags = formatTags(event.tags);
    const note = event.note ? ` // ${event.note}` : '';

    if (event.kind === 'clash') {
        return `${identifier}: ${event.attacker}:[${formatValues(event.attackerValues)}] - ${event.defender}:[${formatValues(event.defenderValues)}] (${event.result})${tags}${note}`;
    }
    if (event.change) {
        return `${identifier}: ${event.actor}:(${event.change})${tags}${note}`;
    }
    return `${identifier}: ${event.actor}:[${formatValues(event.values)}]${tags}${note}`;
}

function formatValues(values) {
    return (values || []).map(value => value === null || value === undefined ? '—' : value).join('+');
}

function formatTags(tags) {
    const normalized = (tags || []).map(String).map(tag => tag.trim()).filter(Boolean);
    return normalized.length ? ` ⟦${normalized.join('·')}⟧` : '';
}
