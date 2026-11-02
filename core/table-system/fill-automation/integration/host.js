import { extension_settings, getContext } from '/scripts/extensions.js';
import { extensionName } from '../../../../utils/settings.js';
import { apiProfileManager } from '../../../../utils/config/ApiProfileManager.js';
import { getModuleAccessDecision } from '../../../../utils/module-access-policy.js';
import { getState } from '../../infra/store.js';
import { captureTableFillRequestLease, assertTableFillRequestLease } from '../../infra/persistence-scope.js';
import { captureChatScope, chatScopesMatch } from '../../infra/chat-scope.js';
import { getBatchFillerRuleTemplate, getBatchFillerFlowTemplate } from '../../templates.js';
import { normalizeFillProfile } from '../config.js';
import { fail } from '../validation.js';
import { fingerprint, stable } from './metadata.js';

export function resolveCurrentInheritedFillProfile({ tableId, context = getContext(), config }) {
    const settings = extension_settings[extensionName] ?? {};
    const protocol = settings.tableFillFunctionCall === true ? 'stable-selector' : 'legacy-index';
    const slot = protocol === 'legacy-index' && settings.nccsEnabled === true ? 'nccs' : 'tableFilling';
    const connectionRef = apiProfileManager.getAssignment(slot);
    const connection = connectionRef ? apiProfileManager.getProfile(connectionRef) : null;
    if (!connection || connection.type !== 'chat' || !connection.model) fail('FILL_CONNECTION_UNAVAILABLE');
    const table = getState()?.find(item => item.id === tableId);
    if (!table || table.owner !== 'user' || table.readOnly === true) fail('FILL_WRITE_FORBIDDEN');
    const lease = captureTableFillRequestLease(context, { tableGroupId: table.groupId });
    assertTableFillRequestLease(lease, context);
    if (!lease.targetTableIds.includes(tableId)) fail('FILL_WRITE_FORBIDDEN');
    const scopes = getState().filter(item => lease.targetTableIds.includes(item.id)
        && item.owner === 'user' && item.readOnly !== true)
        .map(item => ({ tableId: item.id, columnIds: item.columns.map(column => column.id) }));
    const maxTokens = connection.maxTokens ?? 2048;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('FILL_INVALID_MODEL_BUDGET');
    return normalizeFillProfile({
        profileId: `inherited:${slot}:${tableId}`, revision: config.revision,
        tableGroupId: table.groupId, connectionRef, model: connection.model, protocol,
        parameters: { ...(connection.temperature !== undefined ? { temperature: connection.temperature } : {}) },
        promptRef: 'table-filling', readScopes: scopes,
        writeScopes: scopes.filter(scope => scope.tableId === tableId),
        // Automation ceilings remain bounded even when the global connection allows more.
        inputTokenBudget: 65536, outputTokenBudget: Math.min(maxTokens, 32768),
    });
}

export function resolveCurrentFillPrompt(promptRef, { profile } = {}) {
    if (promptRef === 'profile') {
        const validated = normalizeFillProfile(profile);
        if (validated.promptRef !== 'profile') fail('FILL_PROMPT_UNAVAILABLE');
        return { text: validated.promptText, revision: `profile:${validated.profileId}:${validated.revision}` };
    }
    if (promptRef !== 'table-filling') fail('FILL_PROMPT_UNAVAILABLE');
    const rule = getBatchFillerRuleTemplate();
    const flow = getBatchFillerFlowTemplate();
    if (typeof rule !== 'string' || typeof flow !== 'string') fail('FILL_PROMPT_UNAVAILABLE');
    const text = [rule, flow.replaceAll('{{{Amily2TableData}}}', 'Use only the supplied task.tables and task.target data.')].join('\n\n');
    return { text, revision: 'current-chat-template-v1' };
}

export async function authorizeCurrentFillRequest(request) {
    const context = getContext();
    const scope = captureChatScope(context);
    const decision = getModuleAccessDecision('Table');
    if (!decision.allowed || scope.chatId !== request.scope?.chatId || scope.epoch !== request.scope?.epoch) fail('FILL_NOT_AUTHORIZED');
    const lease = captureTableFillRequestLease(context, { tableGroupId: request.tableGroupId });
    const permission = stable(decision);
    const assertAccessCurrent = () => {
        const current = getContext();
        if (!chatScopesMatch(scope, captureChatScope(current))
            || stable(getModuleAccessDecision('Table')) !== permission) fail('FILL_NOT_AUTHORIZED');
        const liveLease = captureTableFillRequestLease(current, { tableGroupId: request.tableGroupId });
        assertTableFillRequestLease(liveLease, current);
        if (liveLease.groupSelectionRevision !== lease.groupSelectionRevision
            || liveLease.groupRevision !== lease.groupRevision) fail('FILL_NOT_AUTHORIZED');
        for (const access of [...request.readScopes, ...request.writeScopes]) {
            const table = getState().find(item => item.id === access.tableId);
            if (!lease.targetTableIds.includes(access.tableId) || !table || table.owner !== 'user'
                || table.readOnly === true || access.columnIds.some(columnId => !table.columns.some(column => column.id === columnId))) {
                fail('FILL_NOT_AUTHORIZED');
            }
        }
        return true;
    };
    const assertCurrent = () => { assertTableFillRequestLease(lease, getContext()); return assertAccessCurrent(); };
    assertCurrent();
    const permissionFingerprint = await fingerprint({ permission, scope: request.scope,
        read: request.readScopes, write: request.writeScopes });
    assertCurrent();
    return Object.freeze({ fingerprint: permissionFingerprint, assertCurrent, assertAccessCurrent });
}

export function createDefaultFillAutomationHost() {
    return { resolveInheritedProfile: resolveCurrentInheritedFillProfile,
        resolvePrompt: resolveCurrentFillPrompt, authorizeRequest: authorizeCurrentFillRequest };
}
