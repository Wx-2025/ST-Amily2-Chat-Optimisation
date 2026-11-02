import { normalizeFillAutomationConfig, normalizeFillCycle, resolveFillProfile } from './config.js';
import { evaluateFillDependencies, FILL_STAGES, normalizeFillDependency, normalizeFillReceipt } from './state.js';
import { LIMITS, boolean, choice, fail, freeze, id, ids, integer, key, list, record, sameIds, unique } from './validation.js';

const plannedTasks = new WeakSet();

function normalizeMessage(raw) {
    record(raw, ['id', 'version', 'role', 'visible']);
    return { id: id(raw.id), version: id(raw.version),
        role: choice(raw.role, ['user', 'assistant', 'system']), visible: boolean(raw.visible) };
}

export function planFillCycleRanges(rawCycle, rawMessages, options = {}) {
    const cycle = normalizeFillCycle(rawCycle);
    record(options, ['trigger', 'includePartial']);
    const trigger = choice(options.trigger ?? 'manual', ['manual', 'automatic', 'inherited']);
    const includePartial = boolean(options.includePartial ?? false);
    if (includePartial && trigger !== 'manual') fail('PARTIAL_REQUIRES_MANUAL_TRIGGER');
    const messages = unique(list(rawMessages, LIMITS.messages, normalizeMessage), message => message.id)
        .filter(message => message.visible && message.role !== 'system'
            && (cycle.mode !== 'ai-replies' || message.role === 'assistant'));
    if (trigger === 'automatic' && !cycle.automaticEnabled) return freeze([]);
    if (trigger === 'inherited' && cycle.mode !== 'inherit') return freeze([]);
    if (['inherit', 'manual'].includes(cycle.mode)) {
        if (trigger === 'automatic' || messages.length === 0) return freeze([]);
        if (messages.length > LIMITS.coverage) fail('COVERAGE_LIMIT');
        return freeze([{ basis: 'visible-messages', start: 1, end: messages.length,
            complete: true, messageIds: messages.map(message => message.id) }]);
    }
    const ranges = [];
    for (let offset = cycle.start - 1; offset < messages.length; offset += cycle.every) {
        const selected = messages.slice(offset, offset + cycle.every);
        const complete = selected.length === cycle.every;
        if (!complete && !includePartial) break;
        ranges.push({ basis: cycle.mode, start: offset + 1, end: offset + selected.length,
            complete, messageIds: selected.map(message => message.id) });
        // The input is bounded to 10,000 messages; runtime dispatches one unit at a time.
        // Historical completed ranges must remain addressable after ledger compaction.
    }
    return freeze(ranges);
}

function normalizeContext(raw) {
    record(raw, ['chatId', 'epoch', 'branchId', 'tableGroupId', 'owner', 'targetRevision',
        'sourceFingerprint', 'permissionFingerprint', 'connectionRevision', 'allowed',
        'automaticAllowed', 'inheritedCommitUnitId', 'commitTableIds', 'inheritedProfile',
        'stage', 'dependencies', 'receipts', 'estimatedInputTokens', 'estimatedOutputTokens']);
    return {
        chatId: id(raw.chatId), epoch: integer(raw.epoch, 0, Number.MAX_SAFE_INTEGER), branchId: id(raw.branchId),
        tableGroupId: id(raw.tableGroupId), owner: id(raw.owner),
        targetRevision: integer(raw.targetRevision, 0, Number.MAX_SAFE_INTEGER),
        sourceFingerprint: id(raw.sourceFingerprint, 256), permissionFingerprint: id(raw.permissionFingerprint, 256),
        connectionRevision: integer(raw.connectionRevision, 1, Number.MAX_SAFE_INTEGER),
        allowed: boolean(raw.allowed), automaticAllowed: boolean(raw.automaticAllowed),
        inheritedCommitUnitId: id(raw.inheritedCommitUnitId), commitTableIds: ids(raw.commitTableIds, LIMITS.tables, 1).sort(),
        stage: choice(raw.stage, FILL_STAGES),
        dependencies: unique(list(raw.dependencies ?? [], LIMITS.dependencies, normalizeFillDependency), item => item.taskId),
        receipts: unique(list(raw.receipts ?? [], LIMITS.dependencies, normalizeFillReceipt), item => item.taskId),
        estimatedInputTokens: integer(raw.estimatedInputTokens, 1, LIMITS.inputTokens),
        estimatedOutputTokens: integer(raw.estimatedOutputTokens, 1, LIMITS.outputTokens),
    };
}

/** Metadata only. The host supplies authorized, range-specific fingerprints, never chat text. */
export function planFillTasks({ config: rawConfig, tableId, context: rawContext, messages, trigger = 'manual', includePartial = false }) {
    const config = normalizeFillAutomationConfig(rawConfig);
    const { binding, profile } = resolveFillProfile(config, tableId, rawContext?.inheritedProfile);
    const context = normalizeContext(rawContext);
    if (!context.allowed || context.tableGroupId !== profile.tableGroupId) fail('FILL_FORBIDDEN');
    if (trigger !== 'manual' && !context.automaticAllowed) return freeze([]);
    if (context.estimatedInputTokens > profile.inputTokenBudget
        || context.estimatedOutputTokens > profile.outputTokenBudget) fail('PROFILE_BUDGET_EXCEEDED');
    if (!context.commitTableIds.includes(tableId)) fail('INVALID_COMMIT_MEMBERSHIP');
    const ranges = planFillCycleRanges(binding.cycle, messages, { trigger, includePartial });
    return freeze(ranges.map(range => {
        const independent = binding.commitUnit.mode === 'independent';
        const commitTableIds = independent ? [tableId] : context.commitTableIds;
        const unitId = key([context.chatId, context.epoch, context.branchId,
            independent ? ['independent', binding.commitUnit.unitId, tableId] : ['inherit', context.inheritedCommitUnitId],
            range.basis, range.start, range.end, range.messageIds[0], range.messageIds.at(-1)]);
        const taskId = key([unitId, tableId, context.stage, config.revision, profile.profileId, profile.revision,
            context.sourceFingerprint, context.permissionFingerprint, context.connectionRevision, context.targetRevision]);
        id(taskId, 4096);
        const dependencies = context.dependencies.filter(dependency => dependency.messageIds.some(messageId => range.messageIds.includes(messageId)));
        const task = freeze({
            taskId, unitId, tableId, profile, configRevision: config.revision, limits: config.limits,
            chatId: context.chatId, epoch: context.epoch, branchId: context.branchId,
            tableGroupId: context.tableGroupId, owner: context.owner, stage: context.stage,
            targetRevision: context.targetRevision, sourceFingerprint: context.sourceFingerprint,
            permissionFingerprint: context.permissionFingerprint, connectionRevision: context.connectionRevision,
            estimatedInputTokens: context.estimatedInputTokens, estimatedOutputTokens: context.estimatedOutputTokens,
            commitTableIds, range, dependencies,
            dependencyStatus: evaluateFillDependencies(context.stage, range.messageIds, dependencies, context.receipts),
        });
        plannedTasks.add(task);
        return task;
    }));
}

export function assertFillTasks(tasks) {
    list(tasks, LIMITS.tasks, task => {
        if (!plannedTasks.has(task)) fail('UNTRUSTED_FILL_PLAN');
        return task;
    }, 1);
    unique(tasks, task => task.taskId);
    const first = tasks[0];
    if (tasks.some(task => task.chatId !== first.chatId || task.epoch !== first.epoch
        || task.branchId !== first.branchId || task.configRevision !== first.configRevision
        || key(task.limits) !== key(first.limits))) fail('MIXED_FILL_SCOPE');
    return tasks;
}

export function planFillCommitUnits(tasks) {
    assertFillTasks(tasks);
    const units = new Map();
    for (const task of tasks) {
        if (!units.has(task.unitId)) units.set(task.unitId, []);
        units.get(task.unitId).push(task);
    }
    return freeze([...units].map(([unitId, members]) => {
        const first = members[0];
        if (members.some(task => !sameIds(task.commitTableIds, first.commitTableIds)
            || !sameIds(task.range.messageIds, first.range.messageIds) || task.stage !== first.stage
            || task.tableGroupId !== first.tableGroupId || task.owner !== first.owner)
            || !sameIds(members.map(task => task.tableId), first.commitTableIds)) fail('INCOMPLETE_COMMIT_UNIT');
        return { unitId, tasks: members };
    }));
}

export function planFillRequests(tasks) {
    assertFillTasks(tasks);
    const requests = [];
    for (const task of tasks) {
        // Conservative compatibility: no union of read scopes, owners, permissions or source snapshots.
        const compatibilityKey = key([task.tableGroupId, task.owner, task.permissionFingerprint,
            task.sourceFingerprint, task.connectionRevision, task.profile, task.range]);
        let request = requests.find(item => item.compatibilityKey === compatibilityKey
            && item.estimatedInputTokens + task.estimatedInputTokens <= task.profile.inputTokenBudget
            && item.estimatedOutputTokens + task.estimatedOutputTokens <= task.profile.outputTokenBudget);
        if (!request) {
            request = { compatibilityKey, tasks: [], profile: task.profile,
                estimatedInputTokens: 0, estimatedOutputTokens: 0,
                reservedTokens: task.profile.inputTokenBudget + task.profile.outputTokenBudget };
            requests.push(request);
        }
        request.tasks.push(task);
        request.estimatedInputTokens += task.estimatedInputTokens;
        request.estimatedOutputTokens += task.estimatedOutputTokens;
    }
    const limits = tasks[0].limits;
    if (requests.length > limits.maxRequests || requests.reduce((total, request) => total + request.reservedTokens, 0) > limits.maxTokens) {
        fail('RUN_BUDGET_EXCEEDED');
    }
    return freeze(requests.map(({ compatibilityKey: _unused, ...request }) => ({
        ...request, requestId: key(request.tasks.map(task => task.taskId).sort()),
    })));
}
