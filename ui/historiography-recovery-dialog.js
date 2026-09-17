/** UI receives only a redacted, stale-bound preview; no direct host data access. */
export function showHistoriographyRecoveryDialog({ snapshot, showHtmlModal, t, escapeHtml, restore, onRestored }) {
    const options = snapshot.options.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(
        t(option.id === 'current' ? 'summaryWorkflow.revisionCurrent' : 'summaryWorkflow.revisionVersion', {
            revision: option.revision, floor: option.floor, time: option.createdAt || '',
        }))}</option>`).join('');
    let saving = false;
    return showHtmlModal(t('summaryWorkflow.revisionTitle'), `
      <div class="amily2-historiography-recovery" style="max-height:65vh;overflow:auto;max-width:100%">
        <p class="notes">${escapeHtml(t('summaryWorkflow.revisionHelp'))}</p>
        <label>${escapeHtml(t('summaryWorkflow.revisionSource'))}</label>
        <select class="text_pole amily2-recovery-source">${options}</select>
        <label>${escapeHtml(t('summaryWorkflow.revisionFloor'))}</label>
        <select class="text_pole amily2-recovery-floor"></select>
        <p class="notes">${escapeHtml(t('summaryWorkflow.revisionHistoryLimit', { count: snapshot.historyLimit }))}</p>
        ${snapshot.invalidRevisions.length ? `<p class="notes">${escapeHtml(t('summaryWorkflow.revisionInvalid', { count: snapshot.invalidRevisions.length }))}</p>` : ''}
        <label class="checkbox_label"><input type="checkbox" class="amily2-recovery-confirm">${escapeHtml(t('summaryWorkflow.revisionConfirm'))}</label>
        <div class="amily2-recovery-error notes" role="alert" hidden></div>
      </div>`, {
        okText: t('summaryWorkflow.revisionApply'), cancelText: t('actions.cancel'),
        onShow: dialog => {
            const source = dialog.find('.amily2-recovery-source');
            const floor = dialog.find('.amily2-recovery-floor');
            const render = () => {
                const selected = snapshot.options.find(option => option.id === String(source.val()));
                const boundaries = [...new Set(selected?.boundaries || [])]
                    .filter(value => Number.isSafeInteger(value) && value >= 0).sort((a, b) => b - a);
                floor.html(boundaries.map(value => `<option value="${value}">${escapeHtml(t('summaryWorkflow.revisionKeepFloor', { floor: value }))}</option>`).join(''));
                dialog.find('.amily2-recovery-confirm').prop('checked', false);
            };
            source.on('change', render);
            floor.on('change', () => dialog.find('.amily2-recovery-confirm').prop('checked', false));
            render();
        },
        onOk: dialog => {
            if (saving) return false;
            const errorBox = dialog.find('.amily2-recovery-error');
            if (!dialog.find('.amily2-recovery-confirm').prop('checked')) {
                errorBox.text(t('summaryWorkflow.revisionMustConfirm')).prop('hidden', false);
                return false;
            }
            const checkpointId = String(dialog.find('.amily2-recovery-source').val());
            const keepThroughFloor = Number(dialog.find('.amily2-recovery-floor').val());
            saving = true;
            errorBox.text('').prop('hidden', true);
            dialog.find('select, input, .popup-button-ok, .popup-button-cancel').prop('disabled', true);
            void (async () => {
                try {
                    const result = await restore(snapshot, checkpointId, keepThroughFloor);
                    dialog[0].close();
                    dialog.remove();
                    // A post-commit UI refresh failure must not be offered as a failed save/retry.
                    void Promise.resolve().then(() => onRestored(result)).catch(error =>
                        console.warn('[总结回滚] 数据已恢复，但页面刷新失败:', error));
                } catch (error) {
                    errorBox.text(t('summaryWorkflow.revisionFailed', { error: error.message })).prop('hidden', false);
                    dialog.find('select, input, .popup-button-ok, .popup-button-cancel').prop('disabled', false);
                    saving = false;
                }
            })();
            return false;
        },
    });
}
