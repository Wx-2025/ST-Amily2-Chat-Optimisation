import { getModuleAccessDecision } from '../../utils/module-access-policy.js';
import { subscribePluginAuthStatus } from '../../utils/auth-state.js';
import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';
import { isTablePersistenceScopeReady } from './infra/persistence-scope.js';
import { getStateRevision, subscribe as subscribeTableState } from './infra/store.js';
import { TABLE_STATE_METADATA_KEY, TABLE_STATE_FORMAT, TABLE_STATE_FORMAT_VERSION } from './infra/database-state.js';
import { resolveTableGroupRegistryForState, isUserTableCreationGroupId } from './table-groups.js';
import { captureChatSaveTarget, saveCapturedChatTarget } from './infra/chat-save-target.js';
import { commitAuxiliaryChatMutationAsync } from './infra/persistence.js';
import { getUncertainTableWrite, recoverUncertainTableWrite } from './infra/table-write-transaction.js';
import { enqueueTablePersistence } from './infra/publish-aware-transaction-queue.js';
import { INDEX_WORLDBOOK_CONFIG_KEY as KEY, indexWorldbookError } from './index-worldbook-config.js';
import { indexWorldbookChatOwner, initializeIndexWorldbookRuntime } from './index-worldbook-runtime.js';
import { createIndexWorldbookGeneration } from './index-worldbook-generation.js';
import { projectIndexWorldbook } from './index-worldbook.js';
import { normalizeQueryIndexes } from './query-indexes.js';

const fail = code => { throw indexWorldbookError(code); };
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 15000;

// The existing strict chat verifier has a private header reader. Keep this
// bounded adapter local rather than exporting or weakening the TDB facade.
async function readHeader(reader) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', offset = 0, bytes = 0, start = -1, depth = 0;
    let array = false, quoted = false, escaped = false;
    try {
        while (true) {
            const { value, done } = await reader.read();
            bytes += value?.byteLength ?? 0;
            if (bytes > MAX_HEADER_BYTES) fail('INDEX_WORLDBOOK_READBACK_LIMIT');
            text += done ? decoder.decode() : decoder.decode(value, { stream: true });
            for (; offset < text.length; offset++) {
                const character = text[offset];
                if (start < 0) {
                    if (!array) {
                        if (/\s|\uFEFF/u.test(character)) continue;
                        if (character !== '[') fail('INDEX_WORLDBOOK_READBACK_INVALID');
                        array = true;
                        continue;
                    }
                    if (/\s/u.test(character)) continue;
                    if (character !== '{') fail('INDEX_WORLDBOOK_READBACK_INVALID');
                    start = offset; depth = 1; continue;
                }
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (character === '\\') escaped = true;
                    else if (character === '"') quoted = false;
                    continue;
                }
                if (character === '"') { quoted = true; continue; }
                if (character === '{' || character === '[') depth++;
                else if (character === '}' || character === ']') depth--;
                if (depth > 64) fail('INDEX_WORLDBOOK_READBACK_LIMIT');
                if (!depth) {
                    try { return JSON.parse(text.slice(start, offset + 1)); }
                    catch { fail('INDEX_WORLDBOOK_READBACK_INVALID'); }
                }
            }
            if (done) fail('INDEX_WORLDBOOK_READBACK_INVALID');
        }
    } finally {
        // Do not consume or retain message bodies after the metadata header.
        try { await reader.cancel(); } catch { /* Stream already aborted. */ }
    }
}

/** Real module policy, registry and shared persistence; only host I/O/store
 * acquisition is replaceable in tests. There is no supplied `allowed` flag. */
export function createIndexWorldbookHostAdapter({ getContext, getTables, getRequestHeaders, fetchImpl = globalThis.fetch }) {
    if ([getContext, getTables, getRequestHeaders, fetchImpl].some(item => typeof item !== 'function')) {
        fail('INDEX_WORLDBOOK_ADAPTER_REQUIRED');
    }
    const savedTargets = new WeakMap();
    const recoveryTargets = new WeakMap();



    function assertCurrent(scope) {
        const context = getContext();
        if (!chatScopesMatch(scope, captureChatScope(context)) || !isTablePersistenceScopeReady(context) || context.groupId) {
            fail('INDEX_WORLDBOOK_STALE');
        }
        return context;
    }




    function readTableAccess({ scope, tableId, groupId }) {
        const context = assertCurrent(scope);
        const decision = getModuleAccessDecision('Table');
        if (!decision.allowed) fail('WORLDBOOK_ACCESS_DENIED');
        const tables = getTables(scope);
        if (!Array.isArray(tables)) fail('WORLDBOOK_ACCESS_DENIED');
        // Inspect metadata before projecting the selected columns.
        const envelope = context.chatMetadata?.[TABLE_STATE_METADATA_KEY];
        if (envelope?.format !== TABLE_STATE_FORMAT || envelope?.formatVersion !== TABLE_STATE_FORMAT_VERSION) {
            fail('INDEX_WORLDBOOK_STATE_UNAVAILABLE');
        }
        const registry = resolveTableGroupRegistryForState(tables, envelope.tableGroups);
        const group = registry.groups.find(item => item.id === groupId);
        // Compatibility groups require their own grants. This adapter never
        // turns Table's Type0 policy into access to shujuku/TDB or module data.
        if (!isUserTableCreationGroupId(groupId) || group?.kind !== 'user' || group.owner !== 'user'
            || group.readOnly !== false || group.aiAccess !== 'profile') fail('WORLDBOOK_ACCESS_DENIED');
        const matches = tables.filter(item => item?.id === tableId);
        const table = matches[0];
        if (matches.length !== 1 || table?.owner !== 'user' || table.groupId !== groupId || table.readOnly === true
            || !Array.isArray(table.columns)) fail('WORLDBOOK_ACCESS_DENIED');
        const columnIds = table.columns.filter(column => column?.hidden !== true && column.id !== 'is_delete').map(column => column.id);
        return { allowed: true, owner: 'user', groupId, columnIds,
            authorizationRevision: decision.revision, groupRevision: registry.revision };
    }
    function readTableSchema({ scope, tableId, groupId }) {
        readTableAccess({ scope, tableId, groupId });
        const table = getTables(scope).find(item => item.id === tableId);
        return structuredClone({ id: table.id, name: table.name, owner: table.owner, groupId: table.groupId,
            columns: table.columns, indexes: normalizeQueryIndexes(table) });
    }
    function project({ scope, binding, options, grant }) {
        const schema = readTableSchema({ scope, tableId: binding.tableId, groupId: binding.groupId });
        const index = schema.indexes.find(item => item.id === binding.indexId);
        if (!index) fail('INDEX_NOT_FOUND');
        readTableAccess({ scope, tableId: binding.tableId, groupId: binding.groupId });
        const table = getTables(scope).find(item => item.id === binding.tableId);
        return projectIndexWorldbook(table, binding.indexId, options, grant);
    }
    async function commit(transaction) {
        const scope = transaction.expectedChatScope;
        assertCurrent(scope);
        let captured = null;
        let committed;
        try { committed = await commitAuxiliaryChatMutationAsync({ ...transaction,
            beforeSave: args => {
                assertCurrent(scope);
                transaction.beforeSave(args);
                const target = captureChatSaveTarget(args.context, scope.chatId);
                if (target.endpoint !== '/api/chats/save') fail('INDEX_WORLDBOOK_CHAT_UNAVAILABLE');
                captured = { target, owner: indexWorldbookChatOwner(args.context) };
                const { ch_name, file_name, avatar_url } = target.body;
                recoveryTargets.set(scope, { owner: captured.owner, target: { body: { ch_name, file_name, avatar_url } } });
                savedTargets.set(scope, captured);
            },
            save: async () => {
                assertCurrent(scope);
                if (!captured) fail('INDEX_WORLDBOOK_CHAT_UNAVAILABLE');
                await saveCapturedChatTarget(captured.target, {
                    fetchImpl: (url, options) => fetchImpl(url, { ...options, redirect: 'error', credentials: 'same-origin' }),
                    headers: getRequestHeaders(),
                });
                assertCurrent(scope);
            },
        }); } catch (error) { savedTargets.delete(scope); throw error; }
        return committed;
    }
    async function readPersistedConfig({ scope, owner, key }) {
        const captured = savedTargets.get(scope);
        if (!captured || captured.owner !== owner || key !== KEY) fail('INDEX_WORLDBOOK_READBACK_UNAVAILABLE');
        try { return await readTargetConfig(scope, captured); }
        finally { savedTargets.delete(scope); }
    }
    async function recoverSharedWrite() {
        if (!getUncertainTableWrite(getContext())) return;
        // A config recovery may reconcile an auxiliary write, never publish
        // an unrelated table candidate through this narrower host adapter.
        await recoverUncertainTableWrite(() => fail('INDEX_WORLDBOOK_RECOVERY_FOREIGN_WRITE'));
    }
    async function recoverPersistedConfig({ scope, targetScope, owner, key }, accept) {
        if (key !== KEY || typeof accept !== 'function') fail('INDEX_WORLDBOOK_READBACK_UNAVAILABLE');
        const captured = recoveryTargets.get(targetScope);
        if (!captured || captured.owner !== owner) fail('INDEX_WORLDBOOK_READBACK_UNAVAILABLE');
        // Join the actual persistence lane. An unfinished/stalled save must keep
        // ownership; recovery does not reset the queue or issue a replacement save.
        return enqueueTablePersistence(async () => {
            const context = assertCurrent(scope);
            if (indexWorldbookChatOwner(context) !== owner) fail('INDEX_WORLDBOOK_STALE');
            const raw = await readTargetConfig(scope, captured);
            assertCurrent(scope);
            const result = accept(raw);
            savedTargets.delete(targetScope);
            return result;
        }, { retainedCost: 1024 * 1024 });
    }
    async function readTargetConfig(scope, captured) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
        try {
            assertCurrent(scope);
            const { ch_name, file_name, avatar_url } = captured.target.body;
            const response = await fetchImpl('/api/chats/get', { method: 'POST', cache: 'no-store', redirect: 'error',
                credentials: 'same-origin', headers: getRequestHeaders(), signal: controller.signal,
                body: JSON.stringify({ ch_name, file_name: file_name.replace(/\.jsonl$/iu, ''), avatar_url }) });
            if (!response?.ok || !response.body?.getReader) fail('INDEX_WORLDBOOK_READBACK_FAILED');
            const header = await readHeader(response.body.getReader());
            assertCurrent(scope);
            const metadata = header?.chat_metadata;
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('INDEX_WORLDBOOK_READBACK_INVALID');
            return Object.hasOwn(metadata, KEY) ? metadata[KEY] : undefined;
        } catch (error) {
            if (/^INDEX_WORLDBOOK_[A-Z_]+$/.test(error?.code ?? '')) throw error;
            fail('INDEX_WORLDBOOK_READBACK_FAILED');
        } finally {
            clearTimeout(timeout);
        }
    }
    return { getContext, getTables, getStateRevision, readAccess: readTableAccess, readTableSchema, project,
        generationAdapter: createIndexWorldbookGeneration(), commit, readPersistedConfig, recoverSharedWrite, recoverPersistedConfig };
}

let current = null;
let initializing = null;
export function getCurrentIndexWorldbookRuntime() { return current; }

export async function initializeCurrentIndexWorldbookRuntime() {
    if (current) return current;
    if (initializing) return initializing;
    initializing = (async () => {
        const [{ getContext }, { getRequestHeaders }, { getMemoryStateForScope }] = await Promise.all([
            import('/scripts/extensions.js'), import('/script.js'), import('./manager.js'),
        ]);
        const host = createIndexWorldbookHostAdapter({ getContext, getRequestHeaders, getTables: getMemoryStateForScope });
        const runtime = await initializeIndexWorldbookRuntime(host);
        const unsubscribeAuth = subscribePluginAuthStatus(runtime.invalidate);
        const unsubscribeTables = subscribeTableState(runtime.invalidate);

        const dispose = runtime.dispose;
        runtime.dispose = () => {
            unsubscribeAuth(); unsubscribeTables(); dispose();
            if (current === runtime) current = null;
        };
        current = runtime;
        return runtime;
    })();
    try { return await initializing; } finally { initializing = null; }
}
