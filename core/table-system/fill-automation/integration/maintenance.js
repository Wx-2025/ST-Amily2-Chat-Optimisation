import { COMPACTION_KEY } from '../../summary-compaction.js';
import { normalizeFillLedger } from './metadata.js';
import { fail } from '../validation.js';

// Compact task detail, never evidence still referenced by a recoverable archive.
export function planFillLedgerCleanup(ledger, tables, { retain = 16 } = {}) {
    if (!Number.isSafeInteger(retain) || retain < 0 || retain > 128) fail('FILL_CLEANUP_INVALID');
    if ([...ledger.units, ...ledger.compactions].some(unit => ['running', 'candidate', 'needs-review'].includes(unit.status))) {
        fail('FILL_RECONCILIATION_REQUIRED');
    }
    const protectedReceipts = new Set(tables.flatMap(table => table.rowMeta.flatMap(row =>
        (row[COMPACTION_KEY]?.receipts ?? []).map(receipt => receipt.id))));
    const eligible = ledger.units.filter(unit => unit.status === 'succeeded' && !unit.candidate
        && ledger.receipts.filter(receipt => receipt.unitId === unit.id).every(receipt => !protectedReceipts.has(receipt.id)));
    const removed = eligible.slice(0, Math.max(0, eligible.length - retain));
    const removedIds = new Set(removed.map(unit => unit.id));
    const retired = [...ledger.retired, ...removed.map(unit => {
        const receipt = ledger.receipts.find(receipt => receipt.unitId === unit.id);
        if (!receipt) fail('FILL_RECEIPT_MISSING');
        return { id: unit.id, tableIds: unit.tableIds, messages: receipt.messages, configRevision: receipt.configRevision };
    })];
    const units = ledger.units.filter(unit => !removedIds.has(unit.id));
    // Coverage is a shared consumer contract, including future compaction ranges.
    // Keep every receipt; retiring verbose task records must not revoke coverage.
    const receipts = ledger.receipts;
    const used = new Set([...units.flatMap(unit => unit.messageIds), ...retired.flatMap(unit => unit.messages.map(message => message.id)),
        ...ledger.compactions.flatMap(job => job.messageIds), ...receipts.flatMap(receipt => receipt.messages.map(message => message.id))]);
    const identities = ledger.identities.filter(message => message.active || used.has(message.id));
    return normalizeFillLedger({ ...ledger, revision: ledger.revision + 1, units, receipts, identities, retired });
}
