const editorSyncBaselines = new WeakMap();
const editorRefreshVersions = new WeakMap();

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
    editorRefreshVersions.set(editor, (editorRefreshVersions.get(editor) ?? 0) + 1);
    return true;
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
    translate = (_key, fallback) => fallback,
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

    let busy = false;
    const buttons = [ruleSaveBtn, flowSaveBtn, ruleRestoreBtn, flowRestoreBtn].filter(Boolean);
    async function save(editor, value, write, restore = false) {
        if (busy) return;
        busy = true;
        const version = editorRefreshVersions.get(editor);
        const original = editor.value;
        const disabled = buttons.map(button => button.disabled);
        buttons.forEach(button => { button.disabled = true; });
        try {
            const target = await write(value);
            if (target !== 'chat' && target !== 'global') throw Object.assign(new Error('Unconfirmed template save.'), { code: 'TABLE_TEMPLATE_SAVE_FAILED' });
            if (editorRefreshVersions.get(editor) !== version) return;
            // Typing while a save is pending must remain an unsaved edit.
            if (restore && editor.value === original) editor.value = value;
            editorSyncBaselines.set(editor, String(value ?? ''));
            const message = target === 'global'
                ? translate('templateEditor.queued', 'Global template update queued; persistence is not yet confirmed.')
                : translate('templateEditor.saved', 'Template saved.');
            if (target === 'global') toastr.info(message);
            else toastr.success(message);
            log(message, target === 'global' ? 'info' : 'success');
        } catch (error) {
            if (editorRefreshVersions.get(editor) !== version) return;
            const code = /^TABLE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'TABLE_TEMPLATE_SAVE_FAILED';
            const message = `${translate('templateEditor.failed', 'Template not saved. Your edit was kept.')} (${code})`;
            toastr.error?.(message);
            log(message, 'error');
        } finally {
            buttons.forEach((button, index) => { button.disabled = disabled[index]; });
            busy = false;
        }
    }
    ruleSaveBtn.addEventListener('click', () => save(ruleEditor, ruleEditor.value,
        value => TableManager.saveBatchFillerRuleTemplate(value)));
    flowSaveBtn.addEventListener('click', () => save(flowEditor, flowEditor.value,
        value => TableManager.saveBatchFillerFlowTemplate(value)));
    ruleRestoreBtn?.addEventListener('click', () => {
        if (busy || !confirm(translate('templateEditor.restoreRule', 'Restore the default rule template?'))) return;
        return save(ruleEditor, defaultRuleTemplate, value => TableManager.saveBatchFillerRuleTemplate(value), true);
    });
    flowRestoreBtn?.addEventListener('click', () => {
        if (busy || !confirm(translate('templateEditor.restoreFlow', 'Restore the default flow template?'))) return;
        return save(flowEditor, defaultFlowTemplate, value => TableManager.saveBatchFillerFlowTemplate(value), true);
    });

    ruleSaveBtn.dataset.templateEventsBound = 'true';
    flowSaveBtn.dataset.templateEventsBound = 'true';
    log('Template editors bound.', 'success');
}
