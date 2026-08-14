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

function tableFillReviewTargetMatchesContent(target, content) {
    const normalized = String(content ?? '');
    return target?.contentHash === getTableFillContentHash(normalized)
        && target?.contentLength === normalized.length
        && target?.contentFingerprint === getTableFillContentFingerprint(normalized);
}

function createTableFillReviewLocation({
    index,
    message,
    carrier,
    content,
    hidden,
    branchIndex = null,
    contentVerified = true,
}) {
    const progress = contentVerified
        ? getTableFillMessageProgress({
            is_user: Boolean(message?.is_user),
            mes: content,
            extra: carrier?.extra,
        })
        : { processed: false, reviewPending: false };
    return Object.freeze({
        key: hidden ? `${index}:swipe:${branchIndex}` : `${index}:current`,
        index,
        message,
        carrier,
        content,
        hidden,
        branchIndex,
        contentVerified,
        marker: carrier?.extra?.[SECONDARY_REVIEW_PENDING_KEY],
        processed: progress.processed,
        reviewPending: progress.reviewPending,
    });
}

/**
 * Return the current message plus independently persisted swipe branches.
 *
 * SillyTavern normally mirrors the selected swipe into message.extra. The
 * selected index is only a hint, though: old/imported chats may have a stale
 * swipe_id. Deduplicate a branch only when both its content and marker are an
 * unambiguous byte-for-byte mirror of the current message.
 */
function collectTableFillReviewLocations(context, index) {
    const message = context?.chat?.[index];
    if (!Number.isSafeInteger(index) || index < 0 || !message || message.is_user) {
        return [];
    }
    const currentContent = String(message.mes ?? '');
    const currentMarker = message.extra?.[SECONDARY_REVIEW_PENDING_KEY];
    const locations = [createTableFillReviewLocation({
        index,
        message,
        carrier: message,
        content: currentContent,
        hidden: false,
    })];
    const swipes = Array.isArray(message.swipes) ? message.swipes : null;
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info : null;
    if (!swipeInfo) {
        return locations;
    }
    if (!swipes || swipes.length !== swipeInfo.length) {
        for (let branchIndex = 0; branchIndex < swipeInfo.length; branchIndex += 1) {
            const carrier = swipeInfo[branchIndex];
            if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)
                || !hasOwn(carrier.extra, SECONDARY_REVIEW_PENDING_KEY)) continue;
            locations.push(createTableFillReviewLocation({
                index,
                message,
                carrier,
                content: '',
                hidden: true,
                branchIndex,
                contentVerified: false,
            }));
        }
        return locations;
    }

    const mirroredIndexes = [];
    for (let branchIndex = 0; branchIndex < swipes.length; branchIndex += 1) {
        const info = swipeInfo[branchIndex];
        if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
        const content = String(swipes[branchIndex] ?? '');
        const marker = info.extra?.[SECONDARY_REVIEW_PENDING_KEY];
        if (content === currentContent && sameSerializedValue(marker, currentMarker)) {
            mirroredIndexes.push(branchIndex);
        }
    }
    const selectedIndex = Number.isSafeInteger(message.swipe_id)
        && message.swipe_id >= 0
        && message.swipe_id < swipes.length
        && mirroredIndexes.includes(message.swipe_id)
        ? message.swipe_id
        : (mirroredIndexes.length === 1 ? mirroredIndexes[0] : null);

    for (let branchIndex = 0; branchIndex < swipes.length; branchIndex += 1) {
        if (branchIndex === selectedIndex) continue;
        const carrier = swipeInfo[branchIndex];
        if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)) continue;
        locations.push(createTableFillReviewLocation({
            index,
            message,
            carrier,
            content: String(swipes[branchIndex] ?? ''),
            hidden: true,
            branchIndex,
        }));
    }
    return locations;
}

function resolveTableFillReviewTargetEvidence(context, target, reviewId) {
    const index = Number(target?.index);
    const locations = collectTableFillReviewLocations(context, index);
    const candidates = locations
        .filter(location => location.contentVerified
            && !location.processed
            && tableFillReviewTargetMatchesContent(target, location.content));
    const exactMarkers = candidates.filter(location => (
        tableFillReviewMarkerMatchesTarget(location.marker, reviewId, target)
    ));
    const unresolvedMarkers = locations.filter(location => (
        !location.contentVerified
        && tableFillReviewMarkerMatchesTarget(location.marker, reviewId, target)
    ));
    const allExactMarkers = [...exactMarkers, ...unresolvedMarkers];
    if (exactMarkers.length === 1 && unresolvedMarkers.length === 0) {
        return Object.freeze({
            kind: 'exact',
            location: exactMarkers[0],
            candidates: Object.freeze(candidates),
            exactMarkers: Object.freeze(allExactMarkers),
        });
    }
    if (allExactMarkers.length > 0 || candidates.length > 1) {
        return Object.freeze({
            kind: 'ambiguous',
            location: null,
            candidates: Object.freeze(candidates),
            exactMarkers: Object.freeze(allExactMarkers),
        });
    }
    if (candidates.length === 1 && !candidates[0].reviewPending) {
        return Object.freeze({
            kind: 'inferred',
            location: candidates[0],
            candidates: Object.freeze(candidates),
            exactMarkers: Object.freeze(allExactMarkers),
        });
    }
    return Object.freeze({
        kind: 'stale',
        location: null,
        candidates: Object.freeze(candidates),
        exactMarkers: Object.freeze(allExactMarkers),
    });
}

function tableFillReviewMarkerMatchesTarget(marker, reviewId, target) {
    return Boolean(marker
        && marker.version === 1
        && marker.reviewId === reviewId
        && marker.contentHash === target.contentHash
        && marker.contentLength === target.contentLength
        && marker.contentFingerprint === target.contentFingerprint);
}

/**
 * Capture the one physical swipe_info branch that mirrors each currently
 * resolved review target. A branch is eligible only when both its body and its
 * pending marker match the inbox target's strong evidence. Duplicate matches
 * are deliberately ignored: another legitimate branch must never be cleared
 * merely because it lives on the same floor.
 */
export function createTableFillReviewSwipeMarkerCleanupPlan(
    context,
    reviewIds,
    resolvedMessages,
) {
    const ids = new Set(
        [...(reviewIds || [])].map(value => String(value ?? '')).filter(Boolean),
    );
    const resolved = new Set(resolvedMessages || []);
    if (ids.size === 0 || resolved.size === 0) {
        return Object.freeze({ mutations: Object.freeze([]) });
    }

    const claimsByCarrier = new Map();
    for (const record of readTableFillReviewRecords(context)) {
        if (!ids.has(record.id)) continue;
        for (const target of record.targets || []) {
            const index = Number(target?.index);
            const message = context?.chat?.[index];
            const currentContent = String(message?.mes ?? '');
            const currentMarker = message?.extra?.[SECONDARY_REVIEW_PENDING_KEY];
            if (!resolved.has(message)
                || message?.is_user
                || !tableFillReviewTargetMatchesContent(target, currentContent)
                || !tableFillReviewMarkerMatchesTarget(currentMarker, record.id, target)) {
                continue;
            }
            const swipes = Array.isArray(message.swipes) ? message.swipes : null;
            const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info : null;
            if (!swipes || !swipeInfo || swipes.length !== swipeInfo.length) continue;

            const candidates = [];
            for (let branchIndex = 0; branchIndex < swipes.length; branchIndex += 1) {
                const carrier = swipeInfo[branchIndex];
                const content = String(swipes[branchIndex] ?? '');
                const marker = carrier?.extra?.[SECONDARY_REVIEW_PENDING_KEY];
                if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)
                    || !tableFillReviewTargetMatchesContent(target, content)
                    || !tableFillReviewMarkerMatchesTarget(marker, record.id, target)) {
                    continue;
                }
                candidates.push({ branchIndex, carrier, content, marker });
            }
            if (candidates.length !== 1) continue;
            const candidate = candidates[0];
            const claim = Object.freeze({
                index,
                message,
                target: clone(target),
                reviewId: record.id,
                currentContent,
                currentMarker: clone(currentMarker),
                swipes,
                swipesLength: swipes.length,
                swipeInfo,
                swipeInfoLength: swipeInfo.length,
                branchIndex: candidate.branchIndex,
                carrier: candidate.carrier,
                carrierExtra: candidate.carrier.extra,
                branchContent: candidate.content,
                marker: clone(candidate.marker),
                hadExtra: hasOwn(candidate.carrier, 'extra'),
            });
            const claims = claimsByCarrier.get(candidate.carrier) || [];
            claims.push(claim);
            claimsByCarrier.set(candidate.carrier, claims);
        }
    }

    const mutations = [];
    for (const claims of claimsByCarrier.values()) {
        if (claims.length === 1) mutations.push(claims[0]);
    }
    return Object.freeze({ mutations: Object.freeze(mutations) });
}

export function tableFillReviewSwipeMarkerCleanupMatches(context, plan) {
    return (plan?.mutations || []).every(mutation => {
        const message = context?.chat?.[mutation.index];
        return message === mutation.message
            && String(message?.mes ?? '') === mutation.currentContent
            && tableFillReviewTargetMatchesContent(mutation.target, message?.mes)
            && sameSerializedValue(
                message?.extra?.[SECONDARY_REVIEW_PENDING_KEY],
                mutation.currentMarker,
            )
            && message.swipes === mutation.swipes
            && mutation.swipes.length === mutation.swipesLength
            && message.swipe_info === mutation.swipeInfo
            && mutation.swipeInfo.length === mutation.swipeInfoLength
            && String(mutation.swipes[mutation.branchIndex] ?? '')
                === mutation.branchContent
            && mutation.swipeInfo[mutation.branchIndex] === mutation.carrier
            && mutation.carrier.extra === mutation.carrierExtra
            && tableFillReviewTargetMatchesContent(
                mutation.target,
                mutation.swipes[mutation.branchIndex],
            )
            && sameSerializedValue(
                mutation.carrier?.extra?.[SECONDARY_REVIEW_PENDING_KEY],
                mutation.marker,
            );
    });
}

export function applyTableFillReviewSwipeMarkerCleanup(plan) {
    for (const mutation of plan?.mutations || []) {
        delete mutation.carrier.extra?.[SECONDARY_REVIEW_PENDING_KEY];
    }
}

function tableFillReviewSwipeMarkerCleanupMutationIsStaged(context, mutation) {
    const message = context?.chat?.[mutation.index];
    const extra = mutation.carrier?.extra;
    return message === mutation.message
        && String(message?.mes ?? '') === mutation.currentContent
        && message.swipes === mutation.swipes
        && mutation.swipes.length === mutation.swipesLength
        && message.swipe_info === mutation.swipeInfo
        && mutation.swipeInfo.length === mutation.swipeInfoLength
        && String(mutation.swipes[mutation.branchIndex] ?? '')
            === mutation.branchContent
        && mutation.swipeInfo[mutation.branchIndex] === mutation.carrier
        && extra === mutation.carrierExtra
        && Boolean(extra)
        && !hasOwn(extra, SECONDARY_REVIEW_PENDING_KEY);
}

export function tableFillReviewSwipeMarkerCleanupIsStaged(context, plan) {
    return (plan?.mutations || []).every(mutation => (
        tableFillReviewSwipeMarkerCleanupMutationIsStaged(context, mutation)
    ));
}

export function restoreTableFillReviewSwipeMarkerCleanup(context, plan) {
    for (const mutation of plan?.mutations || []) {
        if (!tableFillReviewSwipeMarkerCleanupMutationIsStaged(context, mutation)) continue;
        mutation.carrierExtra[SECONDARY_REVIEW_PENDING_KEY] = clone(mutation.marker);
    }
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

    const evidenceIndexes = new Set();
    const locationsByIndex = new Map();
    const getLocations = index => {
        if (!locationsByIndex.has(index)) {
            locationsByIndex.set(index, collectTableFillReviewLocations(context, index));
        }
        return locationsByIndex.get(index);
    };
    for (let index = 0; index < chat.length; index += 1) {
        const locations = getLocations(index);
        if (locations.some(location => hasOwn(
            location.carrier?.extra,
            SECONDARY_REVIEW_PENDING_KEY,
        ))) {
            evidenceIndexes.add(index);
        }
    }

    const targetStates = [];
    const statesByRecord = new Map();
    for (const record of originalRecords) {
        const recordStates = [];
        for (const target of record.targets || []) {
            const index = Number(target?.index);
            if (Number.isSafeInteger(index) && index >= 0 && index < chat.length) {
                evidenceIndexes.add(index);
            }
            const resolution = resolveTableFillReviewTargetEvidence(
                context,
                target,
                record.id,
            );
            const state = { record, target, resolution, kind: resolution.kind };
            targetStates.push(state);
            recordStates.push(state);
        }
        statesByRecord.set(record, recordStates);
    }

    // A missing marker may infer ownership only when exactly one record claims
    // that physical branch. Exact review-id evidence wins over inference; all
    // other collisions remain retained but deliberately non-actionable.
    const claimsByLocation = new Map();
    for (const state of targetStates) {
        if (!state.resolution.location
            || !['exact', 'inferred'].includes(state.kind)) continue;
        const key = state.resolution.location.key;
        const claims = claimsByLocation.get(key) || [];
        claims.push(state);
        claimsByLocation.set(key, claims);
    }
    const ownerByLocation = new Map();
    for (const [key, claims] of claimsByLocation) {
        if (claims.length === 1) {
            ownerByLocation.set(key, claims[0]);
            continue;
        }
        const exactClaims = claims.filter(state => state.kind === 'exact');
        if (exactClaims.length === 1) {
            ownerByLocation.set(key, exactClaims[0]);
            for (const claim of claims) {
                if (claim !== exactClaims[0]) claim.kind = 'ambiguous';
            }
        } else {
            for (const claim of claims) claim.kind = 'ambiguous';
        }
    }

    const nextRecords = [];
    let trimmedRecordCount = 0;
    let removedRecordCount = 0;
    for (const record of originalRecords) {
        const retainedTargets = (statesByRecord.get(record) || [])
            .filter(state => state.kind !== 'stale')
            .map(state => state.target);
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

    const associatedMarkerLocations = new Set();
    const protectedMarkerLocations = new Set();
    for (const state of targetStates) {
        for (const location of state.resolution.exactMarkers) {
            associatedMarkerLocations.add(location.key);
        }
        if (state.resolution.exactMarkers.length > 1) {
            for (const location of state.resolution.exactMarkers) {
                protectedMarkerLocations.add(location.key);
            }
        }
    }

    const recoveryGroups = new Map();
    for (const locations of locationsByIndex.values()) {
        for (const location of locations) {
            if (!location.reviewPending
                || associatedMarkerLocations.has(location.key)) continue;
            const markerReviewId = typeof location.marker?.reviewId === 'string'
                ? location.marker.reviewId
                : '';
            const reusableMarkerId = markerReviewId
                && markerReviewId.length <= 200
                && !recordsById.has(markerReviewId);
            // A hidden marker cannot be rewritten by the existing atomic
            // reconciliation transaction. Recover it only when its own id can
            // be retained byte-for-byte.
            if (location.hidden && !reusableMarkerId) continue;
            const groupKey = reusableMarkerId
                ? `marker:${markerReviewId}`
                : `location:${location.key}`;
            const group = recoveryGroups.get(groupKey) || {
                id: reusableMarkerId ? markerReviewId : null,
                locations: [],
                createdAt: Number.isFinite(location.marker?.createdAt)
                    ? location.marker.createdAt
                    : now,
            };
            group.locations.push(location);
            recoveryGroups.set(groupKey, group);
        }
    }

    const usedReviewIds = new Set(nextRecords.map(record => record.id));
    let recoveredRecordCount = 0;
    for (const [groupKey, group] of recoveryGroups) {
        const indexes = group.locations.map(location => location.index);
        if (new Set(indexes).size !== indexes.length) {
            // Repeated markers on two branches of one floor do not establish
            // which branch owns the record. Preserve every carrier unchanged.
            for (const location of group.locations) {
                protectedMarkerLocations.add(location.key);
            }
            const currentLocation = group.locations.find(location => !location.hidden);
            const hasHiddenLocation = group.locations.some(location => location.hidden);
            // When the selected message itself is locked, retaining only the
            // markers would leave no review-center entry capable of explaining
            // or releasing that lock. Rebuild one representative target under
            // the original marker id. Resolution deliberately sees the two
            // exact physical locations and classifies this record ambiguous,
            // so neither edit nor retry can choose a branch implicitly.
            if (group.id && currentLocation && hasHiddenLocation
                && !usedReviewIds.has(group.id)) {
                const recoveryRecord = createTableFillReviewRecord({
                    id: group.id,
                    source: 'secondary-recovery',
                    error: {
                        phase: 'reconcile',
                        code: 'TABLE_FILL_REVIEW_AMBIGUOUS_RECOVERED',
                        message: '同一楼层的当前正文与隐藏滑动分支都保留了同一审查标记；已恢复为仅可检查的冲突工单。',
                    },
                    rawResponse: '',
                    attempts: 1,
                    targetMessages: [Object.freeze({
                        index: currentLocation.index,
                        msg: currentLocation.message,
                    })],
                    tableState,
                    createdAt: group.createdAt,
                    updatedAt: now,
                });
                usedReviewIds.add(recoveryRecord.id);
                nextRecords.push(recoveryRecord);
                recoveredRecordCount += 1;
            }
            continue;
        }
        const targetMessages = group.locations.map(location => Object.freeze({
            index: location.index,
            msg: location.hidden
                ? Object.freeze({ is_user: false, mes: location.content })
                : location.message,
        }));
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
            targetMessages,
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
                targetMessages,
                tableState,
                createdAt: group.createdAt,
                updatedAt: now,
            });
        }
        usedReviewIds.add(recoveryRecord.id);
        nextRecords.push(recoveryRecord);
        recoveredRecordCount += 1;
        for (const location of group.locations) {
            const target = recoveryRecord.targets.find(item => item.index === location.index);
            ownerByLocation.set(location.key, Object.freeze({
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
        const currentLocation = getLocations(index)
            .find(location => !location.hidden);
        if (!currentLocation
            || protectedMarkerLocations.has(currentLocation.key)) continue;
        const existingMarker = message.extra?.[SECONDARY_REVIEW_PENDING_KEY];
        const wasReviewPending = getTableFillMessageProgress(message).reviewPending;
        const owner = ownerByLocation.get(currentLocation.key);
        const desiredMarker = owner?.record && owner?.target
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
    const currentTargets = [];
    const hiddenTargets = [];
    const ambiguousTargets = [];
    const staleTargets = [];
    for (const target of record?.targets || []) {
        const evidence = resolveTableFillReviewTargetEvidence(
            context,
            target,
            record.id,
        );
        const location = evidence.kind === 'exact' ? evidence.location : null;
        const resolved = Object.freeze({
            index: target.index,
            msg: context?.chat?.[target.index],
            hash: target.contentHash,
            contentLength: target.contentLength,
            contentFingerprint: target.contentFingerprint,
            ...(location?.hidden ? {
                hidden: true,
                branchIndex: location.branchIndex,
            } : {}),
        });
        if (location && !location.hidden) {
            currentTargets.push(resolved);
        } else if (location?.hidden) {
            hiddenTargets.push(resolved);
        } else {
            staleTargets.push(resolved);
            if (evidence.kind === 'ambiguous') ambiguousTargets.push(resolved);
        }
    }
    const targetCount = record?.targets?.length || 0;
    return Object.freeze({
        currentTargets: Object.freeze(currentTargets),
        hiddenTargets: Object.freeze(hiddenTargets),
        ambiguousTargets: Object.freeze(ambiguousTargets),
        staleTargets: Object.freeze(staleTargets),
        allCurrent: currentTargets.length === targetCount,
        allRetained: currentTargets.length + hiddenTargets.length === targetCount,
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
