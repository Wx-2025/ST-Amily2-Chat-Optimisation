const SAFE_CODES = new Set([
    'TABLE_WRITE_RECOVERY_REQUIRED', 'TABLE_WRITE_READBACK_UNAVAILABLE',
    'TABLE_WRITE_RECOVERY_CONFLICT', 'TABLE_ACCESS_DENIED',
    'TABLE_SYSTEM_RECOVERY_CONFLICT', 'TABLE_WRITE_SCOPE_UNKNOWN',
]);

export function bindTableWriteRecovery({ button, recover, captureScope, isCurrent, render, notify, showFailure, translate }) {
    let running = false;
    button.addEventListener('click', async () => {
        if (running) return;
        running = true;
        button.disabled = true;
        let scope;
        try {
            scope = captureScope();
            const result = await recover();
            if (!isCurrent(scope)) return;
            const keys = {
                none: 'writeRecovery.none',
                'verified-committed': 'writeRecovery.committed',
                'verified-not-committed': 'writeRecovery.notCommitted',
            };
            const key = keys[result?.status];
            if (!key) throw Object.assign(new Error('Unexpected recovery status'), { code: 'TABLE_WRITE_RECOVERY_REQUIRED' });
            if (result.status !== 'none') render();
            notify(translate(key));
        } catch (error) {
            if (scope && !isCurrent(scope)) return;
            const code = SAFE_CODES.has(error?.code) ? error.code : 'TABLE_WRITE_READBACK_FAILED';
            await showFailure(`${translate('writeRecovery.failed')} (${code})`);
        } finally {
            button.disabled = false;
            running = false;
        }
    });
}
