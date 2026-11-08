import { chatLedgerIdentity } from '../core/historiography/chat-ledger.js';

export function chatSummaryClearErrorKey(error) {
    if (error?.code === 'HISTORIOGRAPHY_SAVE_UNCERTAIN') return 'summaryWorkflow.clearChatUncertain';
    if (error?.committed) return 'summaryWorkflow.clearChatCommitted';
    if (['HISTORIOGRAPHY_STALE_LEDGER', 'HISTORIOGRAPHY_AUTHORIZATION_CHANGED',
        'HISTORIOGRAPHY_AUTHORIZATION_REQUIRED'].includes(error?.code)) return 'summaryWorkflow.clearChatStale';
    return 'summaryWorkflow.clearChatFailed';
}

export function bindChatSummaryClearControls({ root, getContext, getSettings, getAuthState,
    previewClear, clear, showHtmlModal, download, t, escapeHtml, onSaved = () => {} }) {
    const button = root.querySelector('#historiography_clear_chat');
    const status = root.querySelector('#historiography_clear_chat_status');
    const blocked = new Set();
    let busy = false;
    let disposed = false;
    let active = null;
    let generation = 0;
    const allowed = () => !disposed && getSettings()?.historiographyStorageMode === 'chat'
        && getAuthState()?.authorized === true && getAuthState()?.expired !== true
        && Boolean(chatLedgerIdentity(getContext()));
    const say = key => { if (status) status.textContent = t(key); };
    const render = () => {
        if (!button) return;
        button.hidden = getSettings()?.historiographyStorageMode !== 'chat';
        button.disabled = busy || !allowed() || blocked.has(chatLedgerIdentity(getContext()));
    };
    const close = () => {
        if (!active || active.saving) return;
        const current = active;
        active = null;
        current.closed = true;
        current.dialog[0].close();
        current.dialog.remove();
    };
    const refresh = () => {
        generation++;
        close();
        render();
    };
    const open = async () => {
        if (busy || active || !allowed() || blocked.has(chatLedgerIdentity(getContext()))) return;
        const identity = chatLedgerIdentity(getContext());
        const ticket = generation;
        busy = true; render();
        try {
            const preview = await previewClear();
            if (disposed || ticket !== generation || !allowed() || identity !== chatLedgerIdentity(getContext())) return;
            if (!preview.hasData) { say('summaryWorkflow.clearChatEmpty'); return; }
            const state = { saving: false, closed: false, downloaded: false, downloading: false, step: 1, used: false };
            showHtmlModal(t('summaryWorkflow.clearChatTitle'), `
              <div style="max-width:100%;max-height:65vh;overflow:auto;overflow-wrap:anywhere">
                <p>${escapeHtml(t('summaryWorkflow.clearChatScope'))}</p>
                <p>${escapeHtml(t('summaryWorkflow.clearChatPause'))}</p>
                <label class="checkbox_label"><input type="checkbox" class="chat-clear-scope">${escapeHtml(t('summaryWorkflow.clearChatFirst'))}</label>
                <section class="chat-clear-second" hidden>
                  <p>${escapeHtml(t('summaryWorkflow.clearChatBackupWarning'))}</p>
                  <button type="button" class="menu_button chat-clear-download"><i class="fas fa-download" aria-hidden="true"></i> ${escapeHtml(t('summaryWorkflow.clearChatDownload'))}</button>
                  <label class="checkbox_label"><input type="checkbox" class="chat-clear-backup-saved" disabled>${escapeHtml(t('summaryWorkflow.clearChatBackupSaved'))}</label>
                  <label class="checkbox_label"><input type="checkbox" class="chat-clear-final">${escapeHtml(t('summaryWorkflow.clearChatFinal'))}</label>
                </section>
                <p class="chat-clear-error" role="alert" hidden></p>
              </div>`, {
                okText: t('summaryWorkflow.clearChatNext'), cancelText: t('actions.cancel'),
                onShow: dialog => {
                    state.dialog = dialog; active = state;
                    const element = dialog[0];
                    const errorBox = element.querySelector('.chat-clear-error');
                    element.addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
                    element.addEventListener('close', () => { state.closed = true; if (active === state) active = null; });
                    element.querySelector('.chat-clear-download').addEventListener('click', async () => {
                        if (state.saving || state.closed || state.downloading) return;
                        state.downloading = true;
                        try {
                            await download(JSON.stringify(preview.backup, null, 2), `amily2-chat-summary-backup-${Date.now()}.json`);
                            if (!state.closed) {
                                state.downloaded = true;
                                element.querySelector('.chat-clear-backup-saved').disabled = false;
                            }
                        } catch {
                            errorBox.textContent = t('summaryWorkflow.clearChatDownloadFailed'); errorBox.hidden = false;
                        } finally { state.downloading = false; }
                    });
                },
                onCancel: () => { state.closed = true; if (active === state) active = null; },
                onOk: dialog => {
                    if (state.saving || state.closed || state.used) return false;
                    const element = dialog[0];
                    const errorBox = element.querySelector('.chat-clear-error');
                    const checked = selector => element.querySelector(selector).checked;
                    if (!allowed() || ticket !== generation || identity !== chatLedgerIdentity(getContext())) {
                        errorBox.textContent = t('summaryWorkflow.clearChatStale'); errorBox.hidden = false;
                        return false;
                    }
                    if (!checked('.chat-clear-scope') || (state.step === 2
                        && (!state.downloaded || !checked('.chat-clear-backup-saved') || !checked('.chat-clear-final')))) {
                        errorBox.textContent = t('summaryWorkflow.clearChatConfirmRequired'); errorBox.hidden = false;
                        return false;
                    }
                    errorBox.hidden = true;
                    if (state.step === 1) {
                        state.step = 2;
                        element.querySelector('.chat-clear-scope').disabled = true;
                        element.querySelector('.chat-clear-second').hidden = false;
                        element.querySelector('.popup-button-ok').textContent = t('summaryWorkflow.clearChatApply');
                        return false;
                    }
                    state.saving = true; state.used = true; busy = true; render();
                    element.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
                    void (async () => {
                        try {
                            const result = await clear(preview, { confirmed: true, backupConfirmed: true });
                            if (result.committed && result.verified !== true) throw Object.assign(new Error('Unverified save'), {
                                code: 'HISTORIOGRAPHY_SAVE_UNCERTAIN',
                            });
                            say(result.committed ? 'summaryWorkflow.clearChatSaved' : 'summaryWorkflow.clearChatEmpty');
                            state.saving = false;
                            close();
                            if (result.committed) {
                                try { await onSaved(result); } catch { /* A UI refresh cannot turn a confirmed save into a retry. */ }
                            }
                        } catch (error) {
                            const key = chatSummaryClearErrorKey(error);
                            if (error?.code === 'HISTORIOGRAPHY_SAVE_UNCERTAIN') blocked.add(identity);
                            errorBox.textContent = t(key); errorBox.hidden = false;
                            say(key);
                            element.querySelector('.popup-button-cancel').disabled = false;
                            state.saving = false;
                        } finally { busy = false; render(); }
                    })();
                    return false;
                },
            });
        } catch (error) {
            if (error?.code === 'HISTORIOGRAPHY_SAVE_UNCERTAIN') blocked.add(identity);
            if (!disposed && ticket === generation) say(chatSummaryClearErrorKey(error));
        } finally { busy = false; render(); }
    };
    button?.addEventListener('click', open);
    render();
    return { refresh, dispose() { disposed = true; generation++; close(); button?.removeEventListener('click', open); render(); } };
}
