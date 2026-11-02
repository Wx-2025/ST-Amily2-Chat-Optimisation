import { normalizeFillAutomationConfig } from '../config.js';
import { fail, freeze, id, integer, record } from '../validation.js';
import { sha256TextHex } from '../../../utils/sha256.js';

export const FILL_LEDGER_KEY = 'amily2_fill_automation_v1';
export const FILL_CONFIG_KEY = 'amily2_fill_automation_config_v1';
export const FILL_LEDGER_LIMITS = Object.freeze({ characters: 4 * 1024 * 1024,
    messages: 10000, units: 128, receipts: 512, compactions: 128, candidateCharacters: 1024 * 1024 });

export function boundedClone(value, maximum = FILL_LEDGER_LIMITS.characters) {
    let nodes = 0;
    let characters = 0;
    function copy(item, depth) {
        if (++nodes > 200000 || depth > 24) fail('FILL_METADATA_LIMIT');
        if (typeof item === 'string') {
            characters += item.length;
            if (characters > maximum) fail('FILL_METADATA_LIMIT');
            return item;
        }
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'number' && Number.isFinite(item)) return item;
        if (!item || typeof item !== 'object') fail('FILL_METADATA_INVALID');
        if (Array.isArray(item)) {
            if (item.length > 10000) fail('FILL_METADATA_LIMIT');
            const result = [];
            for (let i = 0; i < item.length; i++) {
                const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
                if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('FILL_METADATA_INVALID');
                result.push(copy(descriptor.value, depth + 1));
            }
            return result;
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('FILL_METADATA_INVALID');
        const result = {};
        for (const key of Reflect.ownKeys(item)) {
            if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('FILL_METADATA_INVALID');
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!Object.hasOwn(descriptor, 'value')) fail('FILL_METADATA_INVALID');
            result[key] = copy(descriptor.value, depth + 1);
        }
        return result;
    }
    const result = copy(value, 0);
    if (JSON.stringify(result).length > maximum) fail('FILL_METADATA_LIMIT');
    return result;
}

export function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const fingerprint = value => sha256TextHex(stable(value));
export const freshId = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    if (typeof globalThis.crypto?.getRandomValues !== 'function') fail('FILL_SECURE_ID_UNAVAILABLE');
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const readFillConfig = context => normalizeFillAutomationConfig(context?.chatMetadata?.[FILL_CONFIG_KEY]);

export function normalizeFillLedger(raw) {
    const value = boundedClone(raw);
    record(value, ['format', 'version', 'revision', 'chatId', 'generationId', 'branchId',
        'identities', 'units', 'receipts', 'requestsUsed', 'tokensReserved', 'compactions', 'retired']);
    if (value.format !== 'amily2.fill-ledger' || value.version !== 1) fail('FILL_LEDGER_VERSION');
    integer(value.revision, 0, Number.MAX_SAFE_INTEGER);
    for (const name of ['chatId', 'generationId', 'branchId']) id(value[name]);
    integer(value.requestsUsed, 0, Number.MAX_SAFE_INTEGER);
    integer(value.tokensReserved, 0, Number.MAX_SAFE_INTEGER);
    value.compactions ??= [];
    value.retired ??= [];
    if (!Array.isArray(value.retired) || value.retired.length > 2048
        || new Set(value.retired.map(item => item.id)).size !== value.retired.length) fail('FILL_LEDGER_LIMIT');
    for (const item of value.retired) {
        record(item, ['id', 'tableIds', 'messages', 'configRevision', 'status']); id(item.id);
        item.status ??= 'succeeded';
        if (!['succeeded', 'stale'].includes(item.status)) fail('FILL_RETIRED_INVALID');
        integer(item.configRevision, 1, Number.MAX_SAFE_INTEGER);
        if (!Array.isArray(item.tableIds) || !item.tableIds.length || item.tableIds.length > 128
            || !Array.isArray(item.messages) || !item.messages.length || item.messages.length > 512) fail('FILL_RETIRED_INVALID');
        item.tableIds.forEach(tableId => id(tableId));
        for (const message of item.messages) {
            record(message, ['id', 'position', 'swipeId', 'hash']); id(message.id); id(message.swipeId);
            integer(message.position, 0, 9999);
            if (!/^[a-f0-9]{64}$/.test(message.hash)) fail('FILL_RETIRED_INVALID');
        }
    }
    if (!Array.isArray(value.compactions) || value.compactions.length > FILL_LEDGER_LIMITS.compactions
        || new Set(value.compactions.map(item => item.id)).size !== value.compactions.length) fail('FILL_LEDGER_LIMIT');
    for (const item of value.compactions) {
        record(item, ['id', 'targetTableId', 'sourceTableId', 'configRevision', 'profileRevision', 'start', 'end',
            'messageIds', 'status', 'attempts', 'leaseId', 'sourceFingerprint', 'evidenceFingerprint', 'candidate', 'requestId', 'summaryRowId', 'errorCode']);
        item.evidenceFingerprint ??= null;
        if (item.evidenceFingerprint !== null && !/^[a-f0-9]{64}$/.test(item.evidenceFingerprint)) fail('FILL_COMPRESSION_RECORD');
        for (const key of ['id', 'targetTableId', 'sourceTableId', 'leaseId']) id(item[key]);
        integer(item.configRevision, 1, Number.MAX_SAFE_INTEGER); integer(item.profileRevision, 1, Number.MAX_SAFE_INTEGER);
        integer(item.start, 0, 9999); integer(item.end, item.start, 9999); integer(item.attempts, 0, 4);
        if (!['waiting', 'running', 'candidate', 'needs-review', 'succeeded', 'failed', 'restored'].includes(item.status)
            || !Array.isArray(item.messageIds) || item.messageIds.length !== item.end - item.start + 1) fail('FILL_COMPRESSION_RECORD');
        item.messageIds.forEach(messageId => id(messageId));
        for (const key of ['sourceFingerprint', 'requestId', 'summaryRowId', 'errorCode']) if (item[key] !== null) id(item[key]);
        if (item.candidate !== null) {
            boundedClone(item.candidate, 32768);
            record(item.candidate, ['version', 'sourceFingerprint', 'complete', 'sourceRowIds', 'text', 'omissions']);
            if (item.candidate.version !== 1 || item.candidate.complete !== true || typeof item.candidate.text !== 'string'
                || !Array.isArray(item.candidate.sourceRowIds) || !Array.isArray(item.candidate.omissions)) fail('FILL_COMPRESSION_RECORD');
        }
    }
    for (const [name, maximum] of [['identities', FILL_LEDGER_LIMITS.messages],
        ['units', FILL_LEDGER_LIMITS.units], ['receipts', FILL_LEDGER_LIMITS.receipts]]) {
        if (!Array.isArray(value[name]) || value[name].length > maximum) fail('FILL_LEDGER_LIMIT');
        if (new Set(value[name].map(item => item.id)).size !== value[name].length) fail('FILL_LEDGER_DUPLICATE');
        value[name].forEach(item => id(item.id));
    }
    for (const message of value.identities) {
        record(message, ['id', 'anchor', 'version', 'hash', 'contentHash', 'swipeId', 'role', 'visible', 'position', 'index', 'active']);
        id(message.anchor); id(message.version); id(message.hash); id(message.swipeId);
        if (!/^[a-f0-9]{64}$/.test(message.contentHash) || !/^[1-9]\d*$/.test(message.version)
            || !Number.isSafeInteger(Number(message.version))) fail('FILL_IDENTITY_INVALID');
        if (!/^[a-f0-9]{64}$/.test(message.hash) || !['user', 'assistant', 'system'].includes(message.role)
            || typeof message.visible !== 'boolean' || typeof message.active !== 'boolean') fail('FILL_IDENTITY_INVALID');
        integer(message.position, 0, FILL_LEDGER_LIMITS.messages - 1);
        integer(message.index, 0, FILL_LEDGER_LIMITS.messages - 1);
    }
    for (const unit of value.units) {
        record(unit, ['id', 'status', 'attempts', 'leaseId', 'taskIds', 'tableIds', 'messageIds',
            'inputFingerprint', 'candidate', 'errorCode']);
        if (!['running', 'candidate', 'succeeded', 'failed', 'needs-review', 'stale'].includes(unit.status)) fail('FILL_LEDGER_STATE');
        integer(unit.attempts, 1, 4); id(unit.leaseId); id(unit.inputFingerprint);
        for (const name of ['taskIds', 'tableIds', 'messageIds']) {
            if (!Array.isArray(unit[name]) || !unit[name].length || unit[name].length > 512) fail('FILL_LEDGER_INVALID');
            unit[name].forEach(item => id(item, name === 'taskIds' ? 4096 : 128));
        }
        if (unit.candidate !== null) {
            boundedClone(unit.candidate, FILL_LEDGER_LIMITS.candidateCharacters);
            if (!Array.isArray(unit.candidate) || unit.candidate.length !== unit.tableIds.length) fail('FILL_CANDIDATE_INVALID');
            for (const batch of unit.candidate) {
                record(batch, ['batchIndex', 'allowedTableIndices', 'strictRowBounds', 'operations']);
                integer(batch.batchIndex, 0, 127);
                if (batch.strictRowBounds !== true || !Array.isArray(batch.allowedTableIndices)
                    || batch.allowedTableIndices.length !== 1 || !Array.isArray(batch.operations)
                    || batch.operations.length > 512) fail('FILL_CANDIDATE_INVALID');
                integer(batch.allowedTableIndices[0], 0, 10000);
                for (const operation of batch.operations) {
                    record(operation, ['op', 'tableIndex', 'rowIndex', 'data']);
                    if (!['insertRow', 'updateRow', 'deleteRow'].includes(operation.op)) fail('FILL_CANDIDATE_INVALID');
                    integer(operation.tableIndex, 0, 10000);
                    if (operation.rowIndex !== undefined) integer(operation.rowIndex, 0, 1000000);
                    if (operation.data !== undefined) {
                        record(operation.data, Object.keys(operation.data));
                        if (Object.entries(operation.data).some(([key, value]) => !/^\d+$/.test(key) || typeof value !== 'string')) fail('FILL_CANDIDATE_INVALID');
                    }
                }
            }
        }
        if (unit.errorCode !== null) id(unit.errorCode);
    }
    for (const receipt of value.receipts) {
        record(receipt, ['id', 'unitId', 'taskId', 'tableId', 'tableGroupId', 'stage', 'status', 'outcome',
            'messages', 'rows', 'sourceFingerprint', 'configRevision', 'profileRevision', 'committedRevision',
            'dependencies', 'profileId']);
        for (const field of ['unitId', 'tableId', 'tableGroupId', 'profileId', 'sourceFingerprint']) id(receipt[field]);
        id(receipt.taskId, 4096);
        if (!['fill', 'summary', 'compression'].includes(receipt.stage)
            || !['succeeded', 'no-new'].includes(receipt.status)
            || !['changed', 'no-change'].includes(receipt.outcome)) fail('FILL_RECEIPT_INVALID');
        for (const field of ['configRevision', 'profileRevision', 'committedRevision']) integer(receipt[field], 1, Number.MAX_SAFE_INTEGER);
        if (!Array.isArray(receipt.messages) || !receipt.messages.length || receipt.messages.length > 512
            || !Array.isArray(receipt.rows) || receipt.rows.length > 200
            || !Array.isArray(receipt.dependencies) || receipt.dependencies.length > 128) fail('FILL_RECEIPT_INVALID');
        for (const message of receipt.messages) {
            record(message, ['id', 'position', 'swipeId', 'hash']);
            id(message.id); id(message.swipeId); integer(message.position, 0, 9999);
            if (!/^[a-f0-9]{64}$/.test(message.hash)) fail('FILL_RECEIPT_INVALID');
        }
        for (const row of receipt.rows) {
            record(row, ['rowId', 'hash']); id(row.rowId);
            if (!/^[a-f0-9]{64}$/.test(row.hash)) fail('FILL_RECEIPT_INVALID');
        }
        for (const dependency of receipt.dependencies) {
            record(dependency, ['tableId', 'columnIds', 'schemaFingerprint', 'rows']);
            id(dependency.tableId);
            if (!/^[a-f0-9]{64}$/.test(dependency.schemaFingerprint) || !Array.isArray(dependency.columnIds)
                || !dependency.columnIds.length || dependency.columnIds.length > 128
                || new Set(dependency.columnIds).size !== dependency.columnIds.length
                || !Array.isArray(dependency.rows) || dependency.rows.length > 10000) fail('FILL_RECEIPT_INVALID');
            dependency.columnIds.forEach(columnId => id(columnId));
            for (const row of dependency.rows) {
                record(row, ['rowId', 'hash']); id(row.rowId);
                if (!/^[a-f0-9]{64}$/.test(row.hash)) fail('FILL_RECEIPT_INVALID');
            }
        }
        if (receipt.status === 'no-new' && receipt.rows.length) fail('FILL_RECEIPT_INVALID');
    }
    if (value.retired.some(unit => value.units.some(active => active.id === unit.id))) fail('FILL_LEDGER_DUPLICATE');
    for (const unit of [...value.units.filter(item => item.status === 'succeeded'), ...value.retired]) {
        const receipts = value.receipts.filter(item => item.unitId === unit.id);
        if (receipts.length !== unit.tableIds.length || unit.tableIds.some(tableId => receipts.filter(item => item.tableId === tableId).length !== 1)) fail('FILL_RECEIPT_MISSING');
        if (unit.messages && receipts.some(receipt => receipt.configRevision !== unit.configRevision
            || stable(receipt.messages) !== stable(unit.messages))) fail('FILL_RETIRED_INVALID');
    }
    return freeze(value);
}

export function readFillLedger(context) {
    const raw = context?.chatMetadata?.[FILL_LEDGER_KEY];
    return raw === undefined ? null : normalizeFillLedger(raw);
}

export function newFillLedger(chatId) {
    return normalizeFillLedger({ format: 'amily2.fill-ledger', version: 1, revision: 0,
        chatId, generationId: freshId(), branchId: freshId(), identities: [], units: [], receipts: [],
        requestsUsed: 0, tokensReserved: 0 });
}

// Hooks are synchronous: callers put them inside the existing persistence queue.
export function createFillMetadataTransaction(context, next, { assertCurrent, key = FILL_LEDGER_KEY } = {}) {
    if (![FILL_LEDGER_KEY, FILL_CONFIG_KEY].includes(key) || typeof assertCurrent !== 'function') fail('FILL_TRANSACTION_INVALID');
    const normalized = key === FILL_LEDGER_KEY ? normalizeFillLedger(next) : normalizeFillAutomationConfig(next);
    const metadata = context.chatMetadata;
    if (!metadata || typeof metadata !== 'object') fail('FILL_METADATA_MISSING');
    const previous = metadata[key];
    const previousText = previous === undefined ? null : stable(boundedClone(previous));
    let staged = null;
    return {
        beforeSave({ context: live }) {
            assertCurrent();
            if (live.chatMetadata !== metadata || (metadata[key] === undefined ? null : stable(boundedClone(metadata[key]))) !== previousText) {
                fail('FILL_LEDGER_CONFLICT');
            }
            staged = boundedClone(normalized);
            metadata[key] = staged;
        },
        rollback({ context: live }) {
            if (!staged) return;
            if (live.chatMetadata !== metadata || metadata[key] !== staged) fail('FILL_ROLLBACK_OWNERSHIP_LOST');
            if (previous === undefined) delete metadata[key]; else metadata[key] = previous;
        },
        assertStagedCurrent({ context: live } = { context }) {
            assertCurrent();
            if (!staged || live.chatMetadata !== metadata || metadata[key] !== staged
                || stable(boundedClone(staged)) !== stable(normalized)) fail('FILL_LEDGER_CONFLICT');
        },
    };
}
