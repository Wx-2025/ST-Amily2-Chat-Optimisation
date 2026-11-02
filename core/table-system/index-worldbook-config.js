import { normalizeQueryIndexes } from './query-indexes.js';

export const INDEX_WORLDBOOK_CONFIG_KEY = 'amily2_index_worldbook_v1';
export const INDEX_WORLDBOOK_CONFIG_LIMITS = Object.freeze({ bindings: 16, columns: 16, chars: 131072, signature: 16384 });
export function indexWorldbookError(code) { return Object.assign(new Error(code), { code }); }
const fail = () => { throw indexWorldbookError('INDEX_WORLDBOOK_CONFIG_INVALID'); };
export const validIndexWorldbookId = value => typeof value === 'string' && value.length > 0
    && value.length <= 128 && !/[\u0000-\u001f]/u.test(value);

// Read data descriptors, never invoke accessors from imported metadata.
function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!keys.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        output[key] = descriptor.value;
    }
    return output;
}
function list(value, max) {
    if (!Array.isArray(value) || value.length > max) fail();
    if (Reflect.ownKeys(value).length !== value.length + 1) fail();
    return Array.from({ length: value.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        return descriptor.value;
    });
}
function ids(value, max) {
    const values = list(value, max);
    if (!values.length || !values.every(validIndexWorldbookId) || new Set(values).size !== values.length) fail();
    return values;
}

export function normalizeIndexWorldbookBinding(raw) {
    const value = record(raw, ['tableId', 'groupId', 'indexId', 'contentColumnIds', 'primaryColumnId',
        'termSeparator', 'enabled', 'schemaSignature']);
    if (![value.tableId, value.groupId, value.indexId].every(validIndexWorldbookId)
        || typeof value.enabled !== 'boolean' || typeof value.schemaSignature !== 'string'
        || !value.schemaSignature.length || value.schemaSignature.length > INDEX_WORLDBOOK_CONFIG_LIMITS.signature) fail();
    if (value.primaryColumnId !== undefined && !validIndexWorldbookId(value.primaryColumnId)) fail();
    if (value.termSeparator !== undefined && (typeof value.termSeparator !== 'string'
        || value.termSeparator.length < 1 || value.termSeparator.length > 16)) fail();
    return { tableId: value.tableId, groupId: value.groupId, indexId: value.indexId,
        contentColumnIds: ids(value.contentColumnIds, INDEX_WORLDBOOK_CONFIG_LIMITS.columns),
        ...(value.primaryColumnId === undefined ? {} : { primaryColumnId: value.primaryColumnId }),
        ...(value.termSeparator === undefined ? {} : { termSeparator: value.termSeparator }),
        enabled: value.enabled, schemaSignature: value.schemaSignature };
}

export function normalizeIndexWorldbookOptions(raw) {
    const value = record(raw, ['indexId', 'contentColumnIds', 'primaryColumnId', 'termSeparator', 'enabled']);
    if (!validIndexWorldbookId(value.indexId) || typeof value.enabled !== 'boolean') fail();
    if (value.primaryColumnId !== undefined && !validIndexWorldbookId(value.primaryColumnId)) fail();
    if (value.termSeparator !== undefined && (typeof value.termSeparator !== 'string'
        || value.termSeparator.length < 1 || value.termSeparator.length > 16)) fail();
    return { ...value, contentColumnIds: ids(value.contentColumnIds, INDEX_WORLDBOOK_CONFIG_LIMITS.columns) };
}

export function normalizeIndexWorldbookConfig(raw, owner) {
    if (typeof owner !== 'string' || !owner.length || owner.length > 1024) fail();
    if (raw === undefined) return { version: 1, revision: 0, owner, bindings: [] };
    const value = record(raw, ['version', 'revision', 'owner', 'bindings']);
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || value.owner !== owner) fail();
    const bindings = list(value.bindings, INDEX_WORLDBOOK_CONFIG_LIMITS.bindings).map(normalizeIndexWorldbookBinding);
    const keys = bindings.map(item => JSON.stringify([item.groupId, item.tableId]));
    if (new Set(keys).size !== keys.length) fail();
    const result = { version: 1, revision: value.revision, owner, bindings };
    if (JSON.stringify(result).length > INDEX_WORLDBOOK_CONFIG_LIMITS.chars) fail();
    return result;
}

export function indexWorldbookSchemaSignature(table, indexId, contentColumnIds) {
    const definition = normalizeQueryIndexes(table).find(item => item.id === indexId);
    if (!definition || definition.mode !== 'keywords') throw indexWorldbookError('WORLDBOOK_MAPPING_UNSUPPORTED');
    const selected = [...new Set([...definition.columnIds, ...ids(contentColumnIds, 16)])];
    const columns = selected.map(id => {
        const column = table.columns.find(item => item.id === id);
        if (!column) fail();
        // Bind meaning as well as stable IDs; a renamed/retyped selected column requires reconfirmation.
        return { id, label: column.label ?? '', type: column.type ?? 'string',
            recordRelation: column.recordRelation ?? null, references: column.references ?? null };
    });
    // Index names are presentation only; all matching semantics remain bound.
    const { name: _name, ...matchingDefinition } = definition;
    const signature = JSON.stringify({ definition: matchingDefinition, columns });
    if (signature.length > INDEX_WORLDBOOK_CONFIG_LIMITS.signature) fail();
    return signature;
}

export function indexWorldbookSchemaMatches(signature, table, indexId, contentColumnIds) {
    const expected = indexWorldbookSchemaSignature(table, indexId, contentColumnIds);
    if (signature === expected) return true;
    if (typeof signature !== 'string' || signature.length > INDEX_WORLDBOOK_CONFIG_LIMITS.signature) return false;
    // Existing chat-local bindings included the display name. Accept only the
    // exact prior shape with that one field removed; never rewrite saved config.
    try {
        const legacy = JSON.parse(signature);
        const name = legacy?.definition?.name;
        if (typeof name !== 'string' || !name.trim() || name.length > 100) return false;
        delete legacy.definition.name;
        return JSON.stringify(legacy) === expected;
    } catch { return false; }
}

// Export only declarative preferences. Imports must obtain fresh local confirmation.
export function exportIndexWorldbookConfig(raw, owner) {
    const config = normalizeIndexWorldbookConfig(raw, owner);
    return { version: 1, bindings: config.bindings.map(({ schemaSignature: _signature, ...binding }) => ({ ...binding, enabled: false })) };
}
