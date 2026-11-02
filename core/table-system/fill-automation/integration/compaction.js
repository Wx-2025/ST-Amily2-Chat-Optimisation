import { createCurrentSummaryCompactionService } from '../../summary-compaction-runtime.js';
import { COMPACTION_KEY } from '../../summary-compaction.js';
import { planFillCycleRanges } from '../planner.js';
import { fail, freeze } from '../validation.js';
import { createFillMetadataTransaction, fingerprint, normalizeFillLedger, readFillLedger, stable } from './metadata.js';
import { requestFillModelResult } from './model-adapter.js';
import { getUncertainTableWrite } from '../../infra/table-write-transaction.js';

const SAFE_COMPACTION_ERRORS = new Set([
    'ACCESS_DENIED', 'EVIDENCE_INVALID', 'SOURCE_INVALID', 'COLUMNS_INVALID', 'RANGE_INVALID',
    'TARGET_INVALID', 'REVISION_INVALID', 'INPUT_LIMIT', 'PREVIEW_BLOCKED', 'CANDIDATE_LIMIT',
    'CANDIDATE_INVALID', 'OUTPUT_BUDGET', 'STALE', 'BUSY', 'MODEL_INCOMPLETE', 'PERSIST_FAILED',
]);
const SAFE_CONNECTION_ERRORS = new Set([
    'FILL_CONNECTION_RESPONSE_INVALID', 'FILL_CONNECTION_RESPONSE_INCOMPLETE',
    'FILL_CONNECTION_RESPONSE_TOO_LARGE', 'FILL_CONNECTION_RESPONSE_READ_FAILED',
    'FILL_CONNECTION_RESPONSE_EMPTY', 'FILL_CONNECTION_REQUEST_FAILED',
    'FILL_CONNECTION_GUARD_REJECTED', 'FILL_RESPONSE_BUDGET', 'FILL_INPUT_BUDGET',
    'FILL_COMPRESSION_INPUT_BUDGET', 'FILL_BUDGET_EXHAUSTED',
]);

export function safeCompactionFailureCode(error, stage) {
    const code = error?.code;
    if (typeof code === 'string' && code.startsWith('SUMMARY_COMPACTION_')
        && SAFE_COMPACTION_ERRORS.has(code.slice('SUMMARY_COMPACTION_'.length))) {
        return code.replace('SUMMARY_COMPACTION_', 'FILL_COMPRESSION_');
    }
    if (SAFE_CONNECTION_ERRORS.has(code)) return code;
    const phase = ['preview', 'generate', 'candidate', 'save'].includes(stage) ? stage.toUpperCase() : 'UNKNOWN';
    return `FILL_COMPRESSION_${phase}_FAILED`;
}

/** Orchestrates the real compaction service; never implements a second archive writer. */
export function createFillCompactionRunner({ capture, reconcile, saveLedger, resolveProfile, resolvePrompt,
    authorizeRequest, getTables, leaseId }) {
    let currentService;
    let currentHandle;
    const durableEvidence = preview => fingerprint({ options: preview.options,
        chatIdentity: preview.chatIdentity, configVersion: preview.configVersion,
        receipts: preview.receipts, sourceRows: preview.sourceRows,
        tables: getTables().filter(table => [preview.options.sourceTableId, preview.options.targetTableId].includes(table.id)) });
    const update = async (captured, job, extra = {}) => {
        const ledger = readFillLedger(captured.context);
        return saveLedger(normalizeFillLedger({ ...ledger, ...extra, revision: ledger.revision + 1,
            compactions: [...ledger.compactions.filter(item => item.id !== job.id), job] }), captured);
    };
    const result = (status, jobs, extra = {}) => freeze({ status, running: false, tasks: jobs.map(job => ({
        taskId: job.id, status: job.status, attempts: job.attempts, errorCode: job.errorCode,
        tableIds: [job.targetTableId], hasCandidate: job.candidate !== null,
        positions: Array.from({ length: job.end - job.start + 1 }, (_, index) => job.start + index),
    })), ...extra });

    async function run({ tableId, trigger = 'manual', retry = false, includePartial = false }) {
        const captured = capture();
        const identity = await reconcile(captured, true);
        const { binding, profile } = resolveProfile(captured.config, tableId);
        const spec = binding.compression;
        if (!spec) fail('FILL_COMPRESSION_CONFIG');
        if (!profile.readScopes.some(scope => scope.tableId === spec.sourceTableId
            && spec.sourceColumnIds.every(column => scope.columnIds.includes(column)))
            || !profile.writeScopes.some(scope => scope.tableId === tableId && scope.columnIds.includes(spec.targetColumnId))) fail('FILL_COMPRESSION_SCOPE');
        const permission = await authorizeRequest({ scope: captured.scope, tableGroupId: profile.tableGroupId,
            readScopes: [{ tableId: spec.sourceTableId, columnIds: spec.sourceColumnIds }], writeScopes: profile.writeScopes });
        const guard = () => { captured.assertScope(); identity.assertCurrent(); (permission.assertAccessCurrent ?? permission.assertCurrent)(); };
        guard();
        const ranges = planFillCycleRanges(binding.cycle, identity.messages.map(({ id, version, role, visible }) => ({ id, version, role, visible })), { trigger, includePartial });
        const jobs = [];
        for (const range of ranges) {
            guard();
            const id = await fingerprint(['compression', identity.ledger.generationId, identity.ledger.branchId,
                captured.config.revision, profile, tableId, spec, range.messageIds.map(id => identity.messages.find(item => item.id === id))]);
            guard();
            let job = readFillLedger(captured.context).compactions.find(item => item.id === id);
            if (job?.status === 'succeeded' || job?.status === 'restored') {
                if (job.summaryRowId && !getTables().find(table => table.id === tableId)?.rowMeta
                    .some(row => row.id === job.summaryRowId && row[COMPACTION_KEY]?.requestId === job.requestId)) return result('needs-review', [job]);
                continue;
            }
            // Legacy code froze any sent model request. A null candidate with no
            // save identity proves this path never reached the archive writer.
            if (retry && job?.status === 'needs-review' && job.errorCode === 'FILL_COMPRESSION_FAILED'
                && !job.candidate && !job.requestId && !job.summaryRowId
                && !getUncertainTableWrite(captured.context)) {
                job = { ...job, status: 'failed', errorCode: 'FILL_COMPRESSION_GENERATE_FAILED' };
                await update(captured, job);
            }
            if (job && ['running', 'needs-review'].includes(job.status)) return result('needs-review', [job]);
            if (job?.status === 'failed' && !retry) return result('failed', [job]);
            job ??= { id, targetTableId: tableId, sourceTableId: spec.sourceTableId, configRevision: captured.config.revision,
                profileRevision: profile.revision, start: range.start - 1, end: range.end - 1, messageIds: range.messageIds,
                status: 'waiting', attempts: 0, leaseId, sourceFingerprint: null, candidate: null,
                requestId: null, summaryRowId: null, errorCode: null };
            const compactionOptions = { sourceTableId: spec.sourceTableId, targetTableId: tableId,
                sourceColumnIds: spec.sourceColumnIds, targetColumnId: spec.targetColumnId,
                start: job.start, end: job.end, maxOutputChars: spec.maxOutputChars,
                maxOutputTokens: Math.min(profile.outputTokenBudget, 8000) };
            let stage = 'preview';
            try {
                currentService = createCurrentSummaryCompactionService({ assertAccess: guard, auditOrigin: 'automatic',
                    transactionParticipant: {
                        prepare({ plan }) {
                            guard();
                            const ledger = readFillLedger(captured.context);
                            const saved = ledger.compactions.find(item => item.id === id);
                            if (!saved?.candidate || saved.sourceFingerprint !== job.sourceFingerprint) fail('FILL_COMPRESSION_CHANGED');
                            const committed = { ...saved, status: 'succeeded', candidate: null,
                                requestId: plan.requestId, summaryRowId: plan.summaryRowId, errorCode: null };
                            const transaction = createFillMetadataTransaction(captured.context,
                                normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                                    compactions: ledger.compactions.map(item => item.id === id ? committed : item) }), { assertCurrent: guard });
                            return { assertCurrent: guard, ...transaction };
                        },
                    },
                    async requestCandidate(messages, { signal }) {
                        const prompt = resolvePrompt(profile);
                        const requestMessages = [{ ...messages[0], content: `${messages[0].content}\n\n${prompt.text}` }, ...messages.slice(1)];
                        if (new TextEncoder().encode(JSON.stringify(requestMessages)).length > profile.inputTokenBudget) fail('FILL_COMPRESSION_INPUT_BUDGET');
                        const response = await requestFillModelResult({ profile: { ...profile, outputTokenBudget: compactionOptions.maxOutputTokens },
                            messages: requestMessages, signal,
                            beforeSend() { guard(); return true; } });
                        guard();
                        return { text: response.text, finishReason: ['end_turn', 'STOP'].includes(response.finishReason) ? 'stop' : response.finishReason,
                            truncated: response.truncated };
                    },
                });
                currentHandle = await currentService.preview(compactionOptions); guard();
                const preview = currentHandle.preview;
                if (!preview.canSave) {
                    const noNew = preview.gaps.length === 0 && preview.blockers.every(blocker => blocker.code === 'NO_SOURCES')
                        && preview.receipts.every(receipt => receipt.status === 'no-new');
                    job = { ...job, status: noNew ? 'succeeded' : 'waiting', errorCode: noNew ? null : 'FILL_COMPRESSION_COVERAGE_WAIT' };
                    await update(captured, job); jobs.push(job);
                    if (!noNew) return result('waiting', jobs);
                    continue;
                }
                if (!job.candidate) {
                    const ledger = readFillLedger(captured.context);
                    if (ledger.requestsUsed >= captured.config.limits.maxRequests
                        || ledger.tokensReserved + profile.inputTokenBudget + profile.outputTokenBudget > captured.config.limits.maxTokens
                        || job.attempts > captured.config.limits.maxRetries) fail('FILL_BUDGET_EXHAUSTED');
                    job = { ...job, status: 'running', attempts: job.attempts + 1, errorCode: null };
                    await update(captured, job, { requestsUsed: ledger.requestsUsed + 1,
                        tokensReserved: ledger.tokensReserved + profile.inputTokenBudget + profile.outputTokenBudget });
                    currentHandle = await currentService.preview(compactionOptions); guard();
                    stage = 'generate';
                    const candidate = await currentService.generate(currentHandle); guard();
                    stage = 'candidate';
                    const evidenceFingerprint = await durableEvidence(currentHandle.preview); guard();
                    job = { ...job, status: 'candidate', candidate, sourceFingerprint: currentHandle.preview.fingerprint, evidenceFingerprint };
                    await update(captured, job);
                }
                currentHandle = await currentService.preview(compactionOptions); guard();
                if (currentHandle.preview.fingerprint !== job.sourceFingerprint) {
                    const evidenceFingerprint = await durableEvidence(currentHandle.preview); guard();
                    if (!currentHandle.preview.canSave || !job.evidenceFingerprint
                        || evidenceFingerprint !== job.evidenceFingerprint) fail('FILL_COMPRESSION_CHANGED');
                    // Rebind a persisted candidate only when its durable evidence still matches.
                    const candidate = { ...job.candidate, sourceFingerprint: currentHandle.preview.fingerprint };
                    currentService.validate(currentHandle, candidate);
                    job = { ...job, candidate, sourceFingerprint: currentHandle.preview.fingerprint };
                    await update(captured, job);
                    currentHandle = await currentService.preview(compactionOptions); guard();
                    if (currentHandle.preview.fingerprint !== job.sourceFingerprint) fail('FILL_COMPRESSION_CHANGED');
                }
                currentService.validate(currentHandle, job.candidate);
                if (currentService.supportsAtomicParticipant !== true) fail('FILL_COMPRESSION_HOST_NOT_READY');
                stage = 'save';
                await currentService.save(currentHandle, job.candidate, { reviewed: true });
                guard();
                job = readFillLedger(captured.context).compactions.find(item => item.id === id);
                if (job?.status !== 'succeeded') fail('FILL_COMPRESSION_COMMIT_UNCONFIRMED');
                jobs.push(job);
            } catch (error) {
                guard();
                if (getUncertainTableWrite(captured.context)) {
                    return result('needs-review', [{ ...job, status: 'needs-review', errorCode: 'FILL_PERSISTENCE_UNKNOWN' }]);
                }
                job = { ...job, status: job.candidate || stage === 'save' ? 'needs-review' : 'failed',
                    errorCode: safeCompactionFailureCode(error, stage) };
                await update(captured, job); jobs.push(job);
                return result(job.status, jobs);
            } finally { currentService = null; currentHandle = null; }
        }
        return result('succeeded', jobs);
    }
    async function restore({ unitId, confirmed = false }) {
        if (!confirmed) fail('FILL_RESTORE_CONFIRMATION_REQUIRED');
        const captured = capture();
        const job = readFillLedger(captured.context)?.compactions.find(item => item.id === unitId);
        if (!job || job.status !== 'succeeded' || !job.summaryRowId) fail('FILL_RESTORE_UNAVAILABLE');
        const { profile, binding } = resolveProfile(captured.config, job.targetTableId);
        const spec = binding.compression;
        if (!spec || spec.sourceTableId !== job.sourceTableId) fail('FILL_RESTORE_UNAVAILABLE');
        const permission = await authorizeRequest({ scope: captured.scope, tableGroupId: profile.tableGroupId,
            readScopes: profile.readScopes, writeScopes: profile.writeScopes });
        const guard = () => { captured.assertScope(); (permission.assertAccessCurrent ?? permission.assertCurrent)(); };
        currentService = createCurrentSummaryCompactionService({ assertAccess: guard, auditOrigin: 'automatic',
            transactionParticipant: { prepare() {
                guard(); const ledger = readFillLedger(captured.context);
                const live = ledger.compactions.find(item => item.id === unitId);
                if (stable(live) !== stable(job)) fail('FILL_COMPRESSION_CHANGED');
                return { assertCurrent: guard, ...createFillMetadataTransaction(captured.context,
                    normalizeFillLedger({ ...ledger, revision: ledger.revision + 1,
                        compactions: ledger.compactions.map(item => item.id === unitId ? { ...item, status: 'restored' } : item) }),
                    { assertCurrent: guard }) };
            } } });
        try {
            currentHandle = await currentService.previewRestore(job.targetTableId, job.summaryRowId);
            guard();
            return await currentService.restore(currentHandle, { confirmed: true });
        } finally { currentService = null; currentHandle = null; }
    }
    return { run, restore, cancel() {
        try { currentService?.cancel(currentHandle); } catch { /* Scope guards still revoke publication. */ }
    } };
}
