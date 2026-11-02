import { assertLegacyRecoveryScanCurrent } from '../core/historiography/legacy-recovery.js';
import { captureChatScope, chatScopesMatch } from '../core/table-system/infra/chat-scope.js';
import { chatLedgerIdentity } from '../core/historiography/chat-ledger.js';

export function bindLegacyRecoveryScan({ button, scan, onResult, onError, t, getContext }) {
    let active = null;
    let disposed = false;
    const label = button.querySelector('[data-amily-i18n]');
    const render = key => {
        if (label) {
            label.dataset.amilyI18n = key;
            label.textContent = t(key);
        }
    };
    const cancel = () => {
        if (!active) return;
        active.abort();
        button.disabled = true;
        render('summaryWorkflow.historyRecoveryScanCancelling');
    };
    const start = async () => {
        if (disposed) return;
        if (active) { cancel(); return; }
        const controller = new AbortController();
        active = controller;
        let sameContext = () => true;
        const assertCurrent = () => {
            if (disposed || active !== controller || !button.isConnected || !sameContext()) controller.abort();
            assertLegacyRecoveryScanCurrent({ signal: controller.signal });
        };
        render('summaryWorkflow.historyRecoveryScanCancel');
        button.setAttribute('aria-busy', 'true');
        try {
            if (getContext) {
                const scope = captureChatScope(getContext());
                const identity = chatLedgerIdentity(getContext());
                sameContext = () => chatScopesMatch(scope, captureChatScope(getContext()))
                    && chatLedgerIdentity(getContext()) === identity;
            }
            assertCurrent();
            const snapshot = await scan({ signal: controller.signal, assertCurrent });
            assertCurrent();
            onResult(snapshot);
        } catch (error) {
            if (!controller.signal.aborted && !disposed && button.isConnected) onError(error);
        } finally {
            if (active === controller) {
                active = null;
                button.removeAttribute('aria-busy');
                button.disabled = false;
                render('summaryWorkflow.historyRecoveryTitle');
            }
        }
    };
    button.addEventListener('click', start);
    return { cancel, dispose() {
        disposed = true;
        cancel();
        button.removeEventListener('click', start);
    } };
}
