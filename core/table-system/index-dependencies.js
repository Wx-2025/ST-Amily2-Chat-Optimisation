import { normalizeQueryIndexes } from './query-indexes.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const stable = value => JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
});

export function captureIndexDependencies(table, { rules, worldbook }) {
    if (!Array.isArray(rules) || !Array.isArray(worldbook)) fail('INDEX_DEPENDENCIES_UNAVAILABLE');
    const select = items => items.filter(item => item.tableId === table.id && item.groupId === table.groupId);
    const dependencies = [...select(rules).map(item => ({ ...item, kind: 'memory-rule', enabled: true })),
        ...select(worldbook)];
    if (dependencies.some(item => typeof item.indexId !== 'string' || !item.indexId
        || typeof item.enabled !== 'boolean')) fail('INDEX_DEPENDENCIES_UNAVAILABLE');
    return structuredClone({ tableId: table.id, groupId: table.groupId,
        dependencies: dependencies.sort((a, b) => stable(a).localeCompare(stable(b))) });
}

export function assertIndexDependencySnapshot(expected, current) {
    if (stable(expected) !== stable(current)) fail('INDEX_DEPENDENCIES_STALE');
}

export function assertIndexChangesAllowed(table, definitions, snapshot) {
    if (snapshot?.tableId !== table.id || snapshot?.groupId !== table.groupId
        || !Array.isArray(snapshot.dependencies)) fail('INDEX_DEPENDENCIES_UNAVAILABLE');
    const before = normalizeQueryIndexes(table);
    const after = normalizeQueryIndexes(table, definitions);
    // Display-only renames do not change query matching semantics.
    const semantics = ({ name, ...definition }) => stable(definition);
    const changed = new Set([...before, ...after].filter(index => {
        const previous = before.find(item => item.id === index.id);
        const next = after.find(item => item.id === index.id);
        return !previous || !next || semantics(next) !== semantics(previous);
    }).map(index => index.id));
    if (snapshot.dependencies.some(item => item.enabled && changed.has(item.indexId))) {
        fail('INDEX_DEPENDENCY_ACTIVE');
    }
    return after;
}
