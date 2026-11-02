import { getContext } from '/scripts/extensions.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { deepClone } from './infra/database-state.js';
import { getStateRevision } from './infra/store.js';
import { commitToLastMessageAsync } from './infra/persistence.js';
import { captureTableFillRequestLease, assertTableFillRequestLease } from './infra/persistence-scope.js';
import { getMemoryStateForScope, setMemoryState } from './manager.js';
import { acquireSecondaryFillerProgressMutationLock } from './secondary-filler.js';
import { createSummaryCompactionController, COMPACTION_KEY } from './summary-compaction.js';
import { readFillCoverageEvidence } from './fill-automation/integration/receipts.js';
import { verifyRelationLifecycleState } from './record-relation-lifecycle.js';

// Deliberately not mounted or exported through manager/public APIs. Main owns
// receipt verification and the injection gate; absent evidence fails closed.
export function createCurrentSummaryCompactionService({ readEvidence = readFillCoverageEvidence, requestCandidate,
    assertAccess = () => {}, transactionParticipant, auditOrigin = 'manual' } = {}) {
    if (typeof readEvidence !== 'function') throw new TypeError('A trusted coverage reader is required.');
    const controller = createSummaryCompactionController({
        auditOrigin,
        requestCandidate,
        assertSnapshotCurrent(snapshot) { snapshot.assertCurrent(); },
        async capture(options) {
            assertAccess();
            const context = getContext();
            const scope = captureChatScope(context);
            const tables = getMemoryStateForScope(scope);
            const target = tables?.find(t => t.id === options.targetTableId);
            const provenance = target?.rowMeta?.find(m => m.id === options.summaryRowId)?.[COMPACTION_KEY];
            const sourceId = options.sourceTableId ?? provenance?.sourceTableId;
            const source = tables?.find(t => t.id === sourceId);
            if (!source || !target || source.groupId !== target.groupId) {
                throw Object.assign(new Error('Compaction tables are unavailable.'), { code: 'SUMMARY_COMPACTION_ACCESS_DENIED' });
            }
            const lease = captureTableFillRequestLease(context, { tableGroupId: source.groupId });
            assertTableFillRequestLease(lease, context);
            if (![source.id, target.id].every(tableId => lease.targetTableIds.includes(tableId))) {
                throw Object.assign(new Error('Compaction is outside the active writable Group.'), { code: 'SUMMARY_COMPACTION_ACCESS_DENIED' });
            }
            const stateRevision = getStateRevision();
            const originalTables = JSON.stringify(tables);
            const readInputs = () => JSON.stringify({ chat: context.chat, ledger: context.chatMetadata?.amily2_fill_automation_v1,
                config: context.chatMetadata?.amily2_fill_automation_config_v1 });
            const inputs = readInputs();
            if (inputs.length > 16000000) throw new Error('Coverage snapshot exceeds the runtime budget.');
            const assertCurrent = () => {
                assertAccess();
                assertTableFillRequestLease(lease, getContext());
                if (!chatScopesMatch(scope, captureChatScope(getContext())) || getStateRevision() !== stateRevision
                    || JSON.stringify(getMemoryStateForScope(scope)) !== originalTables || readInputs() !== inputs) {
                    throw Object.assign(new Error('Compaction snapshot changed.'), { code: 'SUMMARY_COMPACTION_STALE' });
                }
            };
            const evidence = await readEvidence(context, { tableId: source.id, tableGroupId: source.groupId });
            assertCurrent();
            const relationLifecycleProof = await verifyRelationLifecycleState(context, tables, { isCurrent: assertCurrent });
            return { tables: deepClone(tables), evidence: deepClone(evidence), scope, lease, stateRevision, assertCurrent, relationLifecycleProof };
        },
        async commit(tables, snapshot, assertCurrent, plan = {}) {
            const { ownershipToken } = plan;
            const release = acquireSecondaryFillerProgressMutationLock();
            if (!release) throw Object.assign(new Error('Table filling is busy.'), { code: 'SUMMARY_COMPACTION_BUSY' });
            try {
                assertCurrent();
                assertTableFillRequestLease(snapshot.lease, getContext());
                const participant = transactionParticipant?.prepare({ snapshot, plan });
                if (participant && ['assertCurrent', 'beforeSave', 'assertStagedCurrent', 'rollback']
                    .some(key => typeof participant[key] !== 'function')) {
                    throw new TypeError('Compaction participant requires pre-stage, staged CAS and owned rollback hooks.');
                }
                participant?.assertCurrent();
                let stagedInputs;
                const readInputs = context => JSON.stringify({ chat: context.chat,
                    ledger: context.chatMetadata?.amily2_fill_automation_v1,
                    config: context.chatMetadata?.amily2_fill_automation_config_v1 });
                const saved = await commitToLastMessageAsync(tables, undefined, {
                    expectedStateRevision: snapshot.stateRevision,
                    expectedChatId: snapshot.scope.chatId,
                    expectedChatScope: snapshot.scope,
                    strictExpectedChatScope: true,
                    summaryCompactionOwnershipToken: ownershipToken,
                    beforeSave(info) {
                        assertCurrent();
                        assertTableFillRequestLease(snapshot.lease, getContext());
                        participant?.assertCurrent();
                        participant?.beforeSave(info);
                    },
                    afterStage(info) {
                        participant?.assertStagedCurrent(info);
                        stagedInputs = readInputs(info.context);
                    },
                    beforeDurableSave: info => participant?.beforeDurableSave?.(info),
                    rollback: info => participant?.rollback(info),
                    publish(state) {
                        assertAccess();
                        participant?.assertStagedCurrent({ context: getContext() });
                        if (readInputs(getContext()) !== stagedInputs) {
                            throw Object.assign(new Error('Compaction inputs changed during persistence.'), { code: 'SUMMARY_COMPACTION_STALE' });
                        }
                        setMemoryState(state, snapshot.scope, { summaryCompactionOwnershipToken: ownershipToken });
                    },
                });
                if (!saved) return false;
                return true;
            } finally { release(); }
        },
    });
    return Object.freeze({ ...controller, supportsAtomicParticipant: true });
}
