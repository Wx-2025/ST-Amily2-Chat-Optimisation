export function bindSummaryReconciliation({ root, preview, accept, download, showHtmlModal, t, escapeHtml, onSaved = () => {} }) {
    const button = root.querySelector('#historiography_reconcile');
    let active = null, busy = false, disposed = false, generation = 0;
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
        busy = true; button.disabled = true;
        const ticket = generation;
        try {
            const snapshot = await preview();
            if (disposed || ticket !== generation) return;
            const differences = snapshot.differences || [];
            const display = value => escapeHtml(String(value ?? '').slice(0, 3000));
            const state = { saving: false, used: false, downloaded: false, downloading: false, closed: false };
            showHtmlModal(t('summaryWorkflow.compareTitle'), `
                <div style="max-height:65vh;overflow:auto;overflow-wrap:anywhere">
                <p>${escapeHtml(t(`summaryWorkflow.compare_${snapshot.category}`))}</p>
                <p>${escapeHtml(t('summaryWorkflow.compareScope', { revision: snapshot.revision, floor: snapshot.floor }))}</p>
                ${snapshot.changedFloors.length ? `<p>${escapeHtml(t('summaryWorkflow.compareSources', { floors: snapshot.changedFloors.join(', ') }))}</p>` : ''}
                <p class="notes">${escapeHtml(t('summaryWorkflow.compareLimits'))}</p>
                ${differences.slice(0, 100).map(d => `<details><summary>${escapeHtml(`${d.uid}: ${d.field}`)}</summary>
                    <label>${escapeHtml(t('summaryWorkflow.compareBefore'))}</label><pre style="white-space:pre-wrap">${display(d.before)}</pre>
                    <label>${escapeHtml(t('summaryWorkflow.compareAfter'))}</label><pre style="white-space:pre-wrap">${display(d.after)}</pre></details>`).join('')}
                <button type="button" class="menu_button summary-compare-download"><i class="fas fa-download"></i> ${escapeHtml(t('summaryWorkflow.cleanupDownload'))}</button>
                <label class="checkbox_label"><input type="checkbox" class="summary-compare-confirm" disabled>${escapeHtml(t('summaryWorkflow.compareConfirm'))}</label>
                <p class="summary-compare-status" role="status"></p></div>`, {
                okText: t('summaryWorkflow.compareApply'), cancelText: t('actions.cancel'),
                onShow: dialog => {
                    active = state; state.dialog = dialog;
                    const element = dialog[0];
                    element.addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
                    element.addEventListener('close', () => { state.closed = true; if (active === state) active = null; });
                    element.querySelector('.summary-compare-download').addEventListener('click', async () => {
                        if (state.closed || state.downloading || state.used) return;
                        state.downloading = true;
                        try {
                            await download(JSON.stringify(snapshot.backup, null, 2), `amily2-summary-comparison-${Date.now()}.json`);
                            if (!state.closed) {
                                state.downloaded = true;
                                element.querySelector('.summary-compare-confirm').disabled = false;
                            }
                        } catch { element.querySelector('.summary-compare-status').textContent = t('summaryWorkflow.clearChatDownloadFailed'); }
                        finally { state.downloading = false; }
                    });
                },
                onOk: dialog => {
                    if (disposed || state.closed || state.used || ticket !== generation) return false;
                    const element = dialog[0], status = element.querySelector('.summary-compare-status');
                    if (!state.downloaded || !element.querySelector('.summary-compare-confirm').checked) {
                        status.textContent = t('summaryWorkflow.compareConfirm'); return false;
                    }
                    state.used = true; state.saving = true;
                    element.querySelectorAll('button,input').forEach(control => { control.disabled = true; });
                    void (async () => {
                        try {
                            const result = await accept(snapshot, { confirmed: true, backupConfirmed: true });
                            if (!result.verified) throw new Error('Unverified save');
                            status.textContent = t('summaryWorkflow.compareDone');
                            try { await onSaved(); } catch { /* Never retry a committed save for a UI failure. */ }
                        } catch (error) {
                            status.textContent = t('summaryWorkflow.compareFailed', { code: error.code || 'SAVE_OR_STATE_ERROR' });
                        } finally {
                            state.saving = false;
                            const close = element.querySelector('.popup-button-cancel');
                            if (close) close.disabled = false;
                        }
                    })();
                    return false;
                },
            });
        } catch (error) {
            if (!disposed && ticket === generation) showHtmlModal(t('summaryWorkflow.compareTitle'),
                escapeHtml(t('summaryWorkflow.compareBlocked', { code: error.code || 'READ_OR_STATE_ERROR' })), { showCancel: false });
        } finally { busy = false; button.disabled = disposed; }
    };
    button?.addEventListener('click', open);
    return { refresh, dispose() { disposed = true; refresh(); button?.removeEventListener('click', open); } };
}
