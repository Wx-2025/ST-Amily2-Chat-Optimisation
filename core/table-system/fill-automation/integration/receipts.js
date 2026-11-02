import { fail, freeze, id } from '../validation.js';
import { readFillConfig, readFillLedger, stable, fingerprint, boundedClone, FILL_CONFIG_KEY } from './metadata.js';
import { captureFillMessageIdentity, coverageMessage, hasPendingFillIdentityInvalidation } from './identity.js';
import { chatIdFromContext } from '../../infra/chat-scope.js';
import { areFillReadDependenciesCurrent } from './dependencies.js';
import { getUncertainTableWrite } from '../../infra/table-write-transaction.js';

/** No historical backfill: only a saved unit may supply coverage. Consumers still verify row hashes. */
export async function readFillCoverageEvidence(context, { tableId, tableGroupId } = {}) {
    if (tableId !== undefined) id(tableId);
    if (tableGroupId !== undefined) id(tableGroupId);
    const ledger = readFillLedger(context);
    const config = readFillConfig(context);
    const empty = { version: 1, chatIdentity: ledger?.generationId ?? 'uninitialized',
        configVersion: String(config.revision), counting: 'message', messages: [], receipts: [],
        complete: false, ledgerRevision: ledger?.revision ?? 0 };
    if (getUncertainTableWrite(context) || context.chatMetadata?.[FILL_CONFIG_KEY] === undefined || !ledger
        || ledger.chatId !== chatIdFromContext(context) || hasPendingFillIdentityInvalidation(context)) return freeze(empty);
    const metadata = context.chatMetadata;
    const tableSource = metadata.amily2_table_state?.tables;
    const tables = tableSource === undefined ? [] : boundedClone(tableSource);
    const tablesText = stable(tables);
    const captured = await captureFillMessageIdentity(context, ledger);
    captured.assertCurrent();
    if (context.chatMetadata !== metadata || stable(readFillLedger(context)) !== stable(ledger)
        || context.chatMetadata?.[FILL_CONFIG_KEY] === undefined
        || stable(readFillConfig(context)) !== stable(config)) fail('FILL_EVIDENCE_CHANGED');
    // Generation sees a new user turn before the fill scheduler persists it. An
    // unchanged committed prefix still proves old coverage; never attest new IDs.
    const recorded = ledger.identities.filter(item => item.active);
    const unchangedPrefix = recorded.length > 0 && captured.messages.length >= recorded.length
        && recorded.every((item, index) => stable(item) === stable(captured.messages[index]));
    if ((captured.changed && !unchangedPrefix) || hasPendingFillIdentityInvalidation(context)) return freeze(empty);
    const recordedIds = new Set(recorded.map(item => item.id));
    const messages = captured.messages.filter(item => recordedIds.has(item.id)
        && item.visible && item.role !== 'system').map(coverageMessage);
    const current = new Map(messages.map(item => [item.id, stable(item)]));
    const committed = new Set([...ledger.units.filter(unit => unit.status === 'succeeded').map(unit => unit.id),
        ...ledger.retired.filter(unit => unit.status === 'succeeded').map(unit => unit.id)]);
    const eligible = ledger.receipts.filter(receipt => committed.has(receipt.unitId)
        && (tableId === undefined || receipt.tableId === tableId)
        && (tableGroupId === undefined || receipt.tableGroupId === tableGroupId)
        && receipt.configRevision === config.revision
        && receipt.messages.every(message => current.get(message.id) === stable(message)));
    const receipts = [];
    for (const receipt of eligible) {
        if (!await areFillReadDependenciesCurrent(receipt.dependencies, tables)) continue;
        const { id: receiptId, tableId: targetId, status, messages: covered, rows } = receipt;
        receipts.push({
            id: receiptId, tableId: targetId, status, messages: covered, rows,
        });
    }
    const chatIdentity = await fingerprint([ledger.chatId, ledger.generationId, ledger.branchId]);
    captured.assertCurrent();
    if (context.chatMetadata !== metadata || stable(readFillLedger(context)) !== stable(ledger)
        || context.chatMetadata?.[FILL_CONFIG_KEY] === undefined
        || stable(readFillConfig(context)) !== stable(config)
        || stable(context.chatMetadata.amily2_table_state?.tables ?? []) !== tablesText) fail('FILL_EVIDENCE_CHANGED');
    if (hasPendingFillIdentityInvalidation(context)) return freeze(empty);
    return freeze({ ...empty, chatIdentity,
        complete: true, messages, receipts });
}
