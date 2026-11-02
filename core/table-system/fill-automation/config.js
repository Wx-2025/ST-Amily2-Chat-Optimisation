import { LIMITS, boolean, choice, defaultValue, fail, freeze, id, ids, integer, list, record, unique } from './validation.js';

export const FILL_AUTOMATION_FORMAT = 'amily2.fill-automation';
export const FILL_AUTOMATION_VERSION = 1;
export { LIMITS as FILL_AUTOMATION_LIMITS } from './validation.js';

export function normalizeFillCycle(raw = {}) {
    record(raw, ['mode', 'every', 'start', 'automaticEnabled']);
    const mode = choice(defaultValue(raw.mode, 'inherit'), ['inherit', 'manual', 'visible-messages', 'ai-replies']);
    const automaticEnabled = boolean(defaultValue(raw.automaticEnabled, false));
    if (mode === 'inherit' || mode === 'manual') {
        if (raw.every !== undefined || raw.start !== undefined || automaticEnabled) fail('INVALID_CYCLE');
        return freeze({ mode, automaticEnabled: false });
    }
    return freeze({
        mode, automaticEnabled,
        every: integer(raw.every, 1, LIMITS.coverage),
        start: integer(defaultValue(raw.start, 1), 1, LIMITS.messages),
    });
}

function normalizeScope(raw) {
    record(raw, ['tableId', 'columnIds']);
    return { tableId: id(raw.tableId), columnIds: ids(raw.columnIds, LIMITS.columns, 1).sort() };
}

export function normalizeFillProfile(raw) {
    record(raw, ['profileId', 'revision', 'tableGroupId', 'connectionRef', 'model', 'protocol',
        'parameters', 'promptRef', 'promptText', 'readScopes', 'writeScopes', 'inputTokenBudget', 'outputTokenBudget']);
    const promptRef = id(raw.promptRef);
    if (promptRef === 'profile') {
        if (typeof raw.promptText !== 'string' || !raw.promptText.trim() || raw.promptText.length > 16384) fail('INVALID_FILL_PROMPT');
    } else if (raw.promptText !== undefined) fail('INVALID_FILL_PROMPT_REFERENCE');
    const parameters = defaultValue(raw.parameters, {});
    record(parameters, ['temperature', 'topP']);
    const normalizedParameters = {};
    for (const [name, max] of [['temperature', 2], ['topP', 1]]) {
        if (parameters[name] === undefined) continue;
        const value = parameters[name];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail('INVALID_MODEL_PARAMETER');
        normalizedParameters[name] = value;
    }
    return freeze({
        profileId: id(raw.profileId), revision: integer(raw.revision, 1, Number.MAX_SAFE_INTEGER),
        tableGroupId: id(raw.tableGroupId), connectionRef: id(raw.connectionRef),
        model: id(raw.model), protocol: choice(raw.protocol, ['legacy-index', 'stable-selector']),
        parameters: normalizedParameters, promptRef,
        ...(promptRef === 'profile' ? { promptText: raw.promptText } : {}),
        readScopes: unique(list(raw.readScopes, LIMITS.tables, normalizeScope), scope => scope.tableId)
            .sort((a, b) => a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0),
        writeScopes: unique(list(raw.writeScopes, LIMITS.tables, normalizeScope, 1), scope => scope.tableId)
            .sort((a, b) => a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0),
        inputTokenBudget: integer(raw.inputTokenBudget, 1, LIMITS.inputTokens),
        outputTokenBudget: integer(raw.outputTokenBudget, 1, LIMITS.outputTokens),
    });
}

export function normalizeFillBinding(raw) {
    record(raw, ['tableId', 'mode', 'profileRef', 'cycle', 'commitUnit', 'compression']);
    const mode = choice(defaultValue(raw.mode, 'inherit'), ['inherit', 'profile']);
    if (mode === 'inherit' && raw.profileRef !== undefined) fail('INVALID_PROFILE_REFERENCE');
    const commit = defaultValue(raw.commitUnit, { mode: 'inherit' });
    record(commit, ['mode', 'unitId']);
    choice(commit.mode, ['inherit', 'independent']);
    if (commit.mode === 'inherit' && commit.unitId !== undefined) fail('INVALID_COMMIT_UNIT');
    let compression;
    if (raw.compression !== undefined) {
        record(raw.compression, ['sourceTableId', 'sourceColumnIds', 'targetColumnId', 'maxOutputChars']);
        compression = { sourceTableId: id(raw.compression.sourceTableId),
            sourceColumnIds: ids(raw.compression.sourceColumnIds, 32, 1).sort(),
            targetColumnId: id(raw.compression.targetColumnId), maxOutputChars: integer(raw.compression.maxOutputChars, 1, 16000) };
        if (compression.sourceTableId === raw.tableId || raw.cycle?.mode !== 'visible-messages'
            || commit.mode !== 'independent') fail('FILL_COMPRESSION_CONFIG');
    }
    return freeze({
        tableId: id(raw.tableId), mode,
        ...(mode === 'profile' ? { profileRef: id(raw.profileRef) } : {}),
        cycle: normalizeFillCycle(raw.cycle),
        ...(compression ? { compression } : {}),
        commitUnit: commit.mode === 'inherit' ? { mode: 'inherit' }
            : { mode: 'independent', unitId: id(commit.unitId) },
    });
}

export function normalizeFillAutomationConfig(raw) {
    if (raw === undefined) raw = {
        format: FILL_AUTOMATION_FORMAT, version: 1, revision: 1, profiles: [], bindings: [],
    };
    record(raw, ['format', 'version', 'revision', 'profiles', 'bindings', 'limits']);
    if (raw.format !== FILL_AUTOMATION_FORMAT || raw.version !== 1) fail('UNSUPPORTED_FILL_AUTOMATION_CONFIG');
    const profiles = unique(list(raw.profiles, LIMITS.profiles, normalizeFillProfile), value => value.profileId);
    const bindings = unique(list(raw.bindings, LIMITS.tables, normalizeFillBinding), value => value.tableId);
    for (const binding of bindings) {
        if (binding.mode === 'profile' && !profiles.some(profile => profile.profileId === binding.profileRef)) {
            fail('UNKNOWN_FILL_PROFILE');
        }
        if (binding.compression && bindings.some(source => source.tableId === binding.compression.sourceTableId && source.compression)) {
            fail('FILL_COMPRESSION_SOURCE');
        }
    }
    const limits = defaultValue(raw.limits, {});
    record(limits, ['maxRequests', 'maxTokens', 'maxRetries']);
    const normalized = {
        format: FILL_AUTOMATION_FORMAT, version: 1,
        revision: integer(raw.revision, 1, Number.MAX_SAFE_INTEGER), profiles, bindings,
        limits: {
            maxRequests: integer(defaultValue(limits.maxRequests, 8), 1, LIMITS.requests),
            maxTokens: integer(defaultValue(limits.maxTokens, 131072), 1, LIMITS.runTokens),
            maxRetries: integer(defaultValue(limits.maxRetries, 0), 0, 3),
        },
    };
    if (JSON.stringify(normalized).length > LIMITS.configCharacters) fail('CONFIG_SIZE_LIMIT');
    return freeze(normalized);
}

export function resolveFillProfile(rawConfig, tableId, inheritedProfile) {
    const config = normalizeFillAutomationConfig(rawConfig);
    id(tableId);
    const binding = config.bindings.find(item => item.tableId === tableId)
        ?? normalizeFillBinding({ tableId });
    const profile = binding.mode === 'inherit' ? normalizeFillProfile(inheritedProfile)
        : config.profiles.find(item => item.profileId === binding.profileRef);
    if (!profile.writeScopes.some(scope => scope.tableId === tableId)) fail('TARGET_OUTSIDE_PROFILE');
    return freeze({ binding, profile });
}

export function replaceFillBinding(rawConfig, rawBinding, expectedRevision) {
    const config = normalizeFillAutomationConfig(rawConfig);
    if (config.revision !== expectedRevision) fail('FILL_CONFIG_CHANGED');
    const binding = normalizeFillBinding(rawBinding);
    return normalizeFillAutomationConfig({
        ...config, revision: config.revision + 1,
        bindings: [...config.bindings.filter(item => item.tableId !== binding.tableId), binding],
    });
}

export function replaceFillProfile(rawConfig, rawProfile, expectedRevision) {
    const config = normalizeFillAutomationConfig(rawConfig);
    if (config.revision !== expectedRevision) fail('FILL_CONFIG_CHANGED');
    const profile = normalizeFillProfile(rawProfile);
    const previous = config.profiles.find(item => item.profileId === profile.profileId);
    if (profile.revision !== (previous?.revision ?? 0) + 1) fail('FILL_PROFILE_CHANGED');
    return normalizeFillAutomationConfig({ ...config, revision: config.revision + 1,
        profiles: [...config.profiles.filter(item => item.profileId !== profile.profileId), profile] });
}

export function removeFillProfile(rawConfig, profileId, expectedRevision) {
    const config = normalizeFillAutomationConfig(rawConfig);
    if (config.revision !== expectedRevision) fail('FILL_CONFIG_CHANGED');
    if (!config.profiles.some(profile => profile.profileId === profileId)) fail('UNKNOWN_FILL_PROFILE');
    if (config.bindings.some(binding => binding.profileRef === profileId)) fail('FILL_PROFILE_IN_USE');
    return normalizeFillAutomationConfig({ ...config, revision: config.revision + 1,
        profiles: config.profiles.filter(profile => profile.profileId !== profileId) });
}
