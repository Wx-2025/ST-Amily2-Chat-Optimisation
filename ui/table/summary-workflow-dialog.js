import { getContext } from '/scripts/extensions.js';
import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { getMemoryStateForScope } from '../../core/table-system/manager.js';
import { captureChatScope, chatScopesMatch } from '../../core/table-system/infra/chat-scope.js';
import { getStateRevision } from '../../core/table-system/infra/store.js';
import { createCurrentSummaryCompactionService } from '../../core/table-system/summary-compaction-runtime.js';
import { createCurrentSummaryEventTemplateService } from '../../core/table-system/summary-event-templates-runtime.js';
import { readSummaryEventMigrationLedger, SUMMARY_EVENT_MIGRATIONS_KEY, SUMMARY_EVENT_ROLES } from '../../core/table-system/summary-event-templates.js';
import { apiProfileManager } from '../../utils/config/ApiProfileManager.js';
import { getModuleAccessDecision } from '../../utils/module-access-policy.js';
import { t } from '../../utils/i18n/index.js';
import { mountSummaryCompactionControls } from './summary-compaction-controls.js';
import { mountSummaryEventTemplateControls } from './summary-event-template-controls.js';

const tr = key => t(`tableRuntimeUi.${key}`);

export async function openSummaryWorkflow(tableIndex, kind) {
    if (!['template', 'compaction'].includes(kind)) return false;
    const context = getContext();
    const scope = captureChatScope(context);
    const tables = getMemoryStateForScope(scope);
    const selected = tables?.[tableIndex];
    if (!selected || selected.owner !== 'user' || selected.readOnly === true
        || !getModuleAccessDecision('Table').allowed) return false;
    const available = [selected, ...tables.filter(table => table.id !== selected.id && table.groupId === selected.groupId)];
    const root = document.createElement('div');
    root.style.cssText = 'min-width:0;max-width:100%;text-align:left;overflow-wrap:anywhere';
    let mounted;
    let saved = false;
    let active = true;
    const assertAccess = () => {
        if (!active || !chatScopesMatch(scope, captureChatScope(getContext()))) {
            throw Object.assign(new Error('Reopen the workflow in the current chat.'), { code: 'TABLE_STALE' });
        }
        const current = getMemoryStateForScope(scope)?.find(table => table.id === selected.id);
        if (!getModuleAccessDecision('Table').allowed || !current || current.owner !== 'user'
            || current.readOnly === true || current.groupId !== selected.groupId) {
            throw Object.assign(new Error('Table access is no longer available.'), { code: 'TABLE_ACCESS_DENIED' });
        }
    };
    const onSaved = () => { saved = true; };
    try {
        if (kind === 'template') {
            const keys = ['table', 'kind', 'confirm', 'preview', 'save', 'history', 'restoreConfirm',
                'previewRestore', 'restore', 'cancel', 'newColumn', 'unresolved'];
            const labels = Object.fromEntries(keys.map(key => [key, tr(`template.${key}`)]));
            labels.title = tr('workflow.template');
            labels.small = tr('template.smallSummary');
            labels.large = tr('template.largeSummary');
            labels.event = tr('template.event');
            for (const role of new Set(Object.values(SUMMARY_EVENT_ROLES).flat())) {
                labels[`role.${role}`] = tr(`template.role.${role}`);
            }
            for (const role of ['characters', 'events', 'sources']) labels[`target.${role}`] = tr(`template.target.${role}`);
            mounted = mountSummaryEventTemplateControls(root, {
                service: createCurrentSummaryEventTemplateService({ assertAccess }), tables: available, labels, onSaved,
                migrations: readSummaryEventMigrationLedger(context.chatMetadata?.[SUMMARY_EVENT_MIGRATIONS_KEY]).entries,
            });
        } else {
            const label = document.createElement('label');
            label.textContent = tr('workflow.connection');
            const connection = document.createElement('select');
            connection.setAttribute('aria-label', label.textContent);
            connection.style.cssText = 'display:block;width:100%;max-width:100%';
            const empty = document.createElement('option');
            empty.value = ''; empty.textContent = tr('workflow.noConnection'); connection.append(empty);
            for (const profile of apiProfileManager.getProfiles('chat').filter(profile => profile.provider !== 'sillytavern_preset')) {
                const option = document.createElement('option');
                option.value = profile.id; option.textContent = profile.name || profile.model || profile.id;
                connection.append(option);
            }
            label.append(connection); root.append(label);
            const service = createCurrentSummaryCompactionService({
                assertAccess,
                async requestCandidate(messages, { signal, maxTokens }) {
                    assertAccess();
                    const connectionRef = connection.value;
                    if (!connectionRef) throw Object.assign(new Error('Select a connection.'), { code: 'SUMMARY_COMPACTION_MODEL_UNAVAILABLE' });
                    const revision = getStateRevision();
                    const beforeSend = () => { assertAccess(); return revision === getStateRevision(); };
                    connection.disabled = true;
                    try {
                        const { callAIWithConnection } = await import('../../core/api.js');
                        const result = await callAIWithConnection({ connectionRef, messages,
                            overrides: { maxTokens }, signal, beforeSend });
                        return { text: result.text, finishReason: result.finishReason, truncated: result.complete !== true };
                    } finally { connection.disabled = false; }
                },
            });
            mounted = mountSummaryCompactionControls(root, { service, tables: available, onSaved });
        }
    } catch (error) {
        mounted?.destroy();
        root.replaceChildren();
        const status = document.createElement('p'); status.setAttribute('role', 'alert');
        status.textContent = /^[A-Z_]{1,100}$/.test(error?.code ?? '') ? error.code : tr('errors.TABLE_ACCESS_DENIED');
        root.append(status);
    }
    try { await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true }); return saved; }
    finally { active = false; mounted?.destroy(); }
}
