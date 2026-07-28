/**
 * Strict, single-request SillyTavern world-info persistence primitive.
 *
 * This module deliberately has no browser-only imports so the durability
 * contract can be covered by Node tests. Runtime adapters are supplied by
 * LoreService.
 */

function responseStatus(response) {
    const status = Number(response?.status);
    return Number.isFinite(status) ? status : 'unknown';
}

async function readResponseError(response) {
    try {
        const text = await response?.text?.();
        return String(text || '').trim().slice(0, 500);
    } catch {
        return '';
    }
}

function cloneWorldInfoData(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * Build an isolated world-info draft and persist it through a strict writer.
 *
 * The source returned by loadData is never handed to mutateDraft. This keeps
 * the host cache authoritative until persistDraft confirms a durable commit.
 * A mutator may return false or { changed: false } to cancel without writing.
 *
 * @param {{
 *   name: string,
 *   loadData: (name: string) => Promise<object|null|undefined>,
 *   mutateDraft: (
 *     draft: object,
 *     source: object|null|undefined,
 *   ) => Promise<unknown>|unknown,
 *   persistDraft: (name: string, draft: object) => Promise<unknown>,
 *   createEmptyData?: () => object,
 * }} options
 */
export async function commitWorldInfoMutationStrict({
    name,
    loadData,
    mutateDraft,
    persistDraft,
    createEmptyData = () => ({ entries: {} }),
}) {
    if (!String(name || '').trim()) {
        throw new TypeError('World-info name is required.');
    }
    if (typeof loadData !== 'function') {
        throw new TypeError('Strict world-info mutation requires a loader.');
    }
    if (typeof mutateDraft !== 'function') {
        throw new TypeError('Strict world-info mutation requires a mutator.');
    }
    if (typeof persistDraft !== 'function') {
        throw new TypeError('Strict world-info mutation requires a persister.');
    }

    const source = await loadData(name);
    const draft = source == null
        ? createEmptyData()
        : cloneWorldInfoData(source);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
        throw new TypeError('World-info draft must be an object.');
    }

    const mutation = await mutateDraft(draft, source);
    if (mutation === false || mutation?.changed === false) {
        return {
            ok: true,
            committed: false,
            changed: false,
            mutation,
        };
    }

    const persistence = await persistDraft(name, draft);
    if (persistence !== true && persistence?.committed !== true) {
        throw new Error(
            'Strict world-info persister did not confirm a durable commit.',
        );
    }

    return {
        ok: true,
        committed: true,
        changed: true,
        mutation,
    };
}

export async function persistWorldInfoStrict({
    name,
    data,
    fetchImpl,
    headers,
    cache,
    eventEmitter,
    updatedEvent,
    logger = console,
}) {
    if (!String(name || '').trim()) {
        throw new TypeError('World-info name is required.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new TypeError('World-info data must be an object.');
    }
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('Strict world-info persistence requires fetch.');
    }

    // Do not touch the host cache before the server acknowledges the commit.
    const response = await fetchImpl('/api/worldinfo/edit', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, data }),
    });
    if (!response?.ok) {
        const detail = await readResponseError(response);
        throw new Error(
            `World-info persistence failed with HTTP ${responseStatus(response)}`
            + (detail ? `: ${detail}` : '.'),
        );
    }

    // At this point the server is authoritative. Cache/event refresh failures
    // must not be reported as a failed commit because retrying could duplicate
    // an already durable archival operation.
    try {
        cache?.set?.(name, data);
    } catch (error) {
        logger?.warn?.('[LoreService] 世界书已提交，但更新本地缓存失败:', error);
    }
    try {
        if (eventEmitter?.emit && updatedEvent != null) {
            await eventEmitter.emit(updatedEvent, name, data);
        }
    } catch (error) {
        logger?.warn?.('[LoreService] 世界书已提交，但刷新 WORLDINFO_UPDATED 事件失败:', error);
    }

    return { ok: true, committed: true };
}
