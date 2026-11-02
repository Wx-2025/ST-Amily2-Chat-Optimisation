import { sha256TextHex } from '../utils/sha256.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { isDeletedRow, isInactiveRow } from './row-lifecycle.js';
import { COMPACTION_KEY, COMPACTION_ARCHIVE_KEY, COMPACTION_INVALIDATED_KEY,
    assertSummaryCompactionOwnershipToken } from './summary-compaction-ownership.js';

// These hashes bind saved data, not authority: a chat JSON owner can recompute them.
// Relation lifecycle evidence and transaction publication receipts remain separate.
export const RELATION_LIFECYCLE_FIELD = 'relationLifecycle';
export const RELATION_LIFECYCLE_LIMITS = Object.freeze({ stateChars: 16000000, operations: 128, rows: 2000 });
const proofs = new WeakMap();
let published;
const fail = () => { throw Object.assign(new Error('Relation lifecycle evidence is invalid or stale.'), { code: 'RELATION_LIFECYCLE_INVALID' }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const hash = value => sha256TextHex(stable(value));
const key = (tableId, rowId) => JSON.stringify([tableId, rowId]);
function rowImage(table, index) {
    return { tableId: table.id, columns: table.columns, row: table.rows[index],
        metadata: table.rowMeta[index], status: table.rowStatuses[index] };
}
function archiveImage(table, index) {
    return stable({ owner: table.owner, groupId: table.groupId, softDelete: table.softDelete, ...rowImage(table, index) });
}
function provenanceImage(provenance) {
    const result = { ...provenance };
    delete result[RELATION_LIFECYCLE_FIELD];
    return result;
}
function checkSize(tables) {
    if (!Array.isArray(tables)) fail();
    const image = JSON.stringify(tables);
    if (image.length > RELATION_LIFECYCLE_LIMITS.stateChars) fail();
    return image;
}
const hasRelations = tables => tables.some(table => table.columns?.some(column => Object.hasOwn(column, 'recordRelation')));
function contextCurrent(data) {
    return chatScopesMatch(data.scope, captureChatScope(data.context));
}

export async function sealCompactionRelationLifecycle(provenance, chatId) {
    if (!id(chatId) || provenance?.status !== 'active' || provenance[RELATION_LIFECYCLE_FIELD] !== undefined) fail();
    provenance[RELATION_LIFECYCLE_FIELD] = { version: 1, chatId, provenanceHash: await hash(provenanceImage(provenance)) };
}

// Refresh verifies saved operation structure, never current fill eligibility or approval.
export async function verifyRelationLifecycleState(context, tables, { isCurrent = () => {}, force = false } = {}) {
    if (!Array.isArray(tables)) fail();
    const scope = captureChatScope(context);
    const data = { context, scope, rows: new Map(), operations: new Map(), tables };
    if (!force && !hasRelations(tables)) {
        isCurrent();
        const proof = Object.freeze({});
        proofs.set(proof, data);
        return proof;
    }
    const inputImage = checkSize(tables);
    const tableIndex = new Map(tables.map(table => [table.id, table]));
    let count = 0;
    const assertCurrent = () => { isCurrent(); if (!contextCurrent(data)) fail(); };
    assertCurrent();
    for (const target of tables) {
        for (let summaryIndex = 0; summaryIndex < (target.rowMeta?.length ?? 0); summaryIndex++) {
            const provenance = target.rowMeta[summaryIndex]?.[COMPACTION_KEY];
            const seal = provenance?.[RELATION_LIFECYCLE_FIELD];
            if (seal === undefined) continue; // Legacy markers never acquire authority by being opened.
            if (!object(seal) || seal.version !== 1 || seal.chatId !== scope.chatId || !digest(seal.provenanceHash)) fail();
            if (++count > RELATION_LIFECYCLE_LIMITS.operations) fail();
            if (provenance.status === 'restored') continue;
            if (provenance.version !== 1 || provenance.status !== 'active' || !id(provenance.requestId)
                || provenance.targetTableId !== target.id || provenance.summaryRowId !== target.rowMeta[summaryIndex].id
                || !['manual-summary-compaction', 'automatic-summary-compaction'].includes(provenance.reason)
                || !digest(provenance.summaryHash) || !Array.isArray(provenance.sources) || !provenance.sources.length
                || provenance.sources.length > 200 || !Array.isArray(provenance.receipts) || !provenance.receipts.length
                || provenance.receipts.length > 2000 || !Array.isArray(provenance.sourceRowIds)
                || stable(provenance.sourceRowIds) !== stable(provenance.sources.map(ref => ref?.rowId))
                || new Set(provenance.sourceRowIds).size !== provenance.sources.length
                || await hash(provenanceImage(provenance)) !== seal.provenanceHash) fail();
            assertCurrent();
            const source = tableIndex.get(provenance.sourceTableId);
            if (!source || source.owner !== 'user' || target.owner !== 'user' || source.groupId !== target.groupId
                || source.softDelete !== true || target.softDelete !== true) fail();
            if (!target.rowMeta[summaryIndex][COMPACTION_INVALIDATED_KEY]) {
                const metadata = { ...target.rowMeta[summaryIndex] };
                delete metadata[COMPACTION_KEY];
                if (await hash({ ...rowImage(target, summaryIndex), metadata }) !== provenance.summaryHash) fail();
                assertCurrent();
            }
            const operationKey = key(target.id, provenance.summaryRowId);
            const operation = { tableId: target.id, rowId: provenance.summaryRowId, owner: target.owner,
                groupId: target.groupId, image: stable(provenance) };
            data.operations.set(operationKey, operation);
            const covered = new Map();
            for (const receipt of provenance.receipts) {
                if (receipt?.tableId !== source.id || !['succeeded', 'no-new'].includes(receipt.status)
                    || !Array.isArray(receipt.rows) || receipt.rows.length > 200) fail();
                for (const ref of receipt.rows) {
                    if (!id(ref?.rowId) || !digest(ref.hash) || (covered.has(ref.rowId) && covered.get(ref.rowId) !== ref.hash)) fail();
                    covered.set(ref.rowId, ref.hash);
                }
            }
            if (covered.size !== provenance.sources.length) fail();
            for (const ref of provenance.sources) {
                if (!id(ref?.rowId) || !object(ref.metadata) || ref.metadata.id !== ref.rowId
                    || ref.metadata.is_delete === true || ref.metadata[COMPACTION_ARCHIVE_KEY] || ref.metadata[COMPACTION_KEY]
                    || ['deleted', 'pending-deletion'].includes(ref.status) || !digest(ref.hash) || !digest(ref.archivedHash)
                    || covered.get(ref.rowId) !== ref.hash) fail();
                const index = source.rowMeta.findIndex(meta => meta.id === ref.rowId);
                // Explicit source edits revoke current ownership. They do not acquire archived status.
                if (index < 0 || source.rowMeta[index]?.[COMPACTION_INVALIDATED_KEY]) continue;
                const marker = source.rowMeta[index]?.[COMPACTION_ARCHIVE_KEY];
                if (!marker) continue;
                if (marker.version !== 1 || marker.requestId !== provenance.requestId || marker.summaryRowId !== provenance.summaryRowId
                    || marker.reason !== provenance.reason || !isDeletedRow(source, index)) fail();
                if (await hash(rowImage(source, index)) !== ref.archivedHash
                    || await hash({ ...rowImage(source, index), metadata: ref.metadata, status: ref.status }) !== ref.hash) fail();
                assertCurrent();
                const rowKey = key(source.id, ref.rowId);
                if (data.rows.has(rowKey) || data.rows.size >= RELATION_LIFECYCLE_LIMITS.rows) fail();
                data.rows.set(rowKey, { image: archiveImage(source, index), operationKey, beforeHash: ref.hash });
            }
        }
    }
    assertCurrent();
    if (JSON.stringify(tables) !== inputImage) fail();
    const proof = Object.freeze({});
    proofs.set(proof, data);
    return proof;
}

export function createVerifiedRelationLifecycleReader(tables, proof) {
    const data = proofs.get(proof ?? published);
    if (!data || !contextCurrent(data)) return () => undefined;
    const tableIndex = new Map(tables.map(table => [table.id, table]));
    const validOperations = new Set();
    for (const [operationKey, operation] of data.operations) {
        const target = tableIndex.get(operation.tableId);
        const metadata = target?.rowMeta?.find(meta => meta.id === operation.rowId);
        if (target?.owner === operation.owner && target.groupId === operation.groupId
            && stable(metadata?.[COMPACTION_KEY]) === operation.image) validOperations.add(operationKey);
    }
    return (table, index) => {
        const saved = data.rows.get(key(table.id, table.rowMeta?.[index]?.id));
        return saved && validOperations.has(saved.operationKey) && archiveImage(table, index) === saved.image ? 'archived' : undefined;
    };
}

export function publishRelationLifecycleProof(context, proof, tables) {
    const data = proofs.get(proof);
    if (!data || !chatScopesMatch(data.scope, captureChatScope(context))) fail();
    if (tables) data.tables = tables;
    published = proof; // One scope only; obsolete proofs are weakly held.
}

export function getRelationLifecycleRowState(context, table, index) {
    const data = proofs.get(published);
    if (!data || !chatScopesMatch(data.scope, captureChatScope(context))) return undefined;
    return createVerifiedRelationLifecycleReader(data.tables, published)(table, index);
}

export async function prepareRelationLifecycleTransition(context, before, after, { ownershipToken, isCurrent = () => {} } = {}) {
    const beforeProof = await verifyRelationLifecycleState(context, before, { isCurrent, force: hasRelations(after) });
    const proof = await verifyRelationLifecycleState(context, after, { isCurrent });
    const previous = proofs.get(beforeProof);
    const next = proofs.get(proof);
    const beforeIndex = new Map(before.map(table => [table.id, table]));
    let owned = false;
    for (const [rowKey, row] of next.rows) {
        if (previous.rows.get(rowKey)?.image === row.image
            && previous.operations.get(previous.rows.get(rowKey).operationKey)?.image === next.operations.get(row.operationKey)?.image) continue;
        if (!owned) { assertSummaryCompactionOwnershipToken(ownershipToken, before, after); owned = true; }
        const [tableId, rowId] = JSON.parse(rowKey);
        const source = beforeIndex.get(tableId);
        const index = source?.rowMeta?.findIndex(meta => meta.id === rowId) ?? -1;
        const operation = next.operations.get(row.operationKey);
        const oldTarget = beforeIndex.get(operation.tableId);
        if (index < 0 || isInactiveRow(source, index) || source.rowMeta[index]?.[COMPACTION_ARCHIVE_KEY]
            || oldTarget?.rowMeta?.some(meta => meta.id === operation.rowId)
            || await hash(rowImage(source, index)) !== row.beforeHash) fail();
        const target = after.find(table => table.id === operation.tableId);
        const summaryIndex = target.rowMeta.findIndex(meta => meta.id === operation.rowId);
        const metadata = { ...target.rowMeta[summaryIndex] };
        const provenance = metadata[COMPACTION_KEY];
        delete metadata[COMPACTION_KEY];
        if (await hash({ ...rowImage(target, summaryIndex), metadata }) !== provenance.summaryHash) fail();
    }
    const assertStagedCurrent = () => {
        isCurrent();
        if (!contextCurrent(next)) fail();
        const reader = createVerifiedRelationLifecycleReader(after, proof);
        for (const [rowKey] of next.rows) {
            const [tableId, rowId] = JSON.parse(rowKey);
            const table = after.find(item => item.id === tableId);
            const index = table?.rowMeta?.findIndex(meta => meta.id === rowId) ?? -1;
            if (index < 0 || reader(table, index) !== 'archived') fail();
        }
    };
    assertStagedCurrent();
    return Object.freeze({ proof, beforeProof, assertStagedCurrent, publish(tables = after) {
        assertStagedCurrent();
        publishRelationLifecycleProof(context, proof, tables);
    } });
}
