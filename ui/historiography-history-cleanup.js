export function bindSummaryHistoryCleanup({ root, preview, clear, download, showHtmlModal, t, escapeHtml, onSaved = () => {} }) {
    const button = root.querySelector('#historiography_clear_history');
    let busy = false, disposed = false, generation = 0, active = null;
    const refresh = () => {
        generation++;
        if (active && !active.saving) {
            const dialog = active.dialog;
            active = null;
            dialog[0].close(); dialog.remove();
        }
    };
    const open = async () => {
        if (busy || disposed || active) return;
        const ticket = generation;
        busy = true; button.disabled = true;
        try {
            const snapshot = await preview();
            if (disposed || ticket !== generation) return;
            if (!snapshot.removedCount) {
                showHtmlModal(t('summaryWorkflow.cleanupTitle'), escapeHtml(t('summaryWorkflow.cleanupEmpty')), { showCancel: false });
                return;
            }
            const state = { saving: false, closed: false, downloaded: false, downloading: false, used: false };
            showHtmlModal(t('summaryWorkflow.cleanupTitle'), `
                <p>${escapeHtml(t('summaryWorkflow.cleanupScope', { count: snapshot.removedCount, floor: snapshot.floor }))}</p>
                <button type="button" class="menu_button summary-history-download"><i class="fas fa-download"></i> ${escapeHtml(t('summaryWorkflow.cleanupDownload'))}</button>
                <label class="checkbox_label"><input type="checkbox" class="summary-history-confirm" disabled>${escapeHtml(t('summaryWorkflow.cleanupConfirm'))}</label>
                <p class="summary-history-status" role="status"></p>`, {
                onShow: dialog => {
                    state.dialog = dialog; active = state;
                    const element = dialog[0];
                    element.addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
                    element.addEventListener('close', () => { state.closed = true; if (active === state) active = null; });
                    element.querySelector('.summary-history-download').addEventListener('click', async () => {
                        if (state.closed || state.downloading || state.saving) return;
                        state.downloading = true;
                        try {
                            await download(JSON.stringify(snapshot.backup, null, 2), `amily2-summary-history-${Date.now()}.json`);
                            if (!state.closed) {
                                state.downloaded = true;
                                element.querySelector('.summary-history-confirm').disabled = false;
                            }
                        } catch {
                            element.querySelector('.summary-history-status').textContent = t('summaryWorkflow.cleanupFailed');
                        } finally { state.downloading = false; }
                    });
                },
                onOk: dialog => {
                    if (state.closed || state.saving || state.used) return false;
                    const element = dialog[0];
                    const status = element.querySelector('.summary-history-status');
                    if (!state.downloaded || !element.querySelector('.summary-history-confirm').checked) {
                        status.textContent = t('summaryWorkflow.cleanupConfirm'); return false;
                    }
                    if (disposed || ticket !== generation) return false;
                    state.used = true; state.saving = true; busy = true; button.disabled = true;
                    element.querySelectorAll('button,input').forEach(control => { control.disabled = true; });
                    void (async () => {
                        try {
                            const result = await clear(snapshot, { confirmed: true, backupConfirmed: true });
                            if (result.changed && !result.verified) throw new Error('Unverified save');
                            status.textContent = t('summaryWorkflow.cleanupDone');
                            try { await onSaved(); } catch { /* A verified save must not be retried for a UI error. */ }
                        } catch {
                            status.textContent = t('summaryWorkflow.cleanupFailed');
                        } finally {
                            state.saving = false; busy = false; button.disabled = disposed;
                            element.querySelector('.popup-button-cancel').disabled = false;
                        }
                    })();
                    return false;
                },
            });
        } catch {
            if (!disposed && ticket === generation) showHtmlModal(t('summaryWorkflow.cleanupTitle'),
                escapeHtml(t('summaryWorkflow.cleanupFailed')), { showCancel: false });
        } finally { busy = false; button.disabled = disposed; }
    };
    button?.addEventListener('click', open);
    return { refresh, dispose() { disposed = true; refresh(); button?.removeEventListener('click', open); } };
}
