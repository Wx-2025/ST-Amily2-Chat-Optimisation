import { getContext } from '/scripts/extensions.js';
import { apiProfileManager } from '../../../../utils/config/ApiProfileManager.js';
import { getModuleAccessDecision } from '../../../../utils/module-access-policy.js';
import { getBatchFillerRuleTemplate } from '../../templates.js';
import { getState, getStateRevision } from '../../infra/store.js';
import { captureChatScope, chatScopesMatch, chatIdFromContext } from '../../infra/chat-scope.js';
import { captureTableFillRequestLease, assertTableFillRequestLease, isTablePersistenceScopeReady } from '../../infra/persistence-scope.js';
import { commitAuxiliaryChatMutationAsync, commitAuxiliaryChatMutationResultAsync, commitToLastMessageAsync } from '../../infra/persistence.js';
import { updateTableFromOperationBatches, getPendingTableWriteRecovery, recoverPendingTableWrite } from '../../manager.js';
import { assertNoUncertainTableWrite } from '../../infra/table-write-transaction.js';
import { invalidateSummaryCompactionTransition } from '../../summary-compaction-ownership.js';
import { acquireSecondaryFillerProgressMutationLock } from '../../secondary-filler.js';
import { normalizeFillAutomationConfig, resolveFillProfile } from '../config.js';
import { planFillCycleRanges, planFillTasks, planFillCommitUnits } from '../planner.js';
import { createFillAutomationController } from '../controller.js';
import { fail, freeze, id } from '../validation.js';
import { boundedClone, createFillMetadataTransaction, fingerprint, freshId, FILL_CONFIG_KEY,
    normalizeFillLedger, newFillLedger, readFillConfig, readFillLedger, stable } from './metadata.js';
import { captureFillMessageIdentity, coverageMessage, invalidateFillMessageIdentity, clearFillIdentityInvalidation } from './identity.js';
import { buildFillMessages, durableFillUnitId, parseFillResponse, projectFillTables, receiptRows, validateFillOperations } from './candidate.js';
import { requestFillModel } from './model-adapter.js';
import { captureFillReadDependencies, areFillReadDependenciesCurrent } from './dependencies.js';
import { getAutomationOwnedTableIds } from './ownership.js';
import { createDefaultFillAutomationHost } from './host.js';
import { createFillCompactionRunner } from './compaction.js';
import { planFillLedgerCleanup } from './maintenance.js';

export { isTableOwnedByAutomation, getAutomationOwnedTableIds } from './ownership.js';
export { readFillCoverageEvidence } from './receipts.js';
export { FILL_CONFIG_KEY, FILL_LEDGER_KEY } from './metadata.js';

const runtimeLeases = new Set();
let currentRuntime = null;
const tokenUpperBound = value => new TextEncoder().encode(JSON.stringify(value)).length;

/** Actual host factory. Only access/prompt decisions are supplied by the integrator, never persistence or model execution. */
export function createFillAutomationRuntime(options = {}) {
    options = { ...createDefaultFillAutomationHost(), ...options };
    let active = null;
    let controller = null;
    let compaction = null;
    let disposed = false;
    let epoch = 0;
    let state = freeze({ status: 'idle', tasks: [], running: false });
    const leaseId = freshId();
    runtimeLeases.add(leaseId);
    const isConfigured = () => getContext()?.chatMetadata?.[FILL_CONFIG_KEY] !== undefined;

    function capture({ allowUncertain = false } = {}) {
        if (disposed) fail('FILL_RUNTIME_DISPOSED');
        const context = getContext();
        if (!allowUncertain) {
            assertNoUncertainTableWrite(context);
        }
        if (!isTablePersistenceScopeReady(context)) fail('FILL_SCOPE_NOT_READY');
        const scope = captureChatScope(context);
        if (!scope.chatId) fail('FILL_CHAT_IDENTITY_MISSING');
        const config = readFillConfig(context);
        const configured = isConfigured();
        const capturedEpoch = epoch;
        const assertScope = () => {
            if (disposed || epoch !== capturedEpoch || !chatScopesMatch(scope, captureChatScope(getContext()))
                || isConfigured() !== configured
                || stable(readFillConfig(getContext())) !== stable(config)) fail('FILL_STALE');
        };
        return { context, scope, config, assertScope, assertEpoch: () => {
            if (disposed || epoch !== capturedEpoch) fail('FILL_STALE');
        } };
    }

    function captureModuleAccessGuard() {
        const access = getModuleAccessDecision('Table');
        const guard = () => {
            const live = getModuleAccessDecision('Table');
            if (!access.allowed || !live.allowed || live.revision !== access.revision) fail('FILL_NOT_AUTHORIZED');
        };
        guard();
        return guard;
    }

    async function saveLedger(next, captured, extraGuard = () => {}, attempt = null) {
        const guard = () => { captured.assertScope(); extraGuard(); };
        guard();
        const transaction = createFillMetadataTransaction(captured.context, next, { assertCurrent: guard });
        const intent = { expectedStateRevision: getStateRevision(),
            expectedChatId: captured.scope.chatId, expectedChatScope: captured.scope, strictExpectedChatScope: true,
            ...transaction };
        let saved;
        if (attempt) {
            attempt.outcome = 'unconfirmed';
            const result = await commitAuxiliaryChatMutationResultAsync(intent);
            attempt.outcome = result.outcome;
            if (Object.hasOwn(result, 'error')) throw result.error;
            saved = result.outcome === 'saved';
        } else saved = await commitAuxiliaryChatMutationAsync(intent);
        if (saved !== true) fail('FILL_LEDGER_SAVE_FAILED');
        guard();
        if (stable(readFillLedger(captured.context)) !== stable(next)) fail('FILL_LEDGER_READBACK_FAILED');
        return readFillLedger(captured.context);
    }

    async function reconcile(captured, persist) {
        let ledger = readFillLedger(captured.context);
        if (ledger && ledger.chatId !== captured.scope.chatId) fail('FILL_CHAT_IDENTITY_CHANGED');
        ledger ??= newFillLedger(captured.scope.chatId);
        const identity = await captureFillMessageIdentity(captured.context, ledger, { reconcileInvalidation: persist });
        captured.assertScope();
        let next = identity.ledger;
        const tableEvidence = boundedClone(captured.context.chatMetadata.amily2_table_state?.tables ?? []);
        const tableEvidenceText = stable(tableEvidence);
        const currentMessages = new Map(identity.messages.map(message => [message.id, stable(coverageMessage(message))]));
        const units = [];
        for (const unit of next.units) {
            if (['running', 'candidate'].includes(unit.status) && !runtimeLeases.has(unit.leaseId)) {
                units.push({ ...unit, status: 'needs-review', errorCode: 'FILL_INTERRUPTED_UNKNOWN_RESULT' });
                continue;
            }
            let stale = false;
            if (unit.status === 'succeeded') for (const receipt of next.receipts.filter(item => item.unitId === unit.id)) {
                if (receipt.configRevision !== captured.config.revision
                    || receipt.messages.some(message => currentMessages.get(message.id) !== stable(message))
                    || !await areFillReadDependenciesCurrent(receipt.dependencies, tableEvidence)) stale = true;
            }
            units.push(stale ? { ...unit, status: 'stale', errorCode: 'FILL_SOURCE_CHANGED' } : unit);
        }
        const compactions = next.compactions.map(job => job.status === 'running' && !runtimeLeases.has(job.leaseId)
            ? { ...job, status: 'needs-review', errorCode: 'FILL_INTERRUPTED_UNKNOWN_RESULT' } : job);
        const retired = [];
        for (const unit of next.retired) {
            let stale = unit.status === 'stale' || unit.configRevision !== captured.config.revision
                || unit.messages.some(message => currentMessages.get(message.id) !== stable(message));
            for (const receipt of next.receipts.filter(receipt => receipt.unitId === unit.id)) {
                if (!await areFillReadDependenciesCurrent(receipt.dependencies, tableEvidence)) stale = true;
            }
            retired.push(stale ? { ...unit, status: 'stale' } : unit);
        }
        const assertIdentity = () => {
            identity.assertCurrent();
            if (stable(captured.context.chatMetadata.amily2_table_state?.tables ?? []) !== tableEvidenceText) fail('FILL_EVIDENCE_CHANGED');
        };
        captured.assertScope(); assertIdentity();
        if (stable(units) !== stable(next.units) || stable(compactions) !== stable(next.compactions) || stable(retired) !== stable(next.retired)) {
            next = normalizeFillLedger({ ...next, revision: next.revision + 1, units, compactions, retired });
        }
        if (persist && stable(readFillLedger(captured.context)) !== stable(next)) {
            next = await saveLedger(next, captured, assertIdentity);
        }
        if (persist) clearFillIdentityInvalidation(captured.context);
        return { ...identity, ledger: next };
    }

    async function initialize() {
        if (disposed) fail('FILL_RUNTIME_DISPOSED');
        if (!isConfigured()) return state;
        const captured = capture();
        const identity = await reconcile(captured, true);
        state = freeze({ status: [...identity.ledger.units, ...identity.ledger.compactions].some(unit => unit.status === 'needs-review') ? 'needs-review' : 'idle',
            running: false, tasks: [] });
        return state;
    }

    function inheritedProfile(tableId, config) {
        if (typeof options.resolveInheritedProfile !== 'function') fail('FILL_INHERITED_PROFILE_UNAVAILABLE');
        const profile = options.resolveInheritedProfile({ tableId, context: getContext(), config });
        if (profile?.then) fail('FILL_INHERITED_PROFILE_ASYNC');
        return profile;
    }

    function resolveProfile(config, tableId) {
        const binding = config.bindings.find(item => item.tableId === tableId);
        return resolveFillProfile(config, tableId, binding?.mode === 'profile' ? undefined : inheritedProfile(tableId, config));
    }

    function resolvePrompt(profile) {
        const prompt = typeof options.resolvePrompt === 'function'
            ? options.resolvePrompt(profile.promptRef, { profile, context: getContext() }) : profile.promptRef === 'table-filling'
                ? { text: getBatchFillerRuleTemplate(), revision: 'global' } : null;
        if (!prompt || typeof prompt.text !== 'string' || !prompt.text.trim() || prompt.text.length > 65536
            || typeof prompt.revision !== 'string' || !prompt.revision) fail('FILL_PROMPT_UNAVAILABLE');
        return { text: prompt.text, revision: prompt.revision };
    }

    function membersFor(tableId, captured, profile, binding, lease) {
        if (binding.commitUnit.mode === 'independent') return [tableId];
        const owned = new Set(getAutomationOwnedTableIds(captured.context));
        // Legacy-owned tables finish before this lane. They must not be silently included in a second model run.
        const members = lease.targetTableIds.filter(target => owned.has(target)
            && !captured.config.bindings.find(item => item.tableId === target)?.compression
            && (captured.config.bindings.find(item => item.tableId === target)?.commitUnit.mode ?? 'inherit') === 'inherit');
        if (!members.includes(tableId)) fail('FILL_COMMIT_MEMBERSHIP');
        return members.sort();
    }

    async function preview({ tableId, trigger = 'manual', includePartial = false, binding: draftBinding } = {}) {
        const captured = capture();
        const identity = await reconcile(captured, false);
        const { binding, profile } = resolveProfile(captured.config, tableId);
        const ranges = planFillCycleRanges(draftBinding?.cycle ?? binding.cycle,
            planningMessages(identity, binding, captured.config, tableId), { trigger, includePartial });
        const connection = apiProfileManager.getProfile(profile.connectionRef);
        return freeze({ tableId, profileId: profile.profileId, connectionRef: profile.connectionRef,
            connectionAvailable: !!connection, ranges, readScopes: profile.readScopes, writeScopes: profile.writeScopes,
            inputTokenBudget: profile.inputTokenBudget, outputTokenBudget: profile.outputTokenBudget,
            requestsUsed: identity.ledger.requestsUsed, tokensReserved: identity.ledger.tokensReserved });
    }

    async function prepare(tableId, range, runOptions) {
        const captured = capture();
        const identity = await reconcile(captured, true);
        const { profile, binding } = resolveProfile(captured.config, tableId);
        const lease = captureTableFillRequestLease(captured.context, { tableGroupId: profile.tableGroupId });
        assertTableFillRequestLease(lease, captured.context);
        const members = membersFor(tableId, captured, profile, binding, lease);
        const durableId = await durableFillUnitId(members.map(member => ({ tableId: member, stage: 'fill',
            configRevision: captured.config.revision, profile: resolveProfile(captured.config, member).profile, range })),
        identity.ledger, identity.messages);
        captured.assertScope(); identity.assertCurrent(); assertTableFillRequestLease(lease, getContext());
        const retired = identity.ledger.retired.find(unit => unit.id === durableId);
        if (retired?.status === 'stale') {
            if (!runOptions.retry) fail('FILL_RETIRED_SOURCE_CHANGED');
            await saveLedger(normalizeFillLedger({ ...identity.ledger, revision: identity.ledger.revision + 1,
                retired: identity.ledger.retired.filter(unit => unit.id !== durableId) }), captured, identity.assertCurrent);
        }
        if (retired?.status === 'succeeded'
            || identity.ledger.units.some(unit => unit.id === durableId && unit.status === 'succeeded')) {
            return { alreadyCommitted: true, durableId };
        }
        const tables = boundedClone(getState());
        const tablesText = stable(tables);
        const snapshots = new Map();
        const tasks = [];
        const assertBase = () => {
            captured.assertScope(); identity.assertCurrent(); assertTableFillRequestLease(lease, getContext());
            if (stable(getState()) !== tablesText) fail('FILL_TABLES_CHANGED');
        };
        for (const member of members) {
            const resolved = resolveProfile(captured.config, member);
            const memberProfile = resolved.profile;
            if (memberProfile.tableGroupId !== profile.tableGroupId) fail('FILL_GROUP_MISMATCH');
            const connection = apiProfileManager.getProfile(memberProfile.connectionRef);
            if (!connection || connection.type !== 'chat' || connection.model !== memberProfile.model) fail('FILL_CONNECTION_CHANGED');
            const connectionText = stable(connection);
            const prompt = resolvePrompt(memberProfile);
            if (typeof options.authorizeRequest !== 'function') fail('FILL_AUTHORIZATION_UNAVAILABLE');
            const permission = await options.authorizeRequest(freeze({ feature: 'table-fill-automation', tableId: member,
                tableGroupId: profile.tableGroupId, connectionRef: memberProfile.connectionRef, model: memberProfile.model,
                readScopes: memberProfile.readScopes, writeScopes: memberProfile.writeScopes,
                automatic: runOptions.trigger !== 'manual', scope: { chatId: captured.scope.chatId, epoch: captured.scope.epoch } }));
            assertBase();
            if (!permission || typeof permission.assertCurrent !== 'function' || typeof permission.fingerprint !== 'string') fail('FILL_NOT_AUTHORIZED');
            const assertCurrent = () => {
                assertBase();
                if (permission.assertCurrent() !== true
                    || stable(resolveProfile(captured.config, member).profile) !== stable(memberProfile)
                    || stable(apiProfileManager.getProfile(memberProfile.connectionRef)) !== connectionText
                    || stable(resolvePrompt(memberProfile)) !== stable(prompt)) fail('FILL_STALE');
            };
            assertCurrent();
            const readTables = projectFillTables(tables, memberProfile, lease.targetTableIds);
            const selected = identity.messages.filter(message => range.messageIds.includes(message.id));
            const messages = selected.map(message => ({ ...coverageMessage(message), role: message.role,
                content: identity.content[message.index].text }));
            // AI-reply cycles cover assistants only. No implicit user context is added.
            const sourceFingerprint = await fingerprint({ messages, readTables, prompt, connection,
                profile: memberProfile, target: tables.find(table => table.id === member) });
            assertCurrent();
            const planned = planFillTasks({ config: captured.config, tableId: member,
                messages: planningMessages(identity, resolved.binding, captured.config, member), trigger: runOptions.trigger, includePartial: runOptions.includePartial,
                context: { chatId: captured.scope.chatId, epoch: captured.scope.epoch, branchId: identity.ledger.branchId,
                    tableGroupId: profile.tableGroupId, owner: 'user', targetRevision: lease.stateRevision,
                    sourceFingerprint, permissionFingerprint: permission.fingerprint, connectionRevision: 1,
                    allowed: true, automaticAllowed: true, inheritedCommitUnitId: `automation:${profile.tableGroupId}`,
                    commitTableIds: members, inheritedProfile: memberProfile, stage: 'fill', dependencies: [], receipts: [],
                    estimatedInputTokens: Math.max(1, tokenUpperBound({ messages, readTables, prompt })),
                    estimatedOutputTokens: 1 } });
            const task = planned.find(item => stable(item.range) === stable(range));
            if (!task) fail('FILL_INCOMPLETE_COMMIT_UNIT');
            tasks.push(task);
            snapshots.set(task.taskId, { tables, messages, readTables, prompt, assertCurrent });
        }
        planFillCommitUnits(tasks);
        assertBase();
        return { ...captured, identity, lease, tasks, snapshots, durableId, assertBase };
    }

    async function executeUnit(prepared, runOptions) {
        const { context, tasks, snapshots, durableId, lease, identity } = prepared;
        const candidates = new Map();
        let candidateWrite = null;
        let reserved = false;
        let restoredCandidates = null;
        const read = () => readFillLedger(context);
        const guard = () => { for (const snapshot of snapshots.values()) snapshot.assertCurrent(); };
        controller = createFillAutomationController({
            isCurrent(task) { try { snapshots.get(task.taskId).assertCurrent(); return true; } catch { return false; } },
            async authorizeRequest() { guard(); return true; },
            async reserveUnit(intent) {
                guard();
                const ledger = read();
                const existing = ledger.units.find(unit => unit.id === durableId);
                if (existing?.status === 'succeeded') return { status: 'committed', receipts: tasks.map(task => {
                    const receipt = ledger.receipts.find(item => item.unitId === durableId && item.tableId === task.tableId);
                    if (!receipt) fail('FILL_RECEIPT_MISSING');
                    return { taskId: task.taskId, stage: task.stage, status: 'succeeded', outcome: receipt.outcome,
                        sourceFingerprint: task.sourceFingerprint, messageIds: task.range.messageIds };
                }) };
                if (existing?.candidate && runOptions.retry === true) {
                    if (existing.inputFingerprint !== await fingerprint(tasks.map(task => task.sourceFingerprint))) fail('FILL_SAVED_CANDIDATE_STALE');
                    guard();
                    restoredCandidates = new Map(tasks.map(task => {
                        const index = existing.tableIds.indexOf(task.tableId);
                        if (index < 0) fail('FILL_CANDIDATE_INVALID');
                        return [task.taskId, validateFillOperations(task, existing.candidate[index].operations,
                            snapshots.get(task.taskId).tables, index)];
                    }));
                    await saveLedger(normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                        units: ledger.units.map(item => item.id === durableId
                            ? { ...item, status: 'running', leaseId, taskIds: tasks.map(task => task.taskId) } : item) }), prepared, guard);
                    reserved = true;
                    return { status: 'reserved' };
                }
                if (existing && !(['failed', 'stale'].includes(existing.status) && runOptions.retry === true)) return { status: 'blocked' };
                if (ledger.units.some(unit => unit.id !== durableId && ['running', 'candidate', 'needs-review'].includes(unit.status)
                    && unit.tableIds.some(table => tasks.some(task => task.tableId === table))
                    && unit.messageIds.some(message => tasks[0].range.messageIds.includes(message)))) return { status: 'blocked' };
                const attempts = (existing?.attempts ?? 0) + 1;
                if (attempts > 1 + intent.limits.maxRetries) fail('FILL_RETRY_LIMIT');
                if (ledger.requestsUsed + intent.requests > intent.limits.maxRequests
                    || ledger.tokensReserved + intent.reservedTokens > intent.limits.maxTokens) fail('FILL_DURABLE_BUDGET');
                const unit = { id: durableId, status: 'running', attempts, leaseId,
                    taskIds: tasks.map(task => task.taskId), tableIds: tasks.map(task => task.tableId),
                    messageIds: tasks[0].range.messageIds, inputFingerprint: await fingerprint(tasks.map(task => task.sourceFingerprint)),
                    candidate: null, errorCode: null };
                guard();
                await saveLedger(normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                    units: [...ledger.units.filter(item => item.id !== durableId), unit],
                    requestsUsed: ledger.requestsUsed + intent.requests,
                    tokensReserved: ledger.tokensReserved + intent.reservedTokens }), prepared, intent.assertCurrent);
                reserved = true;
                return { status: 'reserved' };
            },
            async executeRequest(request, { signal }) {
                guard();
                if (restoredCandidates) {
                    const restored = new Map(request.tasks.map(task => [task.taskId, restoredCandidates.get(task.taskId)]));
                    for (const [taskId, result] of restored) candidates.set(taskId, result);
                    return restored;
                }
                const messages = buildFillMessages(request, snapshots);
                if (tokenUpperBound(messages) > request.profile.inputTokenBudget) fail('FILL_INPUT_BUDGET');
                const text = await requestFillModel({ profile: request.profile, messages, signal,
                    beforeSend() { guard(); } });
                guard();
                const parsed = parseFillResponse(text, request, snapshots);
                for (const [taskId, result] of parsed) candidates.set(taskId, result);
                return parsed;
            },
            async validateCandidate({ task, result }) {
                guard();
                const candidate = result.get(task.taskId);
                if (!candidate || candidates.get(task.taskId) !== candidate) fail('FILL_CANDIDATE_UNTRUSTED');
                return { taskId: task.taskId, candidateRef: task.tableId, outcome: candidate.outcome,
                    complete: true, sourceFingerprint: task.sourceFingerprint, messageIds: task.range.messageIds };
            },
            async commitUnit(intent) {
                guard();
                const ledger = read();
                const unit = ledger.units.find(item => item.id === durableId);
                if (!unit || unit.leaseId !== leaseId || unit.status !== 'running') fail('FILL_RESERVATION_LOST');
                const operationBatches = tasks.map(task => candidates.get(task.taskId).batch);
                const candidateLedger = normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                    units: ledger.units.map(item => item.id === durableId ? { ...item, status: 'candidate', candidate: operationBatches } : item) });
                candidateWrite = { outcome: 'not-dispatched' };
                await saveLedger(candidateLedger, prepared, guard, candidateWrite);
                const saved = await updateTableFromOperationBatches(operationBatches, {
                    requestLease: lease, sourceMessages: context.chat,
                    targetMessages: identity.messages.filter(message => message.role === 'assistant' && tasks[0].range.messageIds.includes(message.id))
                        .map(message => ({ index: message.index, msg: context.chat[message.index] })),
                    async persistCandidate(nextTables) {
                        guard();
                        const before = tasks[0] && snapshots.get(tasks[0].taskId).tables;
                        const touchedRows = operationBatches.flatMap(batch => batch.operations.flatMap(operation => {
                            const table = before[operation.tableIndex];
                            const rowId = table?.rowMeta?.[operation.rowIndex]?.id;
                            return rowId ? [{ tableId: table.id, rowId }] : [];
                        }));
                        invalidateSummaryCompactionTransition(before, nextTables, {
                            operationId: durableId, reason: 'fill-automation', touchedRows,
                        });
                        const current = read();
                        if (current.revision !== candidateLedger.revision) fail('FILL_LEDGER_CONFLICT');
                        const nextTablesText = stable(nextTables);
                        const receipts = [];
                        for (const task of tasks) {
                            const rows = await receiptRows(before, nextTables, task.tableId);
                            guard();
                            receipts.push({ id: await fingerprint([durableId, task.tableId]), unitId: durableId,
                                taskId: task.taskId, tableId: task.tableId, tableGroupId: task.tableGroupId,
                                stage: task.stage, status: rows.length ? 'succeeded' : 'no-new',
                                outcome: candidates.get(task.taskId).outcome,
                                messages: identity.messages.filter(message => task.range.messageIds.includes(message.id)).map(coverageMessage),
                                rows, sourceFingerprint: task.sourceFingerprint, configRevision: task.configRevision,
                                profileRevision: task.profile.revision, profileId: task.profile.profileId,
                                committedRevision: current.revision + 1,
                                dependencies: await captureFillReadDependencies(snapshots.get(task.taskId).readTables, nextTables) });
                        }
                        const next = normalizeFillLedger({ ...current, revision: current.revision + 1,
                            receipts: [...current.receipts.filter(item => item.unitId !== durableId), ...receipts],
                            units: current.units.map(item => item.id === durableId ? { ...item, status: 'succeeded', candidate: null } : item) });
                        const hooks = createFillMetadataTransaction(context, next, { assertCurrent: () => {
                            intent.assertCurrent(); guard();
                            if (stable(nextTables) !== nextTablesText) fail('FILL_CANDIDATE_CHANGED');
                        } });
                        const committed = await commitToLastMessageAsync(nextTables, undefined, {
                            expectedStateRevision: lease.stateRevision, expectedChatId: prepared.scope.chatId,
                            expectedChatScope: prepared.scope, strictExpectedChatScope: true,
                            beforeSave(args) {
                                if (stable(args.state) !== nextTablesText) fail('FILL_CANDIDATE_NORMALIZATION_CHANGED');
                                hooks.beforeSave(args);
                            }, rollback: hooks.rollback,
                        });
                        if (committed !== true) return false;
                        prepared.assertScope(); identity.assertCurrent();
                        if (stable(read()) !== stable(next)) fail('FILL_LEDGER_READBACK_FAILED');
                        return true;
                    },
                });
                if (saved !== true) fail('FILL_COMMIT_FAILED');
                return { committed: true, unitId: intent.unitId };
            },
        });
        const result = await controller.run(tasks, { retry: runOptions.retry });
        if (result.status !== 'succeeded') {
            // Only a trusted pre-dispatch rejection is retryable; uncertain or saved candidates stay frozen.
            try {
                prepared.assertScope();
                const ledger = read();
                const unit = ledger.units.find(item => item.id === durableId);
                if (reserved && unit && unit.leaseId === leaseId && unit.status !== 'succeeded') {
                    await saveLedger(normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                        units: ledger.units.map(item => item.id === durableId ? { ...item,
                            status: candidateWrite && candidateWrite.outcome !== 'not-dispatched' ? 'needs-review' : 'failed',
                            errorCode: result.units?.find(item => item.status !== 'succeeded')?.errorCode
                                || 'FILL_EXECUTION_NOT_COMMITTED' } : item) }), prepared);
                }
            } catch { /* Existing running/candidate records deliberately remain blocked after lost scope. */ }
        }
        return result;
    }

    function run({ tableId, trigger = 'manual', retry = false, includePartial = false } = {}) {
        id(tableId);
        if (active) {
            if (active.tableId === tableId && active.trigger === trigger) return active.promise;
            fail('FILL_RUNTIME_BUSY');
        }
        if (disposed) fail('FILL_RUNTIME_DISPOSED');
        if (!isConfigured()) fail('FILL_NOT_CONFIGURED');
        if (readFillConfig(getContext()).bindings.find(binding => binding.tableId === tableId)?.compression) {
            ensureCompaction();
            state = freeze({ status: 'running', running: true, tasks: [] });
            active = { tableId, trigger, promise: null };
            active.promise = Promise.resolve().then(() => compaction.run({ tableId, trigger, retry, includePartial }))
                .then(result => { state = result; return result; })
                .finally(() => { active = null; });
            return active.promise;
        }
        const release = acquireSecondaryFillerProgressMutationLock();
        if (!release) fail('FILL_LEGACY_PIPELINE_BUSY');
        active = { tableId, trigger, promise: null };
        active.promise = Promise.resolve().then(async () => {
            const captured = capture();
            const identity = await reconcile(captured, true);
            const { binding } = resolveProfile(captured.config, tableId);
            const ranges = planFillCycleRanges(binding.cycle, planningMessages(identity, binding, captured.config, tableId), { trigger, includePartial });
            state = freeze({ status: 'running', running: true, tasks: [] });
            for (const range of ranges) {
                captured.assertScope();
                const prepared = await prepare(tableId, range, { trigger, includePartial });
                if (prepared.alreadyCommitted) continue;
                const completed = readFillLedger(prepared.context).units.find(unit => unit.id === prepared.durableId);
                if (completed?.status === 'succeeded') continue;
                state = await executeUnit(prepared, { retry });
                if (state.status !== 'succeeded') {
                    state = freeze({ ...state, unitStatus: readFillLedger(prepared.context)?.units
                        .find(unit => unit.id === prepared.durableId)?.status });
                    return state;
                }
            }
            state = freeze({ ...state, status: 'succeeded', running: false });
            return state;
        }).catch(error => {
            state = freeze({ status: 'failed', running: false, tasks: [], errorCode: /^FILL_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FILL_RUNTIME_FAILED' });
            throw Object.assign(new Error(state.errorCode), { code: state.errorCode });
        }).finally(() => { active = null; controller = null; release(); });
        return active.promise;
    }

    function ensureCompaction() {
        compaction ??= createFillCompactionRunner({ capture, reconcile, saveLedger, resolveProfile, resolvePrompt,
            authorizeRequest: options.authorizeRequest, getTables: getState, leaseId });
        return compaction;
    }

    async function restoreCompaction(args) {
        if (active) fail('FILL_RUNTIME_BUSY');
        active = { tableId: null, trigger: 'restore', promise: null };
        try { return await ensureCompaction().restore(args); } finally { active = null; }
    }

    async function reconcilePersistence({ confirmed = false } = {}) {
        if (!confirmed || active) fail('FILL_RECONCILIATION_REQUIRED');
        const result = await recoverPendingTableWrite();
        if (result.status === 'none') return result;
        revoke('FILL_RECOVERY_COMPLETED'); await initialize();
        return result;
    }

    function revoke(reason = 'FILL_CANCELLED', { messageIndex } = {}) {
        if (['message-edited', 'message-swiped', 'message-deleted'].includes(reason)) invalidateFillMessageIdentity(getContext(), messageIndex);
        epoch += 1;
        controller?.cancel();
        compaction?.cancel();
        state = freeze({ ...state, status: 'cancelled', errorCode: reason, running: !!active });
    }

    async function onLifecycle({ type, pipelineSucceeded = false, messageIndex } = {}) {
        if (type !== 'post-pipeline' && type !== 'chat-ready') {
            revoke(type, { messageIndex });
            if (['message-edited', 'message-swiped', 'message-deleted'].includes(type) && !active) return initialize();
            return state;
        }
        if (type === 'chat-ready') return active ? state : initialize();
        // Report this dispatch, not stale UI state from a previous run or config edit.
        if (!pipelineSucceeded) return freeze({ status: 'skipped', reason: 'upstream-failed', results: [] });
        if (!isConfigured()) return freeze({ status: 'skipped', reason: 'not-configured', results: [] });
        if (active || disposed) return freeze({ status: 'paused',
            errorCode: active ? 'FILL_RUNTIME_BUSY' : 'FILL_RUNTIME_DISPOSED', results: [] });
        const initial = capture();
        const visited = new Set();
        const results = [];
        const tableIds = [...getAutomationOwnedTableIds(initial.context)].sort((left, right) =>
            Number(!!initial.config.bindings.find(binding => binding.tableId === left)?.compression)
            - Number(!!initial.config.bindings.find(binding => binding.tableId === right)?.compression));
        for (const tableId of tableIds) {
            initial.assertScope();
            const { binding, profile } = resolveProfile(initial.config, tableId);
            const grouping = binding.commitUnit.mode === 'independent' ? tableId : profile.tableGroupId;
            if (visited.has(grouping)) continue;
            const trigger = binding.cycle.mode === 'inherit' ? 'inherited' : 'automatic';
            if (!(await preview({ tableId, trigger })).ranges.length) continue;
            initial.assertScope();
            visited.add(grouping);
            const result = await run({ tableId, trigger });
            initial.assertScope();
            const status = getPendingTableWriteRecovery() || result.unitStatus === 'needs-review' ? 'needs-review' : result.status;
            results.push({ tableId, status });
            if (status !== 'succeeded') return freeze({ status, results });
        }
        return freeze(results.length ? { status: 'succeeded', results }
            : { status: 'skipped', reason: 'no-due', results });
    }

    async function saveConfig({ config, targetId, expectedRevision, purpose }) {
        if (active) fail('FILL_RUNTIME_BUSY');
        const captured = capture();
        const next = normalizeFillAutomationConfig(config);
        if (targetId !== currentTargetId(captured.scope) || captured.config.revision !== expectedRevision
            || next.revision !== expectedRevision + 1) fail('FILL_CONFIG_CHANGED');
        let staged = false;
        const assertConfigTarget = () => {
            captured.assertEpoch();
            if (!staged) captured.assertScope();
            else if (!chatScopesMatch(captured.scope, captureChatScope(getContext()))
                || stable(readFillConfig(getContext())) !== stable(next)) fail('FILL_CONFIG_CHANGED');
        };
        const assertAccess = purpose === 'preset-import' ? captureModuleAccessGuard() : null;
        const hooks = createFillMetadataTransaction(captured.context, next, { assertCurrent: () => {
            assertConfigTarget(); assertAccess?.(); }, key: FILL_CONFIG_KEY });
        const saved = await commitAuxiliaryChatMutationAsync({ expectedStateRevision: getStateRevision(),
            expectedChatId: captured.scope.chatId, expectedChatScope: captured.scope, strictExpectedChatScope: true, ...hooks,
            beforeSave(args) { hooks.beforeSave(args); staged = true; },
            rollback(args) { hooks.rollback(args); staged = false; } });
        if (saved !== true) return false;
        if (!chatScopesMatch(captured.scope, captureChatScope(getContext())) || stable(readFillConfig(getContext())) !== stable(next)) fail('FILL_CONFIG_READBACK_FAILED');
        assertAccess?.();
        revoke('FILL_CONFIG_CHANGED');
        return true;
    }

    async function resetBudget({ confirmed = false } = {}) {
        if (!confirmed || active) fail('FILL_BUDGET_CONFIRMATION_REQUIRED');
        const captured = capture();
        const ledger = readFillLedger(captured.context);
        if (!ledger || [...ledger.units, ...ledger.compactions].some(unit => ['running', 'candidate', 'needs-review'].includes(unit.status))) fail('FILL_RECONCILIATION_REQUIRED');
        const next = normalizeFillLedger({ ...ledger, revision: ledger.revision + 1, requestsUsed: 0, tokensReserved: 0 });
        await saveLedger(next, captured, captureModuleAccessGuard());
        revoke('FILL_BUDGET_RESET');
        return true;
    }

    async function cleanupLedger({ confirmed = false } = {}) {
        if (!confirmed || active) fail('FILL_CLEANUP_CONFIRMATION_REQUIRED');
        const captured = capture();
        const ledger = readFillLedger(captured.context);
        if (!ledger) return false;
        const tables = stable(getState());
        const guard = () => { captured.assertScope(); if (stable(getState()) !== tables) fail('FILL_TABLES_CHANGED'); };
        const next = planFillLedgerCleanup(ledger, getState());
        if (next.units.length === ledger.units.length && next.identities.length === ledger.identities.length) return false;
        const assertAccess = captureModuleAccessGuard();
        await saveLedger(next, captured, () => { guard(); assertAccess(); });
        return true;
    }

    async function reconcileUnit({ unitId, confirmed = false, outcome } = {}) {
        if (!confirmed || outcome !== 'not-committed' || active) fail('FILL_RECONCILIATION_REQUIRED');
        // A user assertion is never evidence that a dispatched write did not persist.
        assertNoUncertainTableWrite(getContext());
        const captured = capture();
        const ledger = readFillLedger(captured.context);
        const compression = ledger?.compactions.find(item => item.id === unitId);
        if (compression) {
            if (!compression.candidate || !['needs-review', 'candidate'].includes(compression.status)) fail('FILL_RECONCILIATION_REQUIRED');
            await saveLedger(normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                compactions: ledger.compactions.map(item => item.id === unitId ? { ...item, status: 'candidate', errorCode: null } : item) }), captured);
            return true;
        }
        const unit = ledger?.units.find(item => item.id === unitId);
        if (!unit || !['needs-review', 'running', 'candidate'].includes(unit.status)
            || !unit.candidate
            || (unit.leaseId !== leaseId && runtimeLeases.has(unit.leaseId))) fail('FILL_RECONCILIATION_REQUIRED');
        await saveLedger(normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
            units: ledger.units.map(item => item.id === unitId ? { ...item,
                status: 'failed', errorCode: 'FILL_USER_CONFIRMED_NOT_COMMITTED' } : item) }), captured);
        return true;
    }

    return Object.freeze({ initialize, preview, run, onLifecycle, saveConfig, resetBudget, cleanupLedger, reconcileUnit, restoreCompaction, reconcilePersistence,
        listConnections() { return apiProfileManager.getProfiles('chat').map(({ id: connectionRef, name, model }) => ({ connectionRef, name, model })); },
        listPresetTables() {
            const captured = capture();
            return getState().filter(table => table.owner === 'user' && table.readOnly !== true).flatMap(table => {
                const lease = captureTableFillRequestLease(captured.context, { tableGroupId: table.groupId });
                assertTableFillRequestLease(lease, captured.context);
                if (!lease.targetTableIds.includes(table.id)) return [];
                return [{ tableId: table.id, name: table.name, tableGroupId: table.groupId,
                    columns: table.columns.map(column => ({ id: column.id, label: column.label })) }];
            });
        },
        listColumns(tableId) {
            const captured = capture({ allowUncertain: true });
            const table = getState()?.find(item => item.id === tableId);
            if (!table || table.owner !== 'user') fail('FILL_WRITE_FORBIDDEN');
            const lease = captureTableFillRequestLease(captured.context, { tableGroupId: table.groupId });
            assertTableFillRequestLease(lease, captured.context);
            return getState().filter(item => lease.targetTableIds.includes(item.id) && item.owner === 'user')
                .map(item => ({ tableId: item.id, name: item.name, tableGroupId: item.groupId,
                    columns: item.columns.map(column => ({ id: column.id, label: column.label })) }));
        },
        load(tableId) {
            if (disposed) fail('FILL_RUNTIME_DISPOSED');
            const context = getContext();
            return { config: readFillConfig(context), tableId, targetId: currentTargetId(captureChatScope(context)) };
        },
        cancel: revoke, revoke, getState() {
            let ledger;
            try { ledger = readFillLedger(getContext()); } catch { return freeze({ ...state, status: 'needs-review', errorCode: 'FILL_LEDGER_INVALID' }); }
            if (!ledger) return state;
            const recovery = getPendingTableWriteRecovery();
            return freeze({ ...state, requestsUsed: ledger.requestsUsed, tokensReserved: ledger.tokensReserved, retiredUnits: ledger.retired.length,
                ...(recovery ? { status: 'needs-review', recovery } : {}),
                tasks: [...ledger.units.map(unit => ({ taskId: unit.id, kind: 'fill', status: recovery ? 'needs-review' : unit.status, attempts: unit.attempts,
                    tableIds: unit.tableIds, errorCode: unit.errorCode, hasCandidate: unit.candidate !== null,
                    positions: unit.messageIds.map(messageId => ledger.identities.find(item => item.id === messageId)?.position)
                        .filter(position => Number.isSafeInteger(position)) })), ...ledger.compactions.map(job => ({
                    taskId: job.id, kind: 'compression', status: recovery ? 'needs-review' : job.status,
                    attempts: job.attempts, tableIds: [job.targetTableId], errorCode: job.errorCode,
                    hasCandidate: job.candidate !== null, canRestore: !recovery && job.status === 'succeeded' && !!job.summaryRowId,
                    positions: Array.from({ length: job.end - job.start + 1 }, (_, index) => job.start + index),
                }))] });
        },
        dispose() { revoke(); disposed = true; runtimeLeases.delete(leaseId); },
    });
}

function plannerMessage({ id: messageId, version, role, visible }) { return { id: messageId, version, role, visible }; }
function planningMessages(identity, binding, config, tableId) {
    if (binding.cycle.mode !== 'inherit') return identity.messages.map(plannerMessage);
    const committed = new Set(identity.ledger.units.filter(unit => unit.status === 'succeeded').map(unit => unit.id));
    const covered = new Map(identity.ledger.receipts.filter(receipt => receipt.tableId === tableId
        && receipt.configRevision === config.revision && committed.has(receipt.unitId))
        .flatMap(receipt => receipt.messages.map(message => [message.id, stable(message)])));
    for (const unit of identity.ledger.retired.filter(unit => unit.status === 'succeeded' && unit.tableIds.includes(tableId) && unit.configRevision === config.revision)) {
        for (const message of unit.messages) covered.set(message.id, stable(message));
    }
    return identity.messages.filter(message => covered.get(message.id) !== stable(coverageMessage(message))).map(plannerMessage);
}
function currentTargetId(scope) { return JSON.stringify([scope.chatId, scope.epoch]); }

export function initializeCurrentFillAutomation(options = {}) {
    if (currentRuntime) return currentRuntime;
    currentRuntime = createFillAutomationRuntime(options);
    return currentRuntime;
}
export function getCurrentFillAutomationRuntime() { return currentRuntime; }
export function revokeCurrentFillAutomation(reason, details) { currentRuntime?.revoke(reason, details); }
export function disposeCurrentFillAutomation() { currentRuntime?.dispose(); currentRuntime = null; }
