/**
 * Private lifecycle channel for real table-fill starts.
 *
 * The compatibility facade only receives a subscription. It never exposes a
 * dispatch method, so card scripts cannot forge the legacy fill-start event.
 */

const VALID_MODES = new Set(['main-api', 'secondary-api', 'batch', 'floor-range']);
const subscribers = new Set();

/**
 * Publish a validated, immutable lifecycle record from a canonical fill entry.
 *
 * @param {{ mode: string, startFloor?: number, endFloor?: number }} event
 * @returns {number} number of internal subscribers invoked
 */
export function dispatchTableFillStart(event) {
    const snapshot = normalizeTableFillStart(event);
    const currentSubscribers = [...subscribers];
    for (const subscriber of currentSubscribers) {
        try {
            const result = subscriber(snapshot);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch(error => {
                    console.error('[TableFillLifecycle] async subscriber failed:', error);
                });
            }
        } catch (error) {
            console.error('[TableFillLifecycle] subscriber failed:', error);
        }
    }
    return currentSubscribers.length;
}

/**
 * @param {(event: Readonly<object>) => void} subscriber
 * @returns {() => boolean} unsubscribe function
 */
export function subscribeTableFillStarts(subscriber) {
    if (typeof subscriber !== 'function') {
        throw new TypeError('[TableFillLifecycle] subscriber must be a function.');
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
}

function normalizeTableFillStart(event) {
    if (!isPlainObject(event) || !VALID_MODES.has(event.mode)) {
        throw new TypeError('[TableFillLifecycle] event mode is invalid.');
    }
    const hasStart = Object.hasOwn(event, 'startFloor');
    const hasEnd = Object.hasOwn(event, 'endFloor');
    if (hasStart !== hasEnd) {
        throw new TypeError('[TableFillLifecycle] floor bounds must be supplied together.');
    }
    if (!hasStart) return Object.freeze({ mode: event.mode });
    if (!Number.isSafeInteger(event.startFloor)
        || !Number.isSafeInteger(event.endFloor)
        || event.startFloor < 1
        || event.endFloor < event.startFloor) {
        throw new TypeError('[TableFillLifecycle] floor bounds are invalid.');
    }
    return Object.freeze({
        mode: event.mode,
        startFloor: event.startFloor,
        endFloor: event.endFloor,
    });
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
