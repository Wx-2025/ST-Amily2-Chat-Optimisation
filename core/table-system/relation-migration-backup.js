import { captureChatScope, chatScopesMatch } from './infra/chat-scope.js';

export const RELATION_MIGRATION_BACKUP_KEY = 'amily2_relation_migrations_v1';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 32;

function fail(code) {
    throw Object.assign(new Error(code), { code });
}

/** Kept outside table/profile exports; staged in the same save as the migration. */
export function createRelationMigrationBackupPlan(context, backup) {
    const scope = captureChatScope(context);
    if (!scope.chatId || !context.chatMetadata || backup?.format !== 'amily2.record-relation-migration'
        || backup.version !== 1 || !Array.isArray(backup.cells)) fail('RELATION_BACKUP_INVALID');
    const prior = context.chatMetadata[RELATION_MIGRATION_BACKUP_KEY];
    if (prior !== undefined && (prior?.version !== 1 || prior.chatId !== scope.chatId
        || !Array.isArray(prior.entries))) fail('RELATION_BACKUP_INVALID');
    if ((prior?.entries.length || 0) >= MAX_ENTRIES) fail('RELATION_BACKUP_LIMIT');
    const priorEncoded = JSON.stringify(prior);
    const encoded = JSON.stringify({ version: 1, chatId: scope.chatId,
        entries: [...(prior?.entries || []), { createdAt: new Date().toISOString(), backup }] });
    if (new TextEncoder().encode(encoded).length > MAX_BYTES) fail('RELATION_BACKUP_LIMIT');
    const staged = JSON.parse(encoded);
    return {
        beforeSave({ context: live }) {
            if (!chatScopesMatch(scope, captureChatScope(live))
                || live.chatMetadata?.[RELATION_MIGRATION_BACKUP_KEY] !== prior
                || JSON.stringify(live.chatMetadata?.[RELATION_MIGRATION_BACKUP_KEY]) !== priorEncoded) {
                fail('TABLE_STALE');
            }
            live.chatMetadata[RELATION_MIGRATION_BACKUP_KEY] = staged;
        },
        rollback({ context: live }) {
            if (live.chatMetadata?.[RELATION_MIGRATION_BACKUP_KEY] !== staged) return;
            if (prior === undefined) delete live.chatMetadata[RELATION_MIGRATION_BACKUP_KEY];
            else live.chatMetadata[RELATION_MIGRATION_BACKUP_KEY] = prior;
        },
    };
}
