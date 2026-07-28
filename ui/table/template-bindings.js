const editorSyncBaselines = new WeakMap();

function refreshEditorValue(editor, nextValue, force) {
    const normalizedValue = String(nextValue ?? '');
    const previousSyncedValue = editorSyncBaselines.get(editor);
    const isPristine = previousSyncedValue === undefined
        || editor.value === previousSyncedValue;

    if (!force && !isPristine) {
        return false;
    }

    editor.value = normalizedValue;
    editorSyncBaselines.set(editor, normalizedValue);
    return true;
}

function markEditorValueSynced(editor) {
    editorSyncBaselines.set(editor, String(editor.value ?? ''));
}

export function resolveTableTemplateLifecycleRefresh(
    previousChatEpoch,
    currentChatEpoch,
) {
    return Object.freeze({
        refreshValues: true,
        forceRefreshValues: previousChatEpoch !== currentChatEpoch,
    });
}

export function refreshTableTemplateEditorValues({
    TableManager,
    log,
    force = false,
}) {
    const ruleEditor = document.getElementById('ai-rule-template-editor');
    const flowEditor = document.getElementById('ai-flow-template-editor');

    if (!ruleEditor || !flowEditor) {
        log?.('Template editors not found, skip refreshing values.', 'warn');
        return false;
    }

    refreshEditorValue(
        ruleEditor,
        TableManager.getBatchFillerRuleTemplate(),
        force,
    );
    refreshEditorValue(
        flowEditor,
        TableManager.getBatchFillerFlowTemplate(),
        force,
    );
    return true;
}

export function bindTableTemplateEditors({
    TableManager,
    log,
    defaultRuleTemplate,
    defaultFlowTemplate,
    refreshValues = false,
    forceRefreshValues = false,
}) {
    const ruleEditor = document.getElementById('ai-rule-template-editor');
    const ruleSaveBtn = document.getElementById('ai-rule-template-save-btn');
    const ruleRestoreBtn = document.getElementById('ai-rule-template-restore-btn');

    const flowEditor = document.getElementById('ai-flow-template-editor');
    const flowSaveBtn = document.getElementById('ai-flow-template-save-btn');
    const flowRestoreBtn = document.getElementById('ai-flow-template-restore-btn');

    if (!ruleEditor || !flowEditor || !ruleSaveBtn || !flowSaveBtn) {
        log('Template editors not found, skip binding.', 'warn');
        return;
    }

    if (ruleSaveBtn.dataset.templateEventsBound) {
        if (refreshValues) {
            refreshTableTemplateEditorValues({
                TableManager,
                log,
                force: forceRefreshValues,
            });
        }
        return;
    }

    refreshTableTemplateEditorValues({ TableManager, log });

    ruleSaveBtn.addEventListener('click', () => {
        TableManager.saveBatchFillerRuleTemplate(ruleEditor.value);
        markEditorValueSynced(ruleEditor);
        toastr.success('Rule template saved.');
        log('Batch filler rule template saved.', 'success');
    });

    flowSaveBtn.addEventListener('click', () => {
        TableManager.saveBatchFillerFlowTemplate(flowEditor.value);
        markEditorValueSynced(flowEditor);
        toastr.success('Flow template saved.');
        log('Batch filler flow template saved.', 'success');
    });

    ruleRestoreBtn.addEventListener('click', () => {
        if (!confirm('Restore the default rule template?')) {
            return;
        }

        ruleEditor.value = defaultRuleTemplate;
        TableManager.saveBatchFillerRuleTemplate(ruleEditor.value);
        markEditorValueSynced(ruleEditor);
        toastr.info('Rule template restored.');
        log('Batch filler rule template restored.', 'info');
    });

    flowRestoreBtn.addEventListener('click', () => {
        if (!confirm('Restore the default flow template?')) {
            return;
        }

        flowEditor.value = defaultFlowTemplate;
        TableManager.saveBatchFillerFlowTemplate(flowEditor.value);
        markEditorValueSynced(flowEditor);
        toastr.info('Flow template restored.');
        log('Batch filler flow template restored.', 'info');
    });

    ruleSaveBtn.dataset.templateEventsBound = 'true';
    flowSaveBtn.dataset.templateEventsBound = 'true';
    log('Template editors bound.', 'success');
}
