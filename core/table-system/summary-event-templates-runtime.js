import { getContext } from '/scripts/extensions.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { deepClone, TABLE_STATE_METADATA_KEY } from './infra/database-state.js';
import { getStateRevision } from './infra/store.js';
import { commitToLastMessageAsync } from './infra/persistence.js';
import { captureTableFillRequestLease, assertTableFillRequestLease } from './infra/persistence-scope.js';
import { getMemoryStateForScope, setMemoryState } from './manager.js';
import { acquireSecondaryFillerProgressMutationLock } from './secondary-filler.js';
import { createSummaryEventTemplateController, isSummaryEventTemplateTable, readSummaryEventMigrationLedger, SUMMARY_EVENT_MIGRATIONS_KEY } from './summary-event-templates.js';

const failure = code => Object.assign(new Error(code), { code: `SUMMARY_TEMPLATE_${code}` });

// Production host adapter. Backups are private chat metadata, never table schema
// attributes or profile metadata, and are staged inside the same whole-chat save.
export function createCurrentSummaryEventTemplateService({ assertAccess = () => {} } = {}) {
    return createSummaryEventTemplateController({
        capture(options) {
            assertAccess();
            const context = getContext();
            const scope = captureChatScope(context);
            const tables = getMemoryStateForScope(scope);
            const ledger = readSummaryEventMigrationLedger(context.chatMetadata?.[SUMMARY_EVENT_MIGRATIONS_KEY]);
            const tableId = options.tableId ?? ledger.entries.find(entry => entry.id === options.migrationId)?.tableId;
            const table = tables?.find(item => item.id === tableId);
            if (!isSummaryEventTemplateTable(table)) throw failure('ACCESS_DENIED');
            const lease = captureTableFillRequestLease(context, { tableGroupId: table.groupId });
            assertTableFillRequestLease(lease, context);
            if (!lease.targetTableIds.includes(table.id)) throw failure('ACCESS_DENIED');
            const stateRevision = getStateRevision();
            const profile = deepClone(context.chatMetadata?.[TABLE_STATE_METADATA_KEY]?.profile ?? null);
            const readCompanions = () => ({ fillAutomation: context.chatMetadata?.amily2_fill_automation_v1 ?? null,
                fillConfig: context.chatMetadata?.amily2_fill_automation_config_v1 ?? null });
            const companions = deepClone(readCompanions());
            const expectedCompanions = JSON.stringify(companions);
            const rawLedger = context.chatMetadata?.[SUMMARY_EVENT_MIGRATIONS_KEY];
            const expectedTables = JSON.stringify(tables);
            const expectedProfile = JSON.stringify(profile);
            const expectedLedger = JSON.stringify(rawLedger);
            const assertCurrent = () => {
                assertAccess();
                assertTableFillRequestLease(lease, getContext());
                if (!chatScopesMatch(scope, captureChatScope(getContext())) || getStateRevision() !== stateRevision
                    || JSON.stringify(getMemoryStateForScope(scope)) !== expectedTables
                    || JSON.stringify(context.chatMetadata?.[TABLE_STATE_METADATA_KEY]?.profile ?? null) !== expectedProfile
                    || JSON.stringify(readCompanions()) !== expectedCompanions
                    || JSON.stringify(context.chatMetadata?.[SUMMARY_EVENT_MIGRATIONS_KEY]) !== expectedLedger) throw failure('STALE');
            };
            return { tables: deepClone(tables), profile, ledger, companions, scope, stateRevision, lease, assertCurrent };
        },
        assertSnapshotCurrent(snapshot) { snapshot.assertCurrent(); },
        async commit(plan, snapshot, assertCurrent) {
            const release = acquireSecondaryFillerProgressMutationLock();
            if (!release) throw failure('BUSY');
            let staged;
            let previous;
            let existed;
            let metadata;
            try {
                assertCurrent();
                const saved = await commitToLastMessageAsync(plan.tables, plan.profile, {
                    expectedStateRevision: snapshot.stateRevision,
                    expectedChatId: snapshot.scope.chatId,
                    expectedChatScope: snapshot.scope,
                    strictExpectedChatScope: true,
                    beforeSave({ context }) {
                        assertCurrent();
                        metadata = context.chatMetadata;
                        existed = Object.prototype.hasOwnProperty.call(metadata, SUMMARY_EVENT_MIGRATIONS_KEY);
                        previous = metadata[SUMMARY_EVENT_MIGRATIONS_KEY];
                        staged = deepClone(plan.ledger);
                        metadata[SUMMARY_EVENT_MIGRATIONS_KEY] = staged;
                    },
                    rollback() {
                        // Never overwrite another writer's replacement or in-place edit.
                        if (metadata?.[SUMMARY_EVENT_MIGRATIONS_KEY] !== staged
                            || JSON.stringify(staged) !== JSON.stringify(plan.ledger)) return;
                        if (existed) metadata[SUMMARY_EVENT_MIGRATIONS_KEY] = previous;
                        else delete metadata[SUMMARY_EVENT_MIGRATIONS_KEY];
                    },
                });
                if (!saved) return false;
                assertAccess();
                if (!chatScopesMatch(snapshot.scope, captureChatScope(getContext()))
                    || JSON.stringify(metadata?.[SUMMARY_EVENT_MIGRATIONS_KEY]) !== JSON.stringify(plan.ledger)) throw failure('SAVE_UNCERTAIN');
                // No vector-producing update dispatch; parent remounts its own UI.
                setMemoryState(plan.tables, snapshot.scope);
                return true;
            } finally { release(); }
        },
    });
}
