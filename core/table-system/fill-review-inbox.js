import {
    SECONDARY_REVIEW_PENDING_KEY,
    createSecondaryReviewPendingMarker,
    getTableFillContentFingerprint,
    getTableFillContentHash,
    getTableFillMessageProgress,
} from './infra/fill-progress.js';

export const TABLE_FILL_REVIEW_INBOX_KEY = 'amily2_table_fill_review_inbox_v1';
export const TABLE_FILL_REVIEW_RECORD_VERSION = 1;
export const TABLE_FILL_REVIEW_RESPONSE_LIMIT = 131_072;

let fallbackReviewIdSequence = 0;

function hasOwn(value, key) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameSerializedValue(left, right) {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function boundedText(value, maxLength) {
    return String(value ?? '').slice(0, maxLength);
}

function normalizeError(error, phase = 'runtime') {
    const line = Number(error?.line);
    return Object.freeze({
        phase: boundedText(error?.phase || phase, 64) || phase,
        code: boundedText(error?.code || 'TABLE_FILL_REVIEW_REQUIRED', 160),
        message: boundedText(error?.message || '填表失败，需要人工检查。', 2_048),
        ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    });
}

function createReviewId(now = Date.now()) {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return `table-review-${crypto.randomUUID()}`;
        }
    } catch {}
    fallbackReviewIdSequence = (fallbackReviewIdSequence + 1) % 1_000_000;
    const randomPart = Math.random().toString(36).slice(2, 12);
    return `table-review-${now.toString(36)}-${fallbackReviewIdSequence.toString(36)}-${randomPart}`;
}

export function createTableStateReviewFingerprint(state) {
    let serialized;
    try {
        serialized = JSON.stringify(state ?? null);
    } catch {
        return null;
    }
    return `${serialized.length}:${getTableFillContentFingerprint(serialized)}`;
}

function captureTableFillReviewTargets(targetMessages) {
    if (!Array.isArray(targetMessages)) return [];
    return targetMessages
        .map(target => {
            const index = Number(target?.index);
            const message = target?.msg;
            if (!Number.isSafeInteger(index) || index < 0 || !message || message.is_user) {
                return null;
            }
            const content = String(message.mes ?? '');
            return Object.freeze({
                index,
                contentHash: getTableFillContentHash(content),
                contentLength: content.length,
                contentFingerprint: getTableFillContentFingerprint(content),
            });
        })
        .filter(Boolean)
        .sort((left, right) => left.index - right.index);
}

function createTableFillReviewTargetSignature(targets) {
    return (Array.isArray(targets) ? targets : [])
        .map(target => [
            target?.index,
            target?.contentHash,
            target?.contentLength,
            target?.contentFingerprint,
        ].join(':'))
        .join('|');
}

export function tableFillReviewResponseMatchesTargets(record) {
    const expected = record?.response?.targetSignature;
    return typeof expected === 'string'
        && expected.length > 0
        && expected === createTableFillReviewTargetSignature(record?.targets);
}

function tableFillReviewTargetMatchesMessage(context, target) {
    const index = Number(target?.index);
    const message = context?.chat?.[index];
    if (!Number.isSafeInteger(index) || index < 0 || !message || message.is_user) {
        return false;
    }
    const content = String(message.mes ?? '');
    return !getTableFillMessageProgress(message).processed
        && target.contentHash === getTableFillContentHash(content)
        && target.contentLength === content.length
        && target.contentFingerprint === getTableFillContentFingerprint(content);
}

function tableFillReviewMarkerMatchesTarget(marker, reviewId, target) {
    return Boolean(marker
        && marker.version === 1
        && marker.reviewId === reviewId
        && marker.contentHash === target.contentHash
        && marker.contentLength === target.contentLength
        && marker.contentFingerprint === target.contentFingerprint);
}

function sortTableFillReviewRecords(records) {
    return [...records].sort((left, right) => (
        Number(left.createdAt || 0) - Number(right.createdAt || 0)
    ));
}

/**
 * Build a fail-closed, side-effect-free repair plan for review metadata.
 *
 * Ownership requires a matching record id, target index and strong content
 * evidence. Missing markers are restored only for an unambiguous owner.
 * Current markers without an inbox record become retry-only recovery records;
 * stale targets are never revived after their message content changes.
 */
export function planTableFillReviewReconciliation(
    context,
    {
        tableState = undefined,
        now = Date.now(),
    } = {},
) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const originalRecords = readTableFillReviewRecords(context);
    const recordsById = new Map();
    for (const record of originalRecords) {
        const group = recordsById.get(record.id) || [];
        group.push(record);
        recordsById.set(record.id, group);
    }

    const claimsByIndex = new Map();
    const evidenceIndexes = new Set();
    for (const record of originalRecords) {
        const seenIndexes = new Set();
        for (const target of record.targets || []) {
            const index = Number(target?.index);
            if (Number.isSafeInteger(index) && index >= 0 && index < chat.length) {
                evidenceIndexes.add(index);
            }
            if (seenIndexes.has(index)
                || !tableFillReviewTargetMatchesMessage(context, target)) {
                continue;
            }
            seenIndexes.add(index);
            const claims = claimsByIndex.get(index) || [];
            claims.push(Object.freeze({ record, target }));
            claimsByIndex.set(index, claims);
        }
    }
    for (let index = 0; index < chat.length; index += 1) {
        if (hasOwn(chat[index]?.extra, SECONDARY_REVIEW_PENDING_KEY)) {
            evidenceIndexes.add(index);
        }
    }

    const ownerByIndex = new Map();
    const recoveryGroups = new Map();
    for (const index of evidenceIndexes) {
        const message = chat[index];
        if (!message) continue;
        const marker = message.extra?.[SECONDARY_REVIEW_PENDING_KEY];
        const claims = claimsByIndex.get(index) || [];
        const markerReviewId = typeof marker?.reviewId === 'string'
            ? marker.reviewId
            : '';
        const markedClaims = markerReviewId
            ? claims.filter(claim => claim.record.id === markerReviewId)
            : [];
        let owner = null;

        if (markedClaims.length === 1) {
            owner = Object.freeze({
                kind: 'record',
                record: markedClaims[0].record,
                target: markedClaims[0].target,
            });
        } else if (!getTableFillMessageProgress(message).reviewPending
            && claims.length === 1) {
            owner = Object.freeze({
                kind: 'record',
                record: claims[0].record,
                target: claims[0].target,
            });
        } else if (getTableFillMessageProgress(message).reviewPending
            || claims.length > 1) {
            const reusableMarkerId = markerReviewId
                && markerReviewId.length <= 200
                && !recordsById.has(markerReviewId);
            const groupKey = reusableMarkerId
                ? `marker:${markerReviewId}`
                : `target:${index}`;
            const group = recoveryGroups.get(groupKey) || {
                id: reusableMarkerId ? markerReviewId : null,
                targets: [],
                createdAt: Number.isFinite(marker?.createdAt) ? marker.createdAt : now,
            };
            group.targets.push(Object.freeze({ index, msg: message }));
            recoveryGroups.set(groupKey, group);
            owner = Object.freeze({ kind: 'recovery', groupKey });
        }
        if (owner) ownerByIndex.set(index, owner);
    }

    const nextRecords = [];
    let trimmedRecordCount = 0;
    let removedRecordCount = 0;
    for (const record of originalRecords) {
        const retainedTargets = (record.targets || []).filter(target => {
            const owner = ownerByIndex.get(target.index);
            return owner?.kind === 'record'
                && owner.record === record
                && owner.target === target;
        });
        if (retainedTargets.length === 0) {
            removedRecordCount += 1;
            continue;
        }
        if (retainedTargets.length !== record.targets.length) {
            trimmedRecordCount += 1;
            nextRecords.push({
                ...record,
                targets: retainedTargets,
                updatedAt: now,
            });
        } else {
            nextRecords.push(record);
        }
    }

    const usedReviewIds = new Set(nextRecords.map(record => record.id));
    let recoveredRecordCount = 0;
    for (const [groupKey, group] of recoveryGroups) {
        let recoveryRecord = createTableFillReviewRecord({
            ...(group.id ? { id: group.id } : {}),
            source: 'secondary-recovery',
            error: {
                phase: 'reconcile',
                code: 'TABLE_FILL_REVIEW_STATE_RECOVERED',
                message: '\u68c0\u6d4b\u5230\u697c\u5c42\u4ecd\u5904\u4e8e\u5f85\u5ba1\u67e5\u72b6\u6001\uff0c\u4f46\u539f\u9519\u8bef\u8be6\u60c5\u5df2\u4e22\u5931\uff1b\u5df2\u91cd\u5efa\u4e3a\u4ec5\u53ef\u91cd\u8bd5\u7684\u6062\u590d\u5de5\u5355\u3002',
            },
            rawResponse: '',
            attempts: 1,
            targetMessages: group.targets,
            tableState,
            createdAt: group.createdAt,
            updatedAt: now,
        });
        while (usedReviewIds.has(recoveryRecord.id)) {
            recoveryRecord = createTableFillReviewRecord({
                source: 'secondary-recovery',
                error: recoveryRecord.error,
                rawResponse: '',
                attempts: 1,
                targetMessages: group.targets,
                tableState,
                createdAt: group.createdAt,
                updatedAt: now,
            });
        }
        usedReviewIds.add(recoveryRecord.id);
        nextRecords.push(recoveryRecord);
        recoveredRecordCount += 1;
        for (const target of recoveryRecord.targets) {
            ownerByIndex.set(target.index, Object.freeze({
                kind: 'record',
                record: recoveryRecord,
                target,
                recoveredFrom: groupKey,
            }));
        }
    }

    const markerMutations = [];
    let restoredMarkerCount = 0;
    let clearedMarkerCount = 0;
    let releasedPendingCount = 0;
    for (const index of evidenceIndexes) {
        const message = chat[index];
        if (!message) continue;
        const existingMarker = message.extra?.[SECONDARY_REVIEW_PENDING_KEY];
        const wasReviewPending = getTableFillMessageProgress(message).reviewPending;
        const owner = ownerByIndex.get(index);
        const desiredMarker = owner?.kind === 'record'
            ? createSecondaryReviewPendingMarker(
                owner.record.id,
                owner.target.contentHash,
                owner.target.contentLength,
                owner.target.contentFingerprint,
                owner.record.createdAt,
            )
            : undefined;
        const markerAlreadyMatches = desiredMarker
            ? tableFillReviewMarkerMatchesTarget(
                existingMarker,
                owner.record.id,
                owner.target,
            )
            : !hasOwn(message.extra, SECONDARY_REVIEW_PENDING_KEY);
        if (markerAlreadyMatches) continue;
        markerMutations.push(Object.freeze({
            index,
            message,
            before: clone(existingMarker),
            after: clone(desiredMarker),
        }));
        if (desiredMarker) restoredMarkerCount += 1;
        else {
            clearedMarkerCount += 1;
            if (wasReviewPending) releasedPendingCount += 1;
        }
    }

    const sortedNextRecords = sortTableFillReviewRecords(nextRecords);
    const recordsChanged = !sameSerializedValue(originalRecords, sortedNextRecords);
    const messageEvidence = [...evidenceIndexes]
        .sort((left, right) => left - right)
        .map(index => {
            const message = chat[index];
            return Object.freeze({
                index,
                message,
                content: String(message?.mes ?? ''),
                isUser: Boolean(message?.is_user),
            });
        });
    return Object.freeze({
        changed: recordsChanged || markerMutations.length > 0,
        recordsChanged,
        originalRecords: Object.freeze(originalRecords),
        nextRecords: Object.freeze(sortedNextRecords),
        markerMutations: Object.freeze(markerMutations),
        messageEvidence: Object.freeze(messageEvidence),
        recoveredRecordCount,
        restoredMarkerCount,
        clearedMarkerCount,
        releasedPendingCount,
        trimmedRecordCount,
        removedRecordCount,
    });
}
export function createTableFillReviewRecord({
    id = null,
    previousRecord = null,
    source = 'secondary-text',
    error = null,
    rawResponse = '',
    attempts = 1,
    targetMessages = [],
    tableState = undefined,
    createdAt = Date.now(),
    updatedAt = Date.now(),
    volatile = false,
} = {}) {
    const fullResponse = String(rawResponse ?? '');
    const targets = captureTableFillReviewTargets(targetMessages);
    if (targets.length === 0) {
        throw new Error('Table-fill review records require at least one assistant target.');
    }
    const reviewId = boundedText(id || previousRecord?.id || createReviewId(createdAt), 200);
    if (!reviewId) throw new Error('Table-fill review record id is invalid.');
    const baselineFingerprint = tableState === undefined
        ? (previousRecord?.baseline?.tableStateFingerprint
            ?? createTableStateReviewFingerprint(null))
        : createTableStateReviewFingerprint(tableState);
    return Object.freeze({
        version: TABLE_FILL_REVIEW_RECORD_VERSION,
        id: reviewId,
        status: 'pending',
        source: boundedText(source, 80) || 'secondary-text',
        createdAt: Number.isFinite(previousRecord?.createdAt)
            ? previousRecord.createdAt
            : createdAt,
        updatedAt,
        attempts: Math.max(1, Number.parseInt(attempts, 10) || 1),
        error: normalizeError(error),
        response: Object.freeze({
            text: fullResponse.slice(0, TABLE_FILL_REVIEW_RESPONSE_LIMIT),
            originalLength: fullResponse.length,
            truncated: fullResponse.length > TABLE_FILL_REVIEW_RESPONSE_LIMIT,
            targetSignature: createTableFillReviewTargetSignature(targets),
        }),
        targets: Object.freeze(targets),
        baseline: Object.freeze({
            tableStateFingerprint: baselineFingerprint,
        }),
        ...(volatile ? { volatile: true } : {}),
    });
}

function normalizeInboxEnvelope(value) {
    if (Array.isArray(value)) {
        return { version: 1, records: value };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { version: 1, records: [] };
    }
    return {
        version: 1,
        records: Array.isArray(value.records) ? value.records : [],
    };
}

function isReviewRecord(value) {
    return Boolean(value
        && typeof value === 'object'
        && !Array.isArray(value)
        && value.version === TABLE_FILL_REVIEW_RECORD_VERSION
        && typeof value.id === 'string'
        && value.id.length > 0
        && Array.isArray(value.targets)
        && value.targets.length > 0);
}

export function readTableFillReviewRecords(context) {
    const envelope = normalizeInboxEnvelope(
        context?.chatMetadata?.[TABLE_FILL_REVIEW_INBOX_KEY],
    );
    return envelope.records.filter(isReviewRecord).map(clone);
}

export function getTableFillReviewRecord(context, reviewId) {
    const normalizedId = String(reviewId ?? '');
    return readTableFillReviewRecords(context).find(record => record.id === normalizedId) ?? null;
}

export function captureTableFillReviewInbox(context) {
    const metadata = context?.chatMetadata;
    const existed = hasOwn(metadata, TABLE_FILL_REVIEW_INBOX_KEY);
    return Object.freeze({
        existed,
        value: existed ? clone(metadata[TABLE_FILL_REVIEW_INBOX_KEY]) : undefined,
    });
}

export function tableFillReviewInboxMatches(context, backup) {
    const metadata = context?.chatMetadata;
    const existed = hasOwn(metadata, TABLE_FILL_REVIEW_INBOX_KEY);
    return existed === backup?.existed
        && (!existed || sameSerializedValue(
            metadata[TABLE_FILL_REVIEW_INBOX_KEY],
            backup.value,
        ));
}

export function restoreTableFillReviewInbox(context, backup) {
    if (!context || !backup) return;
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') {
        if (!backup.existed) return;
        context.chatMetadata = {};
    }
    if (backup.existed) {
        context.chatMetadata[TABLE_FILL_REVIEW_INBOX_KEY] = clone(backup.value);
    } else {
        delete context.chatMetadata[TABLE_FILL_REVIEW_INBOX_KEY];
    }
}

function writeRecords(context, records) {
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') {
        context.chatMetadata = {};
    }
    if (records.length === 0) {
        delete context.chatMetadata[TABLE_FILL_REVIEW_INBOX_KEY];
        return;
    }
    context.chatMetadata[TABLE_FILL_REVIEW_INBOX_KEY] = {
        version: 1,
        records: records.map(clone),
    };
}

export function upsertTableFillReviewRecord(context, record) {
    if (!isReviewRecord(record)) {
        throw new Error('Cannot persist a malformed table-fill review record.');
    }
    const records = readTableFillReviewRecords(context)
        .filter(current => current.id !== record.id);
    records.push(clone(record));
    records.sort((left, right) => (
        Number(left.createdAt || 0) - Number(right.createdAt || 0)
    ));
    writeRecords(context, records);
    return record;
}

export function removeTableFillReviewRecords(context, reviewIds) {
    const ids = new Set(
        [...(reviewIds || [])].map(value => String(value ?? '')).filter(Boolean),
    );
    if (ids.size === 0) return 0;
    const records = readTableFillReviewRecords(context);
    const retained = records.filter(record => !ids.has(record.id));
    writeRecords(context, retained);
    return records.length - retained.length;
}

export function applyTableFillReviewMarkers(context, record) {
    const chat = context?.chat;
    if (!Array.isArray(chat)) {
        throw new Error('The current chat is unavailable while staging a table-fill review.');
    }
    for (const target of record.targets) {
        const message = chat[target.index];
        const content = String(message?.mes ?? '');
        if (!message
            || message.is_user
            || getTableFillContentHash(content) !== target.contentHash
            || content.length !== target.contentLength
            || getTableFillContentFingerprint(content) !== target.contentFingerprint) {
            const error = new Error('A table-fill review target changed before it could be saved.');
            error.code = 'TABLE_FILL_REVIEW_STALE_TARGET';
            throw error;
        }
        if (!message.extra) message.extra = {};
        message.extra[SECONDARY_REVIEW_PENDING_KEY] = createSecondaryReviewPendingMarker(
            record.id,
            target.contentHash,
            target.contentLength,
            target.contentFingerprint,
            record.createdAt,
        );
    }
}

export function resolveTableFillReviewTargets(context, record) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const currentTargets = [];
    const staleTargets = [];
    for (const target of record?.targets || []) {
        const message = chat[target.index];
        const content = String(message?.mes ?? '');
        const marker = message?.extra?.[SECONDARY_REVIEW_PENDING_KEY];
        const current = Boolean(
            message
            && !message.is_user
            && marker?.version === 1
            && marker.reviewId === record.id
            && target.contentHash === getTableFillContentHash(content)
            && target.contentLength === content.length
            && target.contentFingerprint === getTableFillContentFingerprint(content)
            && marker.contentHash === target.contentHash
            && marker.contentLength === target.contentLength
            && marker.contentFingerprint === target.contentFingerprint
            && !getTableFillMessageProgress(message).processed,
        );
        const resolved = Object.freeze({
            index: target.index,
            msg: message,
            hash: target.contentHash,
            contentLength: target.contentLength,
            contentFingerprint: target.contentFingerprint,
        });
        if (current) currentTargets.push(resolved);
        else staleTargets.push(resolved);
    }
    return Object.freeze({
        currentTargets: Object.freeze(currentTargets),
        staleTargets: Object.freeze(staleTargets),
        allCurrent: currentTargets.length === (record?.targets?.length || 0),
    });
}

export function getReviewIdsFromMessages(messages) {
    const ids = new Set();
    for (const message of messages || []) {
        const reviewId = message?.extra?.[SECONDARY_REVIEW_PENDING_KEY]?.reviewId;
        if (typeof reviewId === 'string' && reviewId) ids.add(reviewId);
    }
    return ids;
}
