import { isSafeSourceBoundary } from '../time-river/unicode-boundary.js';

function assertWellFormedText(text) {
    if (typeof text !== 'string') {
        throw new TypeError('Unicode boundary input must be a string.');
    }
    for (let index = 0; index < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            const next = text.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) {
                throw new TypeError('Unicode boundary input contains an unpaired high surrogate.');
            }
            index += 1;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            throw new TypeError('Unicode boundary input contains an unpaired low surrogate.');
        }
    }
    return text;
}

function assertSearchRange(text, offset, bound, direction) {
    if (!Number.isSafeInteger(offset)
        || !Number.isSafeInteger(bound)
        || offset < 0
        || offset > text.length
        || bound < 0
        || bound > text.length
        || (direction === 'before' && bound > offset)
        || (direction === 'after' && bound < offset)
        || !isSafeSourceBoundary(text, bound)) {
        throw new RangeError('Unicode boundary search range is invalid.');
    }
}

function findBoundaryAtOrBefore(text, offset, lowerBound) {
    for (let cursor = offset; cursor >= lowerBound; cursor -= 1) {
        if (isSafeSourceBoundary(text, cursor)) return cursor;
    }
    return lowerBound;
}

function findBoundaryAtOrAfter(text, offset, upperBound) {
    for (let cursor = offset; cursor <= upperBound; cursor += 1) {
        if (isSafeSourceBoundary(text, cursor)) return cursor;
    }
    return upperBound;
}

/** Validate one source once, then reuse its boundary search methods. */
export function createUnicodeBoundaryNavigator(text) {
    assertWellFormedText(text);
    return Object.freeze({
        atOrBefore(offset, lowerBound = 0) {
            assertSearchRange(text, offset, lowerBound, 'before');
            return findBoundaryAtOrBefore(text, offset, lowerBound);
        },
        atOrAfter(offset, upperBound = text.length) {
            assertSearchRange(text, offset, upperBound, 'after');
            return findBoundaryAtOrAfter(text, offset, upperBound);
        },
    });
}

/** Find the nearest pinned Unicode-safe UTF-16 boundary at or before offset. */
export function findUnicodeBoundaryAtOrBefore(text, offset, lowerBound = 0) {
    return createUnicodeBoundaryNavigator(text).atOrBefore(offset, lowerBound);
}

/** Find the nearest pinned Unicode-safe UTF-16 boundary at or after offset. */
export function findUnicodeBoundaryAtOrAfter(text, offset, upperBound = text.length) {
    return createUnicodeBoundaryNavigator(text).atOrAfter(offset, upperBound);
}

/**
 * Fixed-budget adapter for modules that do not need semantic boundary scoring.
 * A single grapheme cluster may exceed maxCodeUnits; it is kept intact instead
 * of being split or dropped.
 */
export function splitTextByUnicodeBoundary(text, {
    maxCodeUnits,
    overlapCodeUnits = 0,
} = {}) {
    const boundaries = createUnicodeBoundaryNavigator(text);
    if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits <= 0) {
        throw new RangeError('maxCodeUnits must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(overlapCodeUnits) || overlapCodeUnits < 0) {
        throw new RangeError('overlapCodeUnits must be a non-negative safe integer.');
    }
    if (!text) return [];

    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const desiredEnd = Math.min(start + maxCodeUnits, text.length);
        let end = boundaries.atOrBefore(desiredEnd, start);
        if (end === start && desiredEnd < text.length) {
            end = boundaries.atOrAfter(desiredEnd, text.length);
        }
        if (end <= start) {
            throw new RangeError('Unable to advance to a Unicode-safe text boundary.');
        }

        chunks.push(text.slice(start, end));
        if (end >= text.length) break;

        const desiredStart = Math.max(end - overlapCodeUnits, start + 1);
        const nextStart = boundaries.atOrAfter(desiredStart, end);
        start = nextStart > start ? nextStart : end;
    }
    return chunks;
}

/** Return a bounded preview without ending inside a Unicode grapheme cluster. */
export function truncateTextAtUnicodeBoundary(text, maxCodeUnits) {
    const boundaries = createUnicodeBoundaryNavigator(text);
    if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) {
        throw new RangeError('maxCodeUnits must be a non-negative safe integer.');
    }
    if (text.length <= maxCodeUnits) return text;
    if (maxCodeUnits === 0) return '';
    let end = boundaries.atOrBefore(maxCodeUnits, 0);
    if (end === 0) {
        end = boundaries.atOrAfter(maxCodeUnits, text.length);
    }
    return text.slice(0, end);
}
