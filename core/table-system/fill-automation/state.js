import { LIMITS, choice, fail, freeze, id, ids, integer, list, record, sameIds, unique } from './validation.js';

export const FILL_STAGES = Object.freeze(['fill', 'summary', 'compression']);

export function normalizeFillDependency(raw) {
    record(raw, ['taskId', 'stage', 'sourceFingerprint', 'messageIds']);
    return freeze({
        taskId: id(raw.taskId, 4096), stage: choice(raw.stage, FILL_STAGES),
        sourceFingerprint: id(raw.sourceFingerprint, 256), messageIds: ids(raw.messageIds, LIMITS.coverage, 1),
    });
}

export function normalizeFillReceipt(raw) {
    record(raw, ['taskId', 'stage', 'sourceFingerprint', 'messageIds', 'status', 'outcome']);
    return freeze({
        ...normalizeFillDependency({ taskId: raw.taskId, stage: raw.stage,
            sourceFingerprint: raw.sourceFingerprint, messageIds: raw.messageIds }),
        status: choice(raw.status, ['succeeded', 'failed', 'stale']),
        outcome: choice(raw.outcome, ['changed', 'no-change']),
    });
}

export function evaluateFillDependencies(stage, messageIds, rawDependencies = [], rawReceipts = []) {
    choice(stage, FILL_STAGES);
    const expected = ids(messageIds, LIMITS.coverage, 1);
    const dependencies = unique(list(rawDependencies, LIMITS.dependencies, normalizeFillDependency), item => item.taskId);
    const receipts = unique(list(rawReceipts, LIMITS.dependencies, normalizeFillReceipt), item => item.taskId);
    if (stage === 'fill') {
        if (dependencies.length) fail('INVALID_DEPENDENCY_STAGE');
        return freeze({ status: 'ready', missingTaskIds: [], missingMessageIds: [] });
    }
    const predecessor = FILL_STAGES[FILL_STAGES.indexOf(stage) - 1];
    if (dependencies.some(item => item.stage !== predecessor)) fail('INVALID_DEPENDENCY_STAGE');
    const covered = new Set();
    const missingTaskIds = [];
    let stale = false;
    let crossRange = false;
    for (const dependency of dependencies) {
        if (dependency.messageIds.some(messageId => !expected.includes(messageId))) crossRange = true;
        const receipt = receipts.find(item => item.taskId === dependency.taskId);
        if (receipt?.status === 'stale' || (receipt && receipt.sourceFingerprint !== dependency.sourceFingerprint)) stale = true;
        if (!receipt || receipt.status !== 'succeeded' || receipt.stage !== predecessor
            || receipt.sourceFingerprint !== dependency.sourceFingerprint
            || !sameIds(receipt.messageIds, dependency.messageIds)) {
            missingTaskIds.push(dependency.taskId);
            continue;
        }
        dependency.messageIds.forEach(messageId => covered.add(messageId));
    }
    const missingMessageIds = expected.filter(messageId => !covered.has(messageId));
    return freeze({
        status: stale ? 'stale' : crossRange ? 'cross-range' : missingTaskIds.length || missingMessageIds.length ? 'waiting' : 'ready',
        missingTaskIds, missingMessageIds,
    });
}

export function createFillTaskState(taskId) {
    return freeze({ taskId: id(taskId, 4096), status: 'pending', attempts: 0, errorCode: null });
}

function normalizeState(state) {
    record(state, ['taskId', 'status', 'attempts', 'errorCode']);
    return freeze({ taskId: id(state.taskId, 4096),
        status: choice(state.status, ['pending', 'running', 'candidate', 'succeeded', 'failed', 'stale']),
        attempts: integer(state.attempts, 0, 4), errorCode: state.errorCode === null ? null : id(state.errorCode) });
}

export function transitionFillTask(rawState, event) {
    const state = normalizeState(rawState);
    record(event, ['type', 'errorCode']);
    const transitions = {
        start: { pending: 'running', failed: 'running' },
        candidate: { running: 'candidate' },
        commit: { candidate: 'succeeded' },
        fail: { pending: 'failed', running: 'failed', candidate: 'failed', failed: 'failed' },
        stale: { pending: 'stale', running: 'stale', candidate: 'stale', succeeded: 'stale', failed: 'stale', stale: 'stale' },
    };
    const next = transitions[event.type]?.[state.status];
    if (!next) fail('INVALID_TASK_TRANSITION');
    return freeze({ taskId: state.taskId, status: next,
        attempts: integer(state.attempts + (event.type === 'start' ? 1 : 0), 0, 4),
        errorCode: event.type === 'fail' ? id(event.errorCode) : null });
}

export function recoverFillTaskState(rawState, hasValidLease = false) {
    const state = normalizeState(rawState);
    if (typeof hasValidLease !== 'boolean') fail('INVALID_BOOLEAN');
    if (state.status === 'running' && !hasValidLease) {
        return transitionFillTask(state, { type: 'fail', errorCode: 'INTERRUPTED_REQUIRES_RECONCILIATION' });
    }
    // Candidate recovery still requires host fingerprint/permission/revision checks.
    return freeze({ ...state });
}

export function summarizeFillStates(states) {
    const statuses = list(states, LIMITS.tasks, normalizeState).map(state => state.status);
    if (!statuses.length) return 'pending';
    if (statuses.includes('stale')) return 'stale';
    if (statuses.every(status => status === 'succeeded')) return 'succeeded';
    if (statuses.includes('succeeded')) return 'partial';
    if (statuses.includes('failed')) return 'failed';
    if (statuses.includes('running')) return 'running';
    if (statuses.includes('candidate')) return 'candidate';
    return 'pending';
}

export function fillReceiptFor(task, outcome) {
    return normalizeFillReceipt({ taskId: task.taskId, stage: task.stage,
        sourceFingerprint: task.sourceFingerprint, messageIds: task.range.messageIds,
        status: 'succeeded', outcome });
}
