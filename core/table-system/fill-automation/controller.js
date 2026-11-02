import { assertFillTasks, planFillCommitUnits, planFillRequests } from './planner.js';
import { createFillTaskState, fillReceiptFor, normalizeFillReceipt, summarizeFillStates, transitionFillTask } from './state.js';
import { LIMITS, choice, fail, freeze, id, ids, key, list, record, sameIds, unique } from './validation.js';

function candidateFor(task, raw) {
    record(raw, ['taskId', 'candidateRef', 'outcome', 'sourceFingerprint', 'messageIds', 'complete']);
    if (raw.complete !== true || raw.taskId !== task.taskId
        || raw.sourceFingerprint !== task.sourceFingerprint
        || !sameIds(ids(raw.messageIds, LIMITS.coverage, 1), task.range.messageIds)) fail('INVALID_FILL_CANDIDATE');
    return freeze({ taskId: task.taskId, candidateRef: id(raw.candidateRef),
        outcome: choice(raw.outcome, ['changed', 'no-change']) });
}

function replayReceipts(tasks, raw) {
    const receipts = unique(list(raw, LIMITS.tasks, normalizeFillReceipt, 1), item => item.taskId);
    if (!sameIds(receipts.map(item => item.taskId), tasks.map(task => task.taskId))) fail('INVALID_COMMIT_RECEIPT');
    for (const task of tasks) {
        const receipt = receipts.find(item => item.taskId === task.taskId);
        if (receipt.status !== 'succeeded' || receipt.stage !== task.stage
            || receipt.sourceFingerprint !== task.sourceFingerprint
            || !sameIds(receipt.messageIds, task.range.messageIds)) fail('INVALID_COMMIT_RECEIPT');
    }
    return receipts;
}

/**
 * No timers, host imports, credential resolution or ambient model API access.
 * Only run() dispatches. All callbacks are trusted application code, never model/tool input.
 */
export function createFillAutomationController(callbacks) {
    const names = ['isCurrent', 'authorizeRequest', 'reserveUnit', 'executeRequest', 'validateCandidate', 'commitUnit'];
    record(callbacks, names);
    for (const name of names) if (typeof callbacks[name] !== 'function') fail('MISSING_TRUSTED_CALLBACK');
    const trusted = { ...callbacks };
    const states = new Map();
    let active = null;
    let scope = null;
    let requestsUsed = 0;
    let tokensReserved = 0;

    function snapshot() {
        const tasks = [...states.values()];
        return freeze({ status: summarizeFillStates(tasks), tasks, requestsUsed, tokensReserved, running: active !== null });
    }

    function assertCurrent(tasks, signal) {
        if (signal.aborted) fail('FILL_CANCELLED');
        for (const task of tasks) {
            // Deliberately synchronous so this same guard can run inside beforeSave.
            if (trusted.isCurrent(task) !== true) fail('FILL_STALE');
        }
    }

    function advance(tasks, type, errorCode) {
        for (const task of tasks) states.set(task.taskId, transitionFillTask(states.get(task.taskId), { type, errorCode }));
    }

    async function execute(tasks, options, signal) {
        const units = planFillCommitUnits(tasks);
        const unitRequests = units.map(unit => ({ ...unit, requests: planFillRequests(unit.tasks) }));
        const totalRequests = unitRequests.reduce((total, unit) => total + unit.requests.length, 0);
        const totalTokens = unitRequests.reduce((total, unit) => total + unit.requests.reduce((sum, request) => sum + request.reservedTokens, 0), 0);
        const limits = tasks[0].limits;
        if (totalRequests > limits.maxRequests || totalTokens > limits.maxTokens) fail('RUN_BUDGET_EXCEEDED');
        const results = [];
        for (const unit of unitRequests) {
            let phase = 'CHECK';
            try {
                assertCurrent(unit.tasks, signal);
                const currentStates = unit.tasks.map(task => states.get(task.taskId));
                if (currentStates.every(state => state.status === 'succeeded')) {
                    results.push({ unitId: unit.unitId, status: 'succeeded', replayed: true });
                    continue;
                }
                if (currentStates.some(state => state.status === 'succeeded')) fail('PARTIAL_UNIT_STATE');
                if (currentStates.some(state => state.status === 'stale')) fail('FILL_STALE');
                const blocked = unit.tasks.find(task => task.dependencyStatus.status !== 'ready');
                if (blocked) {
                    results.push({ unitId: unit.unitId, status: blocked.dependencyStatus.status });
                    continue;
                }
                if (currentStates.some(state => state.status === 'failed') && options.retry !== true) {
                    results.push({ unitId: unit.unitId, status: 'failed', errorCode: 'EXPLICIT_RETRY_REQUIRED' });
                    continue;
                }
                if (currentStates.some(state => state.attempts >= 1 + limits.maxRetries)) fail('RETRY_LIMIT');
                const cost = unit.requests.reduce((sum, request) => sum + request.reservedTokens, 0);
                if (requestsUsed + unit.requests.length > limits.maxRequests || tokensReserved + cost > limits.maxTokens) fail('RUN_BUDGET_EXCEEDED');
                phase = 'AUTHORIZE';
                for (const request of unit.requests) {
                    if (await trusted.authorizeRequest(request) !== true) fail('FILL_NOT_AUTHORIZED');
                    assertCurrent(unit.tasks, signal);
                }
                const runningStates = currentStates.map(state => transitionFillTask(state, { type: 'start' }));
                const reservationId = key([unit.unitId, runningStates.map(state => [state.taskId, state.attempts])]);
                phase = 'RESERVE';
                const reservation = await trusted.reserveUnit(freeze({
                    unitId: unit.unitId, reservationId, tasks: unit.tasks, states: runningStates,
                    requests: unit.requests.length, reservedTokens: cost, limits,
                    assertCurrent: () => assertCurrent(unit.tasks, signal),
                }));
                record(reservation, ['status', 'receipts']);
                choice(reservation.status, ['reserved', 'committed', 'blocked']);
                assertCurrent(unit.tasks, signal);
                if (reservation.status === 'blocked') fail('RESERVATION_REQUIRES_RECONCILIATION');
                if (reservation.status === 'committed') {
                    replayReceipts(unit.tasks, reservation.receipts);
                    advance(unit.tasks, 'start');
                    advance(unit.tasks, 'candidate');
                    advance(unit.tasks, 'commit');
                    results.push({ unitId: unit.unitId, status: 'succeeded', replayed: true });
                    continue;
                }
                requestsUsed += unit.requests.length;
                tokensReserved += cost;
                runningStates.forEach(state => states.set(state.taskId, state));
                const candidates = [];
                for (const request of unit.requests) {
                    phase = 'REQUEST';
                    assertCurrent(unit.tasks, signal);
                    const result = await trusted.executeRequest(request, { signal, reservationId });
                    assertCurrent(unit.tasks, signal);
                    phase = 'VALIDATE';
                    for (const task of request.tasks) {
                        candidates.push(candidateFor(task, await trusted.validateCandidate({ task, result })));
                        assertCurrent(unit.tasks, signal);
                    }
                }
                advance(unit.tasks, 'candidate');
                const receipts = unit.tasks.map(task => fillReceiptFor(task, candidates.find(candidate => candidate.taskId === task.taskId).outcome));
                const succeededStates = unit.tasks.map(task => transitionFillTask(states.get(task.taskId), { type: 'commit' }));
                let guarded = false;
                const guard = () => { assertCurrent(unit.tasks, signal); guarded = true; };
                phase = 'COMMIT';
                const committed = await trusted.commitUnit(freeze({
                    unitId: unit.unitId, reservationId, tasks: unit.tasks, candidates,
                    receipts, states: succeededStates, assertCurrent: guard,
                }));
                record(committed, ['committed', 'unitId']);
                if (!guarded || committed.committed !== true || committed.unitId !== unit.unitId) fail('COMMIT_NOT_CONFIRMED');
                if (signal.aborted) fail('FILL_CANCELLED');
                // The host owns post-save publication: its successful commit may itself advance revisions.
                succeededStates.forEach(state => states.set(state.taskId, state));
                results.push({ unitId: unit.unitId, status: 'succeeded', replayed: false });
            } catch (error) {
                const stale = error?.code === 'FILL_STALE';
                const safeCauses = ['FILL_RESPONSE_MISSING', 'FILL_RESPONSE_INCOMPLETE', 'FILL_RESPONSE_LIMIT',
                    'FILL_RESPONSE_BUDGET', 'FILL_INPUT_BUDGET', 'FILL_RESPONSE_INVALID', 'FILL_RESULT_MEMBERSHIP',
                    'FILL_OPERATION_PARSE_FAILED', 'FILL_WRITE_FORBIDDEN', 'FILL_COLUMN_FORBIDDEN', 'FILL_COLUMN_MISSING',
                    'FILL_INACTIVE_ROW', 'FILL_NOT_AUTHORIZED',
                    'FILL_CONNECTION_API_UNAVAILABLE', 'FILL_CONNECTION_INPUT_INVALID', 'FILL_CONNECTION_MESSAGES_INVALID',
                    'FILL_CONNECTION_REF_INVALID', 'FILL_CONNECTION_PROFILE_INVALID', 'FILL_CONNECTION_PRESET_UNSUPPORTED',
                    'FILL_CONNECTION_PROVIDER_UNSUPPORTED', 'FILL_CONNECTION_OVERRIDES_INVALID', 'FILL_CONNECTION_MODEL_MISMATCH',
                    'FILL_CONNECTION_PROFILE_CHANGED', 'FILL_CONNECTION_DISABLED', 'FILL_CONNECTION_GUARD_REQUIRED',
                    'FILL_CONNECTION_GUARD_REJECTED', 'FILL_CONNECTION_KEY_MISSING', 'FILL_CONNECTION_RESPONSE_INVALID',
                    'FILL_CONNECTION_RESPONSE_INCOMPLETE', 'FILL_CONNECTION_RESPONSE_TOO_LARGE',
                    'FILL_CONNECTION_RESPONSE_READ_FAILED', 'FILL_CONNECTION_RESPONSE_EMPTY', 'FILL_CONNECTION_REQUEST_FAILED'];
                const errorCode = stale ? 'FILL_STALE' : error?.code === 'FILL_CANCELLED' ? 'FILL_CANCELLED'
                    : safeCauses.includes(error?.code) || /^FILL_CONNECTION_HTTP_[45]\d{2}$/.test(error?.code) ? error.code
                    : `${phase}_FAILED_REQUIRES_RECONCILIATION`;
                for (const task of unit.tasks) {
                    let state = states.get(task.taskId);
                    if (stale) state = transitionFillTask(state, { type: 'stale' });
                    else if (['pending', 'running', 'candidate', 'failed'].includes(state.status)) {
                        state = transitionFillTask(state, { type: 'fail', errorCode });
                    }
                    states.set(task.taskId, state);
                }
                results.push({ unitId: unit.unitId, status: stale ? 'stale' : 'failed', errorCode });
                // No automatic retry or continuation after cancellation, denied authorization or unknown commit.
                break;
            }
        }
        return freeze({ ...snapshot(), running: false, units: results });
    }

    function run(tasks, options = {}) {
        record(options, ['retry']);
        if (options.retry !== undefined && typeof options.retry !== 'boolean') fail('INVALID_BOOLEAN');
        assertFillTasks(tasks);
        tasks = Object.freeze([...tasks]);
        options = Object.freeze({ retry: options.retry === true });
        const identity = key(tasks.map(task => task.taskId).sort());
        if (active) {
            if (active.identity === identity) return active.promise;
            fail('FILL_CONTROLLER_BUSY');
        }
        const taskScope = key([tasks[0].chatId, tasks[0].epoch, tasks[0].branchId, tasks[0].configRevision]);
        if (scope !== null && scope !== taskScope) fail('NEW_CONTROLLER_REQUIRED');
        planFillCommitUnits(tasks);
        if (new Set([...states.keys(), ...tasks.map(task => task.taskId)]).size > LIMITS.tasks) fail('TASK_LIMIT');
        scope = taskScope;
        tasks.forEach(task => { if (!states.has(task.taskId)) states.set(task.taskId, createFillTaskState(task.taskId)); });
        const abort = new AbortController();
        active = { identity, abort, promise: null };
        // Defer until active is installed, so synchronous reentrant clicks share the same run.
        active.promise = Promise.resolve().then(() => execute(tasks, options, abort.signal))
            .finally(() => { active = null; });
        return active.promise;
    }

    return Object.freeze({ run, getState: snapshot, cancel() { active?.abort.abort(); } });
}
