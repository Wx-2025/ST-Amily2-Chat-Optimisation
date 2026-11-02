import { normalizeFillAutomationConfig } from './config.js';
import { LIMITS, fail, freeze, id, record } from './validation.js';

const FORMAT = 'amily2.fill-preset';

export function exportFillPreset(rawConfig) {
    const config = normalizeFillAutomationConfig(rawConfig);
    const slots = new Map();
    const profiles = config.profiles.map(profile => {
        if (!slots.has(profile.connectionRef)) slots.set(profile.connectionRef, `connection-${slots.size + 1}`);
        return { ...profile, revision: 1, connectionRef: slots.get(profile.connectionRef) };
    });
    return freeze({ format: FORMAT, version: 1,
        config: normalizeFillAutomationConfig({ ...config, revision: 1, profiles }) });
}

export function readFillPreset(input) {
    let raw = input;
    if (typeof input === 'string') {
        if (input.length > LIMITS.configCharacters + 1024) fail('FILL_PRESET_LIMIT');
        try { raw = JSON.parse(input); } catch { fail('FILL_PRESET_INVALID'); }
    }
    record(raw, ['format', 'version', 'config']);
    if (raw.format !== FORMAT || raw.version !== 1) fail('FILL_PRESET_VERSION');
    const config = normalizeFillAutomationConfig(raw.config);
    if (config.profiles.some(profile => !/^connection-[1-9]\d*$/.test(profile.connectionRef))) fail('FILL_PRESET_CONNECTION');
    return freeze({ format: FORMAT, version: 1, config });
}

export function describeFillPreset(input) {
    const { config } = readFillPreset(input);
    const tables = new Map();
    for (const binding of config.bindings) tables.set(binding.tableId, new Set());
    for (const binding of config.bindings.filter(binding => binding.compression)) {
        tables.get(binding.tableId).add(binding.compression.targetColumnId);
        if (!tables.has(binding.compression.sourceTableId)) tables.set(binding.compression.sourceTableId, new Set());
        binding.compression.sourceColumnIds.forEach(columnId => tables.get(binding.compression.sourceTableId).add(columnId));
    }
    for (const profile of config.profiles) for (const scope of [...profile.readScopes, ...profile.writeScopes]) {
        if (!tables.has(scope.tableId)) tables.set(scope.tableId, new Set());
        scope.columnIds.forEach(columnId => tables.get(scope.tableId).add(columnId));
    }
    return freeze({ connections: [...new Set(config.profiles.map(profile => profile.connectionRef))],
        tables: [...tables].map(([tableId, columns]) => ({ tableId, columnIds: [...columns] })) });
}

// No name/ID matching: every foreign connection, table and column requires an explicit local choice.
export function prepareFillPresetImport(input, { currentConfig, mappings, connections, tables }) {
    const imported = readFillPreset(input).config;
    const current = normalizeFillAutomationConfig(currentConfig);
    record(mappings, ['connections', 'tables']);
    if (!Array.isArray(mappings.connections) || !Array.isArray(mappings.tables)
        || mappings.connections.length > LIMITS.profiles || mappings.tables.length > LIMITS.tables) fail('FILL_PRESET_MAPPING');
    const required = describeFillPreset(input);
    const connectionMap = new Map();
    for (const mapping of mappings.connections) {
        record(mapping, ['slot', 'connectionRef']); id(mapping.slot); id(mapping.connectionRef);
        const local = connections.find(connection => connection.connectionRef === mapping.connectionRef);
        if (!required.connections.includes(mapping.slot) || connectionMap.has(mapping.slot) || !local?.model) fail('FILL_PRESET_MAPPING');
        connectionMap.set(mapping.slot, local);
    }
    if (connectionMap.size !== required.connections.length) fail('FILL_PRESET_MAPPING');
    const tableMap = new Map();
    const targets = new Set();
    for (const mapping of mappings.tables) {
        record(mapping, ['sourceTableId', 'targetTableId', 'columns']);
        const source = required.tables.find(table => table.tableId === mapping.sourceTableId);
        const target = tables.find(table => table.tableId === mapping.targetTableId);
        if (!source || !target || tableMap.has(source.tableId) || targets.has(target.tableId)
            || !Array.isArray(mapping.columns) || mapping.columns.length !== source.columnIds.length) fail('FILL_PRESET_MAPPING');
        const columns = new Map();
        for (const column of mapping.columns) {
            record(column, ['sourceColumnId', 'targetColumnId']);
            if (!source.columnIds.includes(column.sourceColumnId) || columns.has(column.sourceColumnId)
                || [...columns.values()].includes(column.targetColumnId)
                || !target.columns.some(item => item.id === column.targetColumnId)) fail('FILL_PRESET_MAPPING');
            columns.set(column.sourceColumnId, column.targetColumnId);
        }
        targets.add(target.tableId);
        tableMap.set(source.tableId, { target, columns });
    }
    if (tableMap.size !== required.tables.length) fail('FILL_PRESET_MAPPING');
    const remapScope = scope => ({ tableId: tableMap.get(scope.tableId).target.tableId,
        columnIds: scope.columnIds.map(columnId => tableMap.get(scope.tableId).columns.get(columnId)) });
    const profiles = imported.profiles.map(profile => {
        const groups = new Set([...profile.readScopes, ...profile.writeScopes]
            .map(scope => tableMap.get(scope.tableId).target.tableGroupId));
        if (groups.size !== 1) fail('FILL_PRESET_GROUP');
        const connection = connectionMap.get(profile.connectionRef);
        return { ...profile, revision: (current.profiles.find(item => item.profileId === profile.profileId)?.revision ?? 0) + 1,
            tableGroupId: [...groups][0], connectionRef: connection.connectionRef, model: connection.model,
            readScopes: profile.readScopes.map(remapScope), writeScopes: profile.writeScopes.map(remapScope) };
    });
    const bindings = imported.bindings.map(binding => ({ ...binding,
        tableId: tableMap.get(binding.tableId).target.tableId,
        ...(binding.compression ? { compression: { ...binding.compression,
            sourceTableId: tableMap.get(binding.compression.sourceTableId).target.tableId,
            sourceColumnIds: binding.compression.sourceColumnIds.map(columnId => tableMap.get(binding.compression.sourceTableId).columns.get(columnId)),
            targetColumnId: tableMap.get(binding.tableId).columns.get(binding.compression.targetColumnId) } } : {}),
        cycle: { ...binding.cycle, automaticEnabled: false } }));
    const config = normalizeFillAutomationConfig({ ...imported, revision: current.revision + 1, profiles, bindings });
    return freeze({ config, expectedRevision: current.revision, automaticDisabled: true,
        affectedTableIds: [...new Set([...current.bindings.map(binding => binding.tableId), ...bindings.map(binding => binding.tableId)])] });
}
