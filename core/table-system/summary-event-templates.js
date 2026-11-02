import { deepClone } from './infra/database-state.js';
import { validateTableState } from './module-tables.js';
import { createTableProfile, normalizeTableProfile } from './profile.js';
import { sha256TextHex } from '../utils/sha256.js';
import { chatScopesMatch } from './infra/chat-scope.js';
import { invalidateSummaryCompactionTransition } from './summary-compaction-ownership.js';
import { isUserTableCreationGroupId } from './table-groups.js';

export const SUMMARY_EVENT_TEMPLATE_KEY = 'summaryEventTemplate';
export const SUMMARY_EVENT_MIGRATIONS_KEY = 'amily2_summary_event_migrations_v1';
export const SUMMARY_EVENT_MIGRATION_LIMITS = Object.freeze({ characters: 8000000, entries: 12, rows: 10000 });
export const SUMMARY_EVENT_ROLES = Object.freeze({
    small: Object.freeze(['time', 'summary', 'characters', 'events']),
    event: Object.freeze(['title', 'time', 'summary', 'status', 'characters', 'sources']),
    large: Object.freeze(['time', 'summary', 'changes', 'characters', 'events', 'sources']),
});
const referenceRoles = new Set(['characters', 'events', 'sources']);
const labels = { time: 'Time / interval', summary: 'Summary', characters: 'Characters', events: 'Events',
    title: 'Title', status: 'Status / unresolved', changes: 'Changes / unresolved', sources: 'Source summaries' };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value);
const fail = code => { throw Object.assign(new Error(code), { code: `SUMMARY_TEMPLATE_${code}` }); };
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const same = (a, b) => stable(a) === stable(b);
const migrationState = snapshot => ({ tables: snapshot.tables, profile: snapshot.profile ?? null,
    companions: snapshot.companions ?? {} });
export const fingerprintSummaryMigration = value => sha256TextHex(stable(value));
function bounded(value) {
    if (JSON.stringify(value).length > SUMMARY_EVENT_MIGRATION_LIMITS.characters) fail('SIZE_LIMIT');
    return value;
}

export function readSummaryEventMigrationLedger(raw) {
    if (raw === undefined) return { version: 1, revision: 0, entries: [] };
    bounded(raw);
    if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0
        || !Array.isArray(raw.entries) || raw.entries.length > SUMMARY_EVENT_MIGRATION_LIMITS.entries
        || new Set(raw.entries.map(entry => entry?.id)).size !== raw.entries.length) fail('LEDGER_INVALID');
    for (const entry of raw.entries) {
        if (!object(entry) || !id(entry.id) || !id(entry.tableId) || !['active', 'restored'].includes(entry.status)
            || !object(entry.before) || !Array.isArray(entry.before.tables)
            || !/^[a-f0-9]{64}$/.test(entry.afterFingerprint) || !/^[a-f0-9]{64}$/.test(entry.beforeFingerprint)) fail('LEDGER_INVALID');
    }
    return deepClone(raw);
}

function assertIdentities(tables) {
    if (!Array.isArray(tables) || new Set(tables.map(table => table?.id)).size !== tables.length) fail('IDENTITY_INVALID');
    for (const table of tables) {
        if (!id(table?.id) || !Array.isArray(table.columns) || !Array.isArray(table.rows) || !Array.isArray(table.rowMeta)
            || table.rows.length !== table.rowMeta.length || table.rows.length > SUMMARY_EVENT_MIGRATION_LIMITS.rows
            || table.columns.some(column => !id(column?.id)) || table.rowMeta.some(meta => !id(meta?.id))
            || new Set(table.columns.map(column => column.id)).size !== table.columns.length
            || new Set(table.rowMeta.map(meta => meta.id)).size !== table.rowMeta.length) fail('IDENTITY_INVALID');
    }
}

export function isSummaryEventTemplateTable(table) {
    return Boolean(table && table.owner === 'user' && table.readOnly !== true
        && isUserTableCreationGroupId(table.groupId));
}

function selectTable(tables, tableId) {
    const table = tables.find(item => item.id === tableId);
    if (!isSummaryEventTemplateTable(table)) fail('ACCESS_DENIED');
    return table;
}

function profileFor(tables, profile, tableId) {
    if (profile === null || profile === undefined) return null;
    if (profile.format !== 'amily2.table-profile' || profile.schemaVersion !== 1) fail('PROFILE_UNSUPPORTED');
    const result = deepClone(profile);
    const portable = createTableProfile(tables, profile).tables.find(table => table.id === tableId);
    const index = result.tables.findIndex(table => table.id === tableId);
    if (index < 0) result.tables.push(portable);
    else result.tables[index] = portable;
    result.tables = normalizeTableProfile(result, { relationTargetTables: tables }).tables;
    return result;
}

export async function previewSummaryEventMigration(snapshot, options) {
    bounded(migrationState(snapshot));
    assertIdentities(snapshot.tables);
    const tables = deepClone(snapshot.tables);
    const table = selectTable(tables, options?.tableId);
    const roles = own(SUMMARY_EVENT_ROLES, options?.kind) ? SUMMARY_EVENT_ROLES[options.kind] : null;
    if (!roles || !object(options.mapping) || Object.keys(options.mapping).some(role => !roles.includes(role))) fail('MAPPING_REQUIRED');
    const targets = options.relationTargets ?? {};
    if (!object(targets) || Object.keys(targets).some(role => !roles.includes(role) || !referenceRoles.has(role))) fail('MAPPING_INVALID');
    const existing = table[SUMMARY_EVENT_TEMPLATE_KEY];
    if (existing && (existing.version !== 1 || existing.kind !== options.kind || !object(existing.roles))) fail('TEMPLATE_UNSUPPORTED');
    const mapped = Object.values(options.mapping).filter(value => value !== null);
    if (mapped.some(value => !id(value) || !table.columns.some(column => column.id === value))
        || new Set(mapped).size !== mapped.length || !id(options.mapping.summary)) fail('MAPPING_INVALID');
    if (existing && !same(existing.roles, options.mapping)) fail('ALREADY_MIGRATED');
    const addedColumns = [];
    const unresolved = [];
    const mapping = {};
    for (const role of roles) {
        const originalId = options.mapping[role] ?? null;
        const original = table.columns.find(column => column.id === originalId);
        if (original && original.type !== 'string') fail('MAPPING_TYPE');
        const targetId = targets[role];
        let column = original;
        if (targetId !== undefined) {
            const target = selectTable(tables, targetId);
            if (target.groupId !== table.groupId || !referenceRoles.has(role)) fail('RELATION_TARGET_INVALID');
            if (original?.recordRelation && original.recordRelation.targetTableId !== targetId) fail('RELATION_TARGET_INVALID');
            if (!original?.recordRelation) column = null;
        }
        if (!column) {
            const columnId = `summary-event-${options.kind}-${role}`;
            if (table.columns.some(item => item.id === columnId)) fail('COLUMN_ID_CONFLICT');
            column = { id: columnId, label: labels[role], type: 'string', summaryEventRole: role };
            if (targetId !== undefined) column.recordRelation = { kind: 'record', version: 1, targetTableId: targetId,
                cardinality: 'many', required: false, onDelete: 'restrict', maxItems: 64 };
            table.headers.push(column.label);
            table.columns.push(column);
            table.rows.forEach(row => row.push(''));
            addedColumns.push({ columnId, role, label: column.label });
            if (original) unresolved.push({ role, retainedColumnId: originalId, reason: 'explicit-record-matching-required' });
        }
        if (referenceRoles.has(role) && !column.recordRelation) unresolved.push({ role, retainedColumnId: originalId, reason: 'relation-target-required' });
        mapping[role] = column.id;
    }
    table[SUMMARY_EVENT_TEMPLATE_KEY] = { version: 1, kind: options.kind, roles: mapping };
    invalidateSummaryCompactionTransition(snapshot.tables, tables, { operationId: `template-${table.id}-${options.kind}`,
        reason: 'summary-template-migration' });
    // Preserve all old values/IDs/rules. Existing prompts are never replaced.
    const validated = validateTableState(tables);
    const profile = profileFor(validated, snapshot.profile, table.id);
    const before = migrationState(snapshot);
    const after = { ...before, tables: validated, profile };
    return { version: 1, tableId: table.id, kind: options.kind, mapping, addedColumns, unresolved,
        retainedColumnIds: snapshot.tables.find(item => item.id === table.id).columns.map(column => column.id),
        rowCount: table.rows.length, unchanged: same(before, after),
        beforeFingerprint: await fingerprintSummaryMigration(before), afterFingerprint: await fingerprintSummaryMigration(after),
        tables: validated, profile };
}

export async function createSummaryEventMigrationPlan(snapshot, preview, requestId) {
    if (!id(requestId)) fail('REQUEST_INVALID');
    if (await fingerprintSummaryMigration(migrationState(snapshot)) !== preview.beforeFingerprint) fail('STALE');
    const ledger = readSummaryEventMigrationLedger(snapshot.ledger);
    if (ledger.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED');
    if (ledger.entries.some(entry => entry.id === requestId)) fail('REQUEST_REUSED');
    if (preview.unchanged) return { unchanged: true, requestId, tables: deepClone(snapshot.tables), profile: deepClone(snapshot.profile ?? null), ledger };
    if (ledger.entries.length >= SUMMARY_EVENT_MIGRATION_LIMITS.entries) fail('HISTORY_FULL');
    ledger.entries.push({ id: requestId, status: 'active', tableId: preview.tableId,
        createdAt: new Date().toISOString(), beforeFingerprint: preview.beforeFingerprint, afterFingerprint: preview.afterFingerprint,
        before: deepClone(migrationState(snapshot)) });
    ledger.revision++;
    bounded(ledger);
    return { requestId, tables: deepClone(preview.tables), profile: deepClone(preview.profile), ledger };
}

export async function previewSummaryEventRestore(snapshot, migrationId) {
    const ledger = readSummaryEventMigrationLedger(snapshot.ledger);
    const entry = ledger.entries.find(item => item.id === migrationId);
    if (!entry) fail('HISTORY_MISSING');
    const conflicts = [];
    if (entry.status !== 'active') conflicts.push('already-restored');
    if (await fingerprintSummaryMigration(migrationState(snapshot)) !== entry.afterFingerprint) conflicts.push('later-changes');
    if (await fingerprintSummaryMigration(entry.before) !== entry.beforeFingerprint) conflicts.push('backup-changed');
    selectTable(snapshot.tables, entry.tableId);
    return { migrationId, tableId: entry.tableId, canRestore: conflicts.length === 0, conflicts };
}

export function createSummaryEventTemplateController({ capture, commit, assertSnapshotCurrent }) {
    const sessions = new WeakMap();
    let writing = false;
    function check(session) {
        if (session.cancelled) fail('CANCELLED');
        const result = assertSnapshotCurrent(session.snapshot);
        if (result?.then) fail('ADAPTER_INVALID');
    }
    function get(handle, type) {
        const session = sessions.get(handle);
        if (!session || session.type !== type) fail('SESSION_INVALID');
        return session;
    }
    async function prepare(type, options) {
        const snapshot = await capture(options);
        snapshot.tables = deepClone(snapshot.tables);
        snapshot.profile = deepClone(snapshot.profile ?? null);
        snapshot.companions = deepClone(snapshot.companions ?? {});
        snapshot.ledger = readSummaryEventMigrationLedger(snapshot.ledger);
        const preview = type === 'migrate' ? await previewSummaryEventMigration(snapshot, options)
            : await previewSummaryEventRestore(snapshot, options.migrationId);
        const { tables: _tables, profile: _profile, ...publicPreview } = preview;
        const handle = Object.freeze({ preview: deepClone(publicPreview) });
        const session = { type, snapshot, preview, requestId: globalThis.crypto.randomUUID(), cancelled: false };
        sessions.set(handle, session);
        check(session);
        return handle;
    }
    async function save(handle, type, confirmed) {
        const session = get(handle, type);
        if (confirmed !== true) fail('CONFIRM_REQUIRED');
        if (writing) fail('BUSY');
        if (session.result) {
            const current = await capture({ tableId: session.preview.tableId });
            if (!chatScopesMatch(current.scope, session.snapshot.scope)) fail('STALE');
            return deepClone(session.result);
        }
        writing = true;
        try {
            check(session);
            let plan = session.plan;
            if (!plan && type === 'migrate') plan = await createSummaryEventMigrationPlan(session.snapshot, session.preview, session.requestId);
            else if (!plan) {
                const fresh = await previewSummaryEventRestore(session.snapshot, session.preview.migrationId);
                if (!fresh.canRestore) fail('RESTORE_CONFLICT');
                const ledger = readSummaryEventMigrationLedger(session.snapshot.ledger);
                if (ledger.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED');
                const entry = ledger.entries.find(item => item.id === fresh.migrationId);
                assertIdentities(entry.before.tables);
                const restoredTables = deepClone(entry.before.tables);
                invalidateSummaryCompactionTransition(session.snapshot.tables, restoredTables,
                    { operationId: entry.id, reason: 'summary-template-restore' });
                plan = { requestId: entry.id, tables: validateTableState(restoredTables), profile: deepClone(entry.before.profile), ledger };
                entry.status = 'restored'; entry.restoredAt = new Date().toISOString(); ledger.revision++;
            }
            check(session);
            // Approval retries must retain the exact timestamps and invalidation evidence.
            session.plan = plan;
            if (!plan.unchanged && await commit(plan, session.snapshot, () => check(session)) !== true) fail('PERSIST_FAILED');
            session.result = { requestId: plan.requestId, tableId: session.preview.tableId, unchanged: plan.unchanged === true };
            return deepClone(session.result);
        } finally { writing = false; }
    }
    return Object.freeze({
        preview: options => prepare('migrate', options),
        previewRestore: migrationId => prepare('restore', { migrationId }),
        save: (handle, { confirmed = false } = {}) => save(handle, 'migrate', confirmed),
        restore: (handle, { confirmed = false } = {}) => save(handle, 'restore', confirmed),
        cancel(handle) { if (writing) fail('BUSY'); const session = sessions.get(handle); if (session) session.cancelled = true; },
    });
}
