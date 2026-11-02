import { getContext, extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../../../utils/settings.js';
import { captureChatScope, chatScopesMatch } from '../../table-system/infra/chat-scope.js';
import { getCurrentFillAutomationRuntime } from '../../table-system/fill-automation/integration/runtime.js';
import { FILL_CONFIG_KEY } from '../../table-system/fill-automation/integration/metadata.js';

// Runs after legacy filling releases its lock, never alongside MESSAGE_RECEIVED.
export async function fillAutomationStage(ctx, next) {
    const scope = captureChatScope(getContext());
    const current = () => {
        const context = getContext();
        return chatScopesMatch(scope, captureChatScope(context))
            && context.chat === ctx.chat && context.chat?.[ctx.messageId] === ctx.latestMessage;
    };
    const cancelled = () => {
        ctx.tablePipelineSucceeded = false;
        ctx.fillAutomationResult = Object.freeze({ status: 'cancelled', errorCode: 'FILL_CONTEXT_CHANGED' });
    };
    if (!current()) { cancelled(); return; }
    if (extension_settings[extensionName]?.table_system_enabled === false || ctx.tablePipelineSucceeded !== true) {
        ctx.fillAutomationResult = Object.freeze({ status: 'skipped', reason: 'disabled-or-upstream-failed' });
        return next();
    }
    try {
        const runtime = getCurrentFillAutomationRuntime();
        const result = runtime ? await runtime.onLifecycle({ type: 'post-pipeline', pipelineSucceeded: true })
            : getContext().chatMetadata?.[FILL_CONFIG_KEY] === undefined
                ? { status: 'skipped', reason: 'not-configured' }
                : { status: 'paused', errorCode: 'FILL_RUNTIME_UNAVAILABLE' };
        if (!current()) { cancelled(); return; }
        const succeeded = result?.status === 'succeeded';
        const skipped = result?.status === 'skipped'
            && ['not-configured', 'no-due'].includes(result.reason);
        ctx.fillAutomationResult = Object.freeze({
            status: ['succeeded', 'skipped', 'failed', 'needs-review', 'paused', 'cancelled', 'stale', 'partial', 'waiting'].includes(result?.status)
                ? result.status : 'failed',
            ...(skipped ? { reason: result.reason } : {}),
            ...(!succeeded && !skipped ? { errorCode: /^FILL_[A-Z_]+$/.test(result?.errorCode ?? '')
                ? result.errorCode : 'FILL_AUTOMATION_INCOMPLETE' } : {}),
        });
        // Later stages can consume table-derived memory; do not publish a partial layer.
        if (!succeeded && !skipped) { ctx.tablePipelineSucceeded = false; return; }
    } catch (error) {
        if (!current()) { cancelled(); return; }
        const uncertain = ['TABLE_WRITE_RECOVERY_REQUIRED', 'TABLE_WRITE_OUTCOME_UNKNOWN',
            'TABLE_WRITE_DURABLE_UNPUBLISHED', 'FILL_RECONCILIATION_REQUIRED'].includes(error?.code);
        const errorCode = uncertain ? 'FILL_RECONCILIATION_REQUIRED'
            : /^FILL_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FILL_RUNTIME_FAILED';
        ctx.tablePipelineSucceeded = false;
        ctx.fillAutomationResult = Object.freeze({ status: uncertain ? 'needs-review' : 'failed', errorCode });
        console.warn('[Amily2] Independent table filling paused:', errorCode);
        return;
    }
    return next();
}
