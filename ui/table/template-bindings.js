export function bindTableTemplateEditors({
    TableManager,
    log,
    defaultRuleTemplate,
    defaultFlowTemplate,
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
        return;
    }

    ruleEditor.value = TableManager.getBatchFillerRuleTemplate();
    flowEditor.value = TableManager.getBatchFillerFlowTemplate();

    ruleSaveBtn.addEventListener('click', () => {
        TableManager.saveBatchFillerRuleTemplate(ruleEditor.value);
        toastr.success('Rule template saved.');
        log('Batch filler rule template saved.', 'success');
    });

    flowSaveBtn.addEventListener('click', () => {
        TableManager.saveBatchFillerFlowTemplate(flowEditor.value);
        toastr.success('Flow template saved.');
        log('Batch filler flow template saved.', 'success');
    });

    ruleRestoreBtn.addEventListener('click', () => {
        if (!confirm('Restore the default rule template?')) {
            return;
        }

        ruleEditor.value = defaultRuleTemplate;
        TableManager.saveBatchFillerRuleTemplate(ruleEditor.value);
        toastr.info('Rule template restored.');
        log('Batch filler rule template restored.', 'info');
    });

    flowRestoreBtn.addEventListener('click', () => {
        if (!confirm('Restore the default flow template?')) {
            return;
        }

        flowEditor.value = defaultFlowTemplate;
        TableManager.saveBatchFillerFlowTemplate(flowEditor.value);
        toastr.info('Flow template restored.');
        log('Batch filler flow template restored.', 'info');
    });

    ruleSaveBtn.dataset.templateEventsBound = 'true';
    flowSaveBtn.dataset.templateEventsBound = 'true';
    log('Template editors bound.', 'success');
}
