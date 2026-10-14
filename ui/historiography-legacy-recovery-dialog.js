export function showLegacyHistoricalRecoveryDialog({ snapshot, showHtmlModal, t, escapeHtml, restore, onRestored }) {
    const e = escapeHtml;
    const records = [...snapshot.sources, ...(snapshot.conflicts || [])];
    const sourceList = records.map(source => `<li>${e(source.comment)} (UID/key: ${e(source.key)})</li>`).join('');
    let saving = false;
    return showHtmlModal(t('summaryWorkflow.historyRecoveryTitle'), `
      <div class="amily2-historical-recovery" style="max-height:65vh;overflow:auto;max-width:100%">
        <p>${e(snapshot.bookName)}</p>
        ${snapshot.recoverable ? `
          <p>${e(t('summaryWorkflow.historyRecoveryRange', { floor: snapshot.restoredThroughFloor, progress: snapshot.totalFloors, count: snapshot.sources.length, tokens: snapshot.estimatedTokens }))}</p>
          <ul>${sourceList}</ul>
          <label for="amily-history-recovery-preview">${e(t('summaryWorkflow.historyRecoveryPreview'))}</label>
          <textarea id="amily-history-recovery-preview" class="text_pole" rows="10" readonly style="width:100%;box-sizing:border-box">${e(snapshot.restoredContent)}</textarea>
          <label class="checkbox_label"><input type="checkbox" class="amily-history-recovery-confirm">${e(t('summaryWorkflow.historyRecoveryConfirm'))}</label>
        ` : `
          <p role="status">${e(t(`summaryWorkflow.historyRecoveryReason.${snapshot.reason}`, { floor: snapshot.missingThroughFloor || 0 }))}</p>
          ${sourceList ? `<ul>${sourceList}</ul>` : ''}
        `}
        <div class="amily-history-recovery-error notes" role="alert" hidden></div>
      </div>`, {
        okText: t(snapshot.recoverable ? 'summaryWorkflow.historyRecoveryApply' : 'summaryWorkflow.close'),
        cancelText: t('actions.cancel'),
        onOk: dialog => {
            if (!snapshot.recoverable) return true;
            if (saving) return false;
            const errorBox = dialog.find('.amily-history-recovery-error');
            if (!dialog.find('.amily-history-recovery-confirm').prop('checked')) {
                errorBox.text(t('summaryWorkflow.historyRecoveryMustConfirm')).prop('hidden', false);
                return false;
            }
            saving = true;
            dialog.find('input, .popup-button-ok, .popup-button-cancel').prop('disabled', true);
            void (async () => {
                try {
                    const result = await restore(snapshot);
                    dialog[0].close();
                    dialog.remove();
                    void Promise.resolve().then(() => onRestored(result)).catch(error =>
                        console.warn('[History recovery] Saved; UI refresh failed:', error));
                } catch (error) {
                    errorBox.text(t('summaryWorkflow.historyRecoveryFailed', { error: error.message })).prop('hidden', false);
                    dialog.find('input, .popup-button-ok, .popup-button-cancel').prop('disabled', false);
                    saving = false;
                }
            })();
            return false;
        },
    });
}
