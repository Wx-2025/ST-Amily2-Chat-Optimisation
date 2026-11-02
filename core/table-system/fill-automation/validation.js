export const LIMITS = Object.freeze({
    profiles: 32, tables: 128, columns: 128, messages: 10000,
    coverage: 512, tasks: 128, dependencies: 128, requests: 16,
    inputTokens: 131072, outputTokens: 32768, runTokens: 524288, configCharacters: 262144,
});

export function fail(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
}

export function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_OBJECT');
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !keys.includes(key)
            || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
            fail('UNKNOWN_OR_UNSAFE_FIELD');
        }
    }
    return value;
}

export function integer(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER');
    return value;
}

export function boolean(value) {
    if (typeof value !== 'boolean') fail('INVALID_BOOLEAN');
    return value;
}

export function choice(value, choices) {
    if (!choices.includes(value)) fail('INVALID_ENUM');
    return value;
}

export function defaultValue(value, fallback) {
    return value === undefined ? fallback : value;
}

export function id(value, max = 128) {
    if (typeof value !== 'string' || !value.length || value.length > max
        || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
        || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('INVALID_ID');
    return value;
}

export function list(value, max, normalize, min = 0) {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail('INVALID_LIST');
    const result = [];
    for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_LIST');
        result.push(normalize(descriptor.value));
    }
    return result;
}

export function unique(values, key = value => value) {
    if (new Set(values.map(key)).size !== values.length) fail('DUPLICATE_ID');
    return values;
}

export function ids(value, max = LIMITS.coverage, min = 0) {
    return unique(list(value, max, item => id(item), min));
}

export function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

export function sameIds(left, right) {
    return left.length === right.length && left.every(value => right.includes(value));
}

export function key(parts) {
    // JSON tuples are unambiguous identities, not lossy hashes or secret-bearing logs.
    return JSON.stringify(parts);
}
