/**
 * Deterministic random source for combat resolution and replay.
 * Never use Math.random() inside combat rules.
 */
export class SeededRandom {
    constructor(seed = `${Date.now()}`) {
        this.seed = String(seed);
        this._state = hashSeed(this.seed);
        this.draws = [];
    }

    next(label = '') {
        let state = this._state += 0x6D2B79F5;
        state = Math.imul(state ^ (state >>> 15), state | 1);
        state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
        const value = ((state ^ (state >>> 14)) >>> 0) / 4294967296;
        this.draws.push({ label, value });
        return value;
    }

    int(min, max, label = '') {
        if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
            throw new Error(`Invalid integer range: ${min}..${max}`);
        }
        return min + Math.floor(this.next(label) * (max - min + 1));
    }

    chance(probability, label = '') {
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
            throw new Error(`Invalid probability: ${probability}`);
        }
        return this.next(label) < probability;
    }
}

function hashSeed(seed) {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
