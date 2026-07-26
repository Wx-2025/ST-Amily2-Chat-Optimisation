/**
 * Pure coordinator for table-store hydration.
 *
 * It keeps chat invalidation and the matching reload in one early lifecycle,
 * coalesces overlapping triggers, and prevents a delayed reload for chat A from
 * publishing after the host has already switched to chat B.
 */

export const TABLE_CHAT_RELOAD_DELAY_MS = 100;

/**
 * @param {{
 *   beginChatTransition: () => void,
 *   loadCurrentTables: (reason: string) => unknown,
 *   publishReady?: (detail: Readonly<{reason:string, revision:number}>) => void,
 *   onError?: (error: unknown, reason: string) => void,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} dependencies
 */
export function createTableLifecycleCoordinator(dependencies) {
    const beginChatTransition = dependencies?.beginChatTransition;
    const loadCurrentTables = dependencies?.loadCurrentTables;
    const publishReady = dependencies?.publishReady || (() => {});
    const onError = dependencies?.onError || ((error, reason) => {
        console.error(`[TableLifecycle] ${reason} 重载失败:`, error);
    });
    const setTimer = dependencies?.setTimer || globalThis.setTimeout;
    const clearTimer = dependencies?.clearTimer || globalThis.clearTimeout;

    if (typeof beginChatTransition !== 'function' || typeof loadCurrentTables !== 'function') {
        throw new TypeError('Table lifecycle requires transition and load callbacks.');
    }

    let ready = false;
    let chatSettling = false;
    let revision = 0;
    let timer = null;
    let deferredPublish = false;

    function cancelTimer() {
        if (timer === null) return;
        clearTimer(timer);
        timer = null;
    }

    function run(requestRevision, reason, shouldPublish) {
        if (!ready || requestRevision !== revision) return false;
        timer = null;
        try {
            loadCurrentTables(reason);
            if (requestRevision !== revision) return false;
            chatSettling = false;
            if (shouldPublish || deferredPublish) {
                deferredPublish = false;
                publishReady(Object.freeze({ reason, revision: requestRevision }));
            }
            return true;
        } catch (error) {
            // The persistence gate remains closed until a later load succeeds,
            // but the transition itself is no longer actively settling. This
            // allows authorization/manual reconciliation to retry instead of
            // being ignored forever after one failed chat load.
            chatSettling = false;
            onError(error, reason);
            return false;
        }
    }

    function schedule(reason, { delayMs = 0, publish = true } = {}) {
        revision += 1;
        const requestRevision = revision;
        cancelTimer();
        deferredPublish ||= publish;
        if (!ready) return requestRevision;

        timer = setTimer(
            () => run(requestRevision, reason, publish),
            Math.max(0, Number(delayMs) || 0),
        );
        return requestRevision;
    }

    function reconcileNow(reason, { publish = true } = {}) {
        revision += 1;
        const requestRevision = revision;
        cancelTimer();
        deferredPublish ||= publish;
        return run(requestRevision, reason, publish);
    }

    return Object.freeze({
        handleChatChanged() {
            revision += 1;
            cancelTimer();
            chatSettling = true;
            deferredPublish = true;
            beginChatTransition();
            return schedule('chat-changed', {
                delayMs: TABLE_CHAT_RELOAD_DELAY_MS,
                publish: true,
            });
        },

        handleChatLoaded() {
            chatSettling = false;
            return schedule('chat-loaded', { publish: true });
        },

        handleAuthorizationGranted() {
            deferredPublish = true;
            // A chat transition already has the authoritative reload queued.
            // Do not replace its settling delay with an immediate auth refresh.
            if (chatSettling) return revision;
            return schedule('authorization-granted', { publish: true });
        },

        markReady() {
            ready = true;
            if (chatSettling) {
                return schedule('settings-ready-after-chat-change', {
                    delayMs: TABLE_CHAT_RELOAD_DELAY_MS,
                    publish: true,
                });
            }
            return reconcileNow('settings-ready', { publish: false });
        },

        reconcile(reason = 'manual') {
            if (!ready) {
                deferredPublish = true;
                return schedule(reason, { publish: true });
            }
            return reconcileNow(reason, { publish: true });
        },

        getState() {
            return Object.freeze({ ready, chatSettling, revision, scheduled: timer !== null });
        },
    });
}

const readyListeners = new Set();
let reconcileRequestHandler = null;

export function publishTableLifecycleReady(detail) {
    for (const listener of readyListeners) {
        try {
            listener(detail);
        } catch (error) {
            console.error('[TableLifecycle] 表格就绪监听器执行失败:', error);
        }
    }
}

export function subscribeTableLifecycleReady(listener) {
    if (typeof listener !== 'function') return () => {};
    readyListeners.add(listener);
    return () => readyListeners.delete(listener);
}

/**
 * Register the live table-system reconciler without making compatibility
 * adapters import TableSystemService (which would create a UI/service cycle).
 */
export function registerTableLifecycleReconcileRequest(handler) {
    reconcileRequestHandler = typeof handler === 'function' ? handler : null;
    return () => {
        if (reconcileRequestHandler === handler) reconcileRequestHandler = null;
    };
}

/** Ask the live table lifecycle to reload and publish the current chat. */
export function requestTableLifecycleReconcile(reason = 'manual') {
    if (!reconcileRequestHandler) return false;
    return reconcileRequestHandler(reason);
}
