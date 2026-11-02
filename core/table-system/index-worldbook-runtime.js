import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { projectIndexWorldbook, previewIndexWorldbookMatches, INDEX_WORLDBOOK_NAMESPACE } from './index-worldbook.js';
import { normalizeQueryIndexes } from './query-indexes.js';
import { INDEX_WORLDBOOK_CONFIG_KEY as KEY, normalizeIndexWorldbookConfig, normalizeIndexWorldbookBinding,
    normalizeIndexWorldbookOptions, indexWorldbookSchemaSignature, indexWorldbookSchemaMatches, indexWorldbookError, validIndexWorldbookId } from './index-worldbook-config.js';

const LORE_KEYS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
const fail = code => { throw indexWorldbookError(code); };
const revision = value => Number.isSafeInteger(value) && value >= 0;

export function indexWorldbookChatOwner(context) {
    const scope = captureChatScope(context);
    const avatar = context?.characters?.[context.characterId]?.avatar;
    if (!scope.chatId || context.groupId || typeof avatar !== 'string' || !avatar || avatar.length > 512) {
        fail('INDEX_WORLDBOOK_CHAT_UNAVAILABLE');
    }
    return JSON.stringify([scope.chatId, avatar]);
}

/**
 * Trusted host boundary:
 * readAccess({scope, tableId, groupId}) -> {allowed, owner:'user', groupId,
 *   columnIds, authorizationRevision, groupRevision}. Revisions must come from
 * the real authorization/group lifecycle; there is deliberately no fallback.
 * commit(transaction) uses the shared auxiliary persistence queue.
 * readPersistedConfig({context,scope,owner,key}) reads the saved target, not the
 * staged in-memory metadata. It must not log chat bodies or credentials.
 */
export function createIndexWorldbookRuntime(host) {
    for (const method of ['getContext', 'getTables', 'getStateRevision', 'readAccess', 'commit', 'readPersistedConfig']) {
        if (typeof host?.[method] !== 'function') fail('INDEX_WORLDBOOK_ADAPTER_REQUIRED');
    }
    const getOwner = host.getOwnerIdentity || indexWorldbookChatOwner;
    const ownedEntries = new WeakSet();
    const issuedTickets = new WeakMap();
    const payloads = new Set();
    let busy = false;
    let stalled = false;
    let recovery = null;
    let disposed = false;
    let epoch = 0;
    let status = { state: 'idle', entries: 0 };

    function clear(payload) {
        for (const key of LORE_KEYS) {
            const list = payload?.[key];
            if (!Array.isArray(list)) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                // Never trust a comment/namespace alone to claim another extension's entry.
                if (ownedEntries.has(list[i])) list.splice(i, 1);
            }
        }
    }
    function invalidate() {
        epoch++;
        for (const payload of payloads) clear(payload);
        payloads.clear();
        status = { state: stalled ? 'stalled' : 'idle', entries: 0 };
        try { host.generationAdapter?.invalidate(); }
        catch (error) { status = { state: 'blocked', entries: 0, code: 'INDEX_WORLDBOOK_CLEAR_FAILED' }; throw error; }
    }
    function base() {
        if (disposed || busy || stalled) fail(stalled ? 'INDEX_WORLDBOOK_STALLED' : 'INDEX_WORLDBOOK_UNAVAILABLE');
        const context = host.getContext();
        const scope = captureChatScope(context);
        if (!scope.chatId || !scope.chatRef || !scope.metadataRef || context.groupId) fail('INDEX_WORLDBOOK_CHAT_UNAVAILABLE');
        const owner = getOwner(context);
        const raw = context.chatMetadata[KEY];
        const config = normalizeIndexWorldbookConfig(raw, owner);
        const stateRevision = host.getStateRevision();
        if (!revision(stateRevision)) fail('INDEX_WORLDBOOK_REVISION_REQUIRED');
        return { context, scope, owner, config, stateRevision, raw, image: JSON.stringify(config), epoch };
    }
    function access(tableId, groupId, captured) {
        if (![tableId, groupId].every(validIndexWorldbookId)) fail('WORLDBOOK_ACCESS_DENIED');
        const grant = host.readAccess({ scope: captured.scope, tableId, groupId });
        if (grant?.allowed !== true || grant.owner !== 'user' || grant.groupId !== groupId
            || !revision(grant.authorizationRevision) || !revision(grant.groupRevision)
            || !Array.isArray(grant.columnIds) || !grant.columnIds.length || grant.columnIds.length > 128
            || !grant.columnIds.every(validIndexWorldbookId) || new Set(grant.columnIds).size !== grant.columnIds.length) {
            fail('WORLDBOOK_ACCESS_DENIED');
        }
        // Read only after authorization. getTables supplies the current scoped store, never a global fallback.
        const tables = host.readTableSchema
            ? [host.readTableSchema({ scope: captured.scope, tableId, groupId })]
            : host.getTables(captured.scope);
        if (!Array.isArray(tables)) fail('WORLDBOOK_ACCESS_DENIED');
        const matches = tables.filter(item => item?.id === tableId);
        const table = matches[0];
        if (matches.length !== 1 || table?.owner !== 'user' || table.groupId !== groupId) fail('WORLDBOOK_ACCESS_DENIED');
        if (!Array.isArray(table.columns) || !table.columns.length || table.columns.length > 128
            || !table.columns.every(column => validIndexWorldbookId(column?.id))
            || new Set(table.columns.map(column => column.id)).size !== table.columns.length) fail('WORLDBOOK_SCHEMA_INVALID');
        return { table, grant: { owner: 'user', groupId, columnIds: [...grant.columnIds],
            authorizationRevision: grant.authorizationRevision, groupRevision: grant.groupRevision } };
    }
    function assertBase(captured, expectedImage = captured.image) {
        const current = host.getContext();
        if (disposed || stalled || captured.epoch !== epoch || !chatScopesMatch(captured.scope, captureChatScope(current))
            || getOwner(current) !== captured.owner || host.getStateRevision() !== captured.stateRevision
            || JSON.stringify(normalizeIndexWorldbookConfig(current.chatMetadata[KEY], captured.owner)) !== expectedImage) {
            fail('INDEX_WORLDBOOK_STALE');
        }
    }
    function assertAccess(captured, tableId, groupId, expected) {
        const current = access(tableId, groupId, captured);
        if (JSON.stringify(current.grant) !== JSON.stringify(expected.grant)) fail('INDEX_WORLDBOOK_STALE');
        return current;
    }
    function project(binding, captured, permission) {
        if (!indexWorldbookSchemaMatches(binding.schemaSignature, permission.table, binding.indexId, binding.contentColumnIds)) {
            fail('INDEX_WORLDBOOK_RECONFIRM_REQUIRED');
        }
        const options = {
            snapshot: { chatId: captured.scope.chatId, epoch: captured.scope.epoch, groupId: binding.groupId,
                stateRevision: captured.stateRevision, authorizationRevision: permission.grant.authorizationRevision,
                configRevision: captured.config.revision },
            contentColumnIds: binding.contentColumnIds,
            ...(binding.primaryColumnId ? { primaryColumnId: binding.primaryColumnId } : {}),
            ...(binding.termSeparator ? { termSeparator: binding.termSeparator } : {}),
        };
        return host.project ? host.project({ scope: captured.scope, binding, options, grant: permission.grant })
            : projectIndexWorldbook(permission.table, binding.indexId, options, permission.grant);
    }
    function inspect(tableId, groupId) {
        const captured = base();
        const permission = access(tableId, groupId, captured);
        // Opaque handles must not expose the unfiltered table or mutable authorization snapshot to GUI callers.
        const ticket = Object.freeze({});
        issuedTickets.set(ticket, { captured, tableId, groupId, permission });
        const indexes = normalizeQueryIndexes(permission.table).filter(item => item.mode === 'keywords'
            && item.columnIds.every(id => permission.grant.columnIds.includes(id)));
        assertBase(captured);
        assertAccess(captured, tableId, groupId, permission);
        return { ticket, tableId, groupId, name: String(permission.table.name ?? tableId),
            columns: permission.table.columns.filter(item => permission.grant.columnIds.includes(item.id))
                .map(item => ({ id: item.id, label: String(item.label ?? item.id) })),
            indexes: structuredClone(indexes),
            binding: structuredClone(captured.config.bindings.find(item => item.tableId === tableId && item.groupId === groupId) ?? null) };
    }
    function listBindings() {
        const captured = base();
        return captured.config.bindings.map(({ tableId, groupId, enabled }) => ({ tableId, groupId, enabled }));
    }
    function listDependencies(tableId) {
        if (!validIndexWorldbookId(tableId)) fail('INDEX_WORLDBOOK_CONFIG_INVALID');
        const captured = base();
        return captured.config.bindings.filter(binding => binding.tableId === tableId).map(binding => ({
            kind: 'index-worldbook', tableId: binding.tableId, groupId: binding.groupId, indexId: binding.indexId,
            enabled: binding.enabled, configRevision: captured.config.revision,
            contentColumnIds: [...binding.contentColumnIds],
        }));
    }
    function inspectRemoval(tableId, groupId) {
        const captured = base();
        if (!captured.config.bindings.some(item => item.tableId === tableId && item.groupId === groupId)) {
            fail('INDEX_WORLDBOOK_MAPPING_NOT_FOUND');
        }
        const ticket = Object.freeze({});
        // A removal-only ticket grants no table read, preview, replacement or enable operation.
        issuedTickets.set(ticket, { captured, tableId, groupId, removalOnly: true });
        return { ticket, tableId, groupId, name: tableId, removalOnly: true };
    }
    function prepare(ticket, options) {
        const issued = issuedTickets.get(ticket);
        if (!issued || issued.removalOnly) fail('INDEX_WORLDBOOK_TICKET_INVALID');
        options = normalizeIndexWorldbookOptions(options);
        assertBase(issued.captured);
        const permission = assertAccess(issued.captured, issued.tableId, issued.groupId, issued.permission);
        const binding = normalizeIndexWorldbookBinding({ ...options, tableId: issued.tableId, groupId: issued.groupId,
            schemaSignature: indexWorldbookSchemaSignature(permission.table, options.indexId, options.contentColumnIds) });
        return { issued, permission, binding };
    }
    function preview(ticket, options, sample) {
        const { issued, permission, binding } = prepare(ticket, options);
        const result = project(binding, issued.captured, permission);
        assertBase(issued.captured);
        assertAccess(issued.captured, issued.tableId, issued.groupId, permission);
        return structuredClone(sample === undefined ? result : { ...result, sampleMatches: previewIndexWorldbookMatches(result, sample) });
    }
    async function persist(ticket, binding) {
        const issued = issuedTickets.get(ticket);
        if (!issued) fail('INDEX_WORLDBOOK_TICKET_INVALID');
        if (binding && issued.removalOnly) fail('INDEX_WORLDBOOK_TICKET_INVALID');
        const { captured, tableId, groupId, permission } = issued;
        if (busy || stalled || disposed) fail('INDEX_WORLDBOOK_UNAVAILABLE');
        assertBase(captured);
        const bindings = captured.config.bindings.filter(item => item.tableId !== tableId || item.groupId !== groupId);
        if (binding) bindings.push(binding);
        const candidate = normalizeIndexWorldbookConfig({ ...captured.config, revision: captured.config.revision + 1, bindings }, captured.owner);
        const image = JSON.stringify(candidate);
        let staged = null;
        busy = true;
        for (const payload of payloads) clear(payload);
        try {
            const saved = await host.commit({ expectedChatId: captured.scope.chatId, expectedChatScope: captured.scope,
                strictExpectedChatScope: true, expectedStateRevision: captured.stateRevision, retainedCost: image.length * 2 + 4096,
                beforeSave: ({ context }) => {
                    assertBase(captured);
                    if (binding) {
                        const current = assertAccess(captured, tableId, groupId, permission);
                        if (binding.enabled) project(binding, captured, current);
                    }
                    if (context.chatMetadata !== captured.scope.metadataRef) fail('INDEX_WORLDBOOK_STALE');
                    staged = structuredClone(candidate);
                    context.chatMetadata[KEY] = staged;
                },
                rollback: ({ context }) => {
                    // Unknown durable outcome is not permission to restore a possibly superseded value.
                    stalled = staged !== null;
                    if (context.chatMetadata === captured.scope.metadataRef && context.chatMetadata[KEY] === staged) {
                        if (captured.raw === undefined) delete context.chatMetadata[KEY];
                        else context.chatMetadata[KEY] = captured.raw;
                    }
                },
            });
            if (saved !== true) fail('INDEX_WORLDBOOK_SAVE_FAILED');
            assertBase(captured, image);
            if (binding) assertAccess(captured, tableId, groupId, permission);
            const persisted = await host.readPersistedConfig({ context: captured.context, scope: captured.scope, owner: captured.owner, key: KEY });
            assertBase(captured, image);
            if (binding) assertAccess(captured, tableId, groupId, permission);
            if (JSON.stringify(normalizeIndexWorldbookConfig(persisted, captured.owner)) !== image) fail('INDEX_WORLDBOOK_READBACK_FAILED');
            issuedTickets.delete(ticket);
            status = { state: 'saved', entries: 0 };
            return { saved: true, revision: candidate.revision };
        } catch (error) {
            if (staged === null) {
                // Admission/auth failures before staging cannot have saved this
                // candidate. Do not manufacture an uncertain durable outcome.
                stalled = false; recovery = null; invalidate();
                status = { state: 'blocked', entries: 0, code: 'INDEX_WORLDBOOK_SAVE_NOT_STARTED' };
                throw error;
            }
            stalled = true;
            recovery = { owner: captured.owner, targetScope: captured.scope, previousImage: captured.image, candidateImage: image };
            status = { state: 'stalled', entries: 0, code: 'INDEX_WORLDBOOK_PERSISTENCE_UNCERTAIN' };
            throw error;
        } finally { busy = false; }
    }
    async function save(ticket, options) {
        const { issued, permission, binding } = prepare(ticket, options);
        // Saving an enabled mapping is the explicit confirmation; preview alone never authorizes it.
        if (binding.enabled) project(binding, issued.captured, permission);
        return persist(ticket, binding);
    }
    async function disable(ticket) {
        if (!issuedTickets.has(ticket)) fail('INDEX_WORLDBOOK_TICKET_INVALID');
        return persist(ticket, null);
    }
    async function recover() {
        if (disposed || busy || !stalled || !recovery || typeof host.recoverPersistedConfig !== 'function') {
            fail('INDEX_WORLDBOOK_RECOVERY_UNAVAILABLE');
        }
        const expected = recovery;
        if (typeof host.recoverSharedWrite === 'function') {
            const openingScope = captureChatScope(host.getContext());
            const openingEpoch = epoch;
            busy = true;
            try {
                await host.recoverSharedWrite();
                if (disposed || recovery !== expected || openingEpoch !== epoch
                    || !chatScopesMatch(openingScope, captureChatScope(host.getContext()))) fail('INDEX_WORLDBOOK_STALE');
            } catch (error) {
                status = { state: 'stalled', entries: 0, code: 'INDEX_WORLDBOOK_PERSISTENCE_UNCERTAIN' };
                throw error;
            } finally { busy = false; }
        }
        const context = host.getContext();
        const scope = captureChatScope(context);
        if (getOwner(context) !== expected.owner) fail('INDEX_WORLDBOOK_RECOVERY_WRONG_CHAT');
        const raw = context.chatMetadata[KEY];
        const image = JSON.stringify(normalizeIndexWorldbookConfig(raw, expected.owner));
        const known = value => value === expected.previousImage || value === expected.candidateImage;
        if (!known(image)) fail('INDEX_WORLDBOOK_RECOVERY_CONFLICT');
        const expectedEpoch = epoch;
        const stateRevision = host.getStateRevision();
        if (!revision(stateRevision)) fail('INDEX_WORLDBOOK_REVISION_REQUIRED');
        busy = true;
        let accepted = false;
        let outcome;
        let acceptedRaw;
        try {
            await host.recoverPersistedConfig({ scope, targetScope: expected.targetScope, owner: expected.owner, key: KEY }, persisted => {
                const current = host.getContext();
                if (disposed || recovery !== expected || expectedEpoch !== epoch
                    || !chatScopesMatch(scope, captureChatScope(current)) || getOwner(current) !== expected.owner
                    || host.getStateRevision() !== stateRevision || current.chatMetadata[KEY] !== raw
                    || JSON.stringify(normalizeIndexWorldbookConfig(current.chatMetadata[KEY], expected.owner)) !== image) {
                    fail('INDEX_WORLDBOOK_STALE');
                }
                const config = normalizeIndexWorldbookConfig(persisted, expected.owner);
                if (!known(JSON.stringify(config))) fail('INDEX_WORLDBOOK_RECOVERY_CONFLICT');
                outcome = JSON.stringify(config) === expected.candidateImage ? 'candidate' : 'previous';
                // Reconcile only this key, inside the host persistence lane.
                // A confirmed disk candidate is not a new save or a new consent.
                if (persisted === undefined) delete current.chatMetadata[KEY];
                else current.chatMetadata[KEY] = structuredClone(config);
                acceptedRaw = current.chatMetadata[KEY];
                accepted = true;
            });
            if (!accepted) fail('INDEX_WORLDBOOK_READBACK_FAILED');
            const current = host.getContext();
            if (disposed || expectedEpoch !== epoch || !chatScopesMatch(scope, captureChatScope(current))
                || getOwner(current) !== expected.owner || host.getStateRevision() !== stateRevision
                || current.chatMetadata[KEY] !== acceptedRaw
                || JSON.stringify(normalizeIndexWorldbookConfig(acceptedRaw, expected.owner))
                    !== (outcome === 'candidate' ? expected.candidateImage : expected.previousImage)) fail('INDEX_WORLDBOOK_STALE');
            stalled = false; recovery = null; invalidate();
            status = { state: 'recovered', entries: 0, outcome };
            return { recovered: true, outcome };
        } catch (error) {
            status = { state: 'stalled', entries: 0, code: 'INDEX_WORLDBOOK_PERSISTENCE_UNCERTAIN' };
            throw error;
        } finally { busy = false; }
    }
    function handleWorldInfo(payload) {
        clear(payload);
        // Only current-cycle payloads are retained. No data/projection cache survives a generation.
        for (const previous of payloads) if (previous !== payload) clear(previous);
        payloads.clear();
        payloads.add(payload);
        if (disposed || busy || stalled) return;
        try {
            const captured = base();
            let entries = [];
            const provenance = [];
            const permissions = [];
            for (const binding of captured.config.bindings.filter(item => item.enabled)) {
                const permission = access(binding.tableId, binding.groupId, captured);
                const projection = project(binding, captured, permission);
                permissions.push({ binding, permission });
                provenance.push(...projection.provenance);
                entries.push(...projection.entries.map((entry, index) => ({ ...entry,
                    world: JSON.stringify([INDEX_WORLDBOOK_NAMESPACE, captured.owner, binding.groupId, binding.tableId, binding.indexId]),
                    uid: index, position: 0, order: 100, depth: 4, role: 0, addMemo: true,
                })));
                if (entries.length > 200 || JSON.stringify(entries).length > 512 * 1024) fail('WORLDBOOK_LIMIT');
            }
            assertBase(captured);
            for (const { binding, permission } of permissions) {
                assertAccess(captured, binding.tableId, binding.groupId, permission);
            }
            assertBase(captured);
            if (!Array.isArray(payload?.chatLore)) fail('INDEX_WORLDBOOK_HOST_UNAVAILABLE');
            if (host.generationAdapter && entries.length) entries = host.generationAdapter.stage({
                scope: captured.scope, entries, provenance, isCurrent() {
                    assertBase(captured);
                    for (const { binding, permission } of permissions) {
                        assertAccess(captured, binding.tableId, binding.groupId, permission);
                    }
                    return true;
                },
            });
            for (const entry of entries) ownedEntries.add(entry);
            payload.chatLore.push(...entries);
            status = { state: host.generationAdapter ? 'candidates' : 'injected', entries: entries.length };
        } catch (error) {
            clear(payload);
            status = { state: 'blocked', entries: 0, code: /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INDEX_WORLDBOOK_INVALID' };
        }
    }
    async function finalizePrompt(payload) {
        try {
            const result = await host.generationAdapter?.finalize(payload);
            if (result) status = { state: 'finalized', ...result };
            return result;
        } catch (error) {
            status = { state: 'blocked', entries: 0,
                code: /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INDEX_WORLDBOOK_INVALID' };
            // The host emitter swallows listener errors, and OpenAI preparation
            // retains the original chat array. Remove it in place before abort.
            try {
                if (payload && typeof payload === 'object') {
                    if (typeof payload.prompt === 'string') payload.prompt = '';
                    if (Array.isArray(payload.chat)) payload.chat.splice(0);
                }
            } finally {
                try { await host.stopGeneration?.(); } finally { throw error; }
            }
        }
    }
    return { inspect, inspectRemoval, listBindings, listDependencies, preview, save, disable, recover, handleWorldInfo, finalizePrompt, invalidate,
        getStatus: () => ({ ...status }),
        dispose() { disposed = true; invalidate(); },
    };
}

/** Actual host bootstrap. Authorization and target-addressed disk readback are
 * required trusted adapters supplied by the owning integration, not UI/card data. */
export async function initializeIndexWorldbookRuntime({ readAccess, readPersistedConfig, ...overrides } = {}) {
    const [{ getContext }, script, { getMemoryStateForScope }, { getStateRevision },
        { commitAuxiliaryChatMutationAsync }] = await Promise.all([
        import('/scripts/extensions.js'), import('/script.js'), import('./manager.js'), import('./infra/store.js'), import('./infra/persistence.js'),
    ]);
    const { eventSource, event_types, stopGeneration } = script;
    const runtime = createIndexWorldbookRuntime({ getContext, getTables: getMemoryStateForScope, getStateRevision,
        commit: commitAuxiliaryChatMutationAsync, readAccess, readPersistedConfig, ...overrides, stopGeneration });
    if (!event_types.WORLDINFO_ENTRIES_LOADED) { runtime.dispose(); fail('INDEX_WORLDBOOK_HOST_UNAVAILABLE'); }
    if (typeof eventSource?.on !== 'function' || typeof eventSource?.removeListener !== 'function') {
        runtime.dispose(); fail('INDEX_WORLDBOOK_HOST_UNAVAILABLE');
    }
    let participates = !overrides.generationAdapter;
    const subscriptions = [[event_types.WORLDINFO_ENTRIES_LOADED, payload => {
        if (participates) return runtime.handleWorldInfo(payload);
    }]];
    if (overrides.generationAdapter) {
        if (typeof stopGeneration !== 'function' || !('main_api' in script)
            || !event_types.GENERATION_AFTER_COMMANDS) { runtime.dispose(); fail('INDEX_WORLDBOOK_HOST_UNAVAILABLE'); }
        subscriptions.push([event_types.GENERATION_AFTER_COMMANDS, type => {
            // This is the trusted host lifecycle argument, never a prompt field.
            participates = false;
            runtime.invalidate();
            participates = type !== 'quiet';
        }]);
        for (const name of ['GENERATE_AFTER_COMBINE_PROMPTS', 'CHAT_COMPLETION_PROMPT_READY']) {
            if (!event_types[name]) { runtime.dispose(); fail('INDEX_WORLDBOOK_HOST_UNAVAILABLE'); }
            // OpenAI Generate also emits an unused combined-text prompt first.
            // Read the live module binding, not a startup copy or payload flag.
            subscriptions.push([event_types[name], payload => {
                if (!participates) return;
                const chatCompletion = script.main_api === 'openai';
                if (chatCompletion !== (name === 'CHAT_COMPLETION_PROMPT_READY')) return;
                return runtime.finalizePrompt(payload);
            }]);
        }
    }
    for (const name of ['CHAT_CHANGED', 'CHAT_CREATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
        if (event_types[name]) subscriptions.push([event_types[name], runtime.invalidate]);
    }
    for (const [name, listener] of subscriptions) eventSource.on(name, listener);
    const dispose = runtime.dispose;
    runtime.dispose = () => {
        for (const [name, listener] of subscriptions) eventSource.removeListener(name, listener);
        dispose();
    };
    return runtime;
}
