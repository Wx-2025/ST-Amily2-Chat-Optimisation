import { SUMMARY_EVENT_ROLES, SUMMARY_EVENT_TEMPLATE_KEY, isSummaryEventTemplateTable } from '../../core/table-system/summary-event-templates.js';

export function mountSummaryEventTemplateControls(root, { service, tables, migrations = [], onSaved = () => {}, labels = {} }) {
    const doc = root.ownerDocument;
    const text = (key, fallback) => labels[key] ?? fallback;
    const abort = new doc.defaultView.AbortController();
    let handle = null;
    let restoreHandle = null;
    let busy = false;
    let completed = false;
    let destroyed = false;
    const roleFields = new Map();
    root.replaceChildren();
    const form = doc.createElement('fieldset'); root.append(form);
    const legend = doc.createElement('legend'); legend.textContent = text('title', 'Summary / event template'); form.append(legend);
    function field(parent, label, tag = 'select') {
        const wrapper = doc.createElement('label'); wrapper.textContent = label;
        const control = doc.createElement(tag); control.setAttribute('aria-label', label);
        wrapper.append(control); parent.append(wrapper); return control;
    }
    function option(select, value, label) {
        const element = doc.createElement('option'); element.value = value; element.textContent = label; select.append(element);
    }
    const tableSelect = field(form, text('table', 'Table'));
    const available = tables.filter(isSummaryEventTemplateTable);
    for (const table of available) option(tableSelect, table.id, table.name || table.id);
    const kind = field(form, text('kind', 'Template'));
    for (const value of Object.keys(SUMMARY_EVENT_ROLES)) option(kind, value, text(value, value));
    const mapping = doc.createElement('div'); form.append(mapping);
    const details = doc.createElement('pre'); details.style.whiteSpace = 'pre-wrap'; details.style.overflowWrap = 'anywhere'; form.append(details);
    const status = doc.createElement('div'); status.setAttribute('role', 'alert'); root.append(status);
    function checkbox(label) { const input = field(form, label, 'input'); input.type = 'checkbox'; return input; }
    const confirm = checkbox(text('confirm', 'Confirm migration'));
    function button(label, action) {
        const element = doc.createElement('button'); element.type = 'button'; element.textContent = label; form.append(element);
        element.addEventListener('click', async () => {
            if (busy || completed || destroyed) return;
            busy = true; form.disabled = true;
            try { await action(); if (!destroyed) status.textContent = ''; }
            catch (error) { if (!destroyed) status.textContent = error.code || error.message; }
            finally { busy = false; if (!destroyed) { form.disabled = completed; update(); } }
        }, { signal: abort.signal }); return element;
    }
    const preview = button(text('preview', 'Preview migration'), async () => {
        invalidate();
        const options = { tableId: tableSelect.value, kind: kind.value, mapping: {}, relationTargets: {} };
        for (const [role, fields] of roleFields) {
            options.mapping[role] = fields.column.value || null;
            if (fields.target?.value) options.relationTargets[role] = fields.target.value;
        }
        handle = await service.preview(options);
        if (destroyed) { service.cancel(handle); return; }
        details.textContent = JSON.stringify(handle.preview, null, 2);
    });
    const save = button(text('save', 'Apply migration'), async () => {
        const result = await service.save(handle, { confirmed: confirm.checked });
        completed = true; if (!destroyed) await onSaved(result);
    });
    const history = field(form, text('history', 'Migration history'));
    for (const entry of migrations.filter(entry => entry.status === 'active' && available.some(table => table.id === entry.tableId))) option(history, entry.id, `${entry.tableId} / ${entry.createdAt ?? entry.id}`);
    const restoreConfirm = checkbox(text('restoreConfirm', 'Confirm restore'));
    const previewRestore = button(text('previewRestore', 'Preview restore'), async () => {
        invalidate(); restoreHandle = await service.previewRestore(history.value);
        if (destroyed) { service.cancel(restoreHandle); return; }
        details.textContent = JSON.stringify(restoreHandle.preview, null, 2);
    });
    const restore = button(text('restore', 'Restore migration'), async () => {
        const result = await service.restore(restoreHandle, { confirmed: restoreConfirm.checked });
        completed = true; if (!destroyed) await onSaved(result);
    });
    const cancel = button(text('cancel', 'Cancel'), () => invalidate());
    function update() {
        preview.disabled = !tableSelect.value;
        save.disabled = !handle || !confirm.checked || completed;
        previewRestore.disabled = !history.value;
        restore.disabled = !restoreHandle?.preview.canRestore || !restoreConfirm.checked || completed;
        cancel.disabled = !handle && !restoreHandle;
    }
    function invalidate() {
        if (handle) service.cancel(handle);
        if (restoreHandle) service.cancel(restoreHandle);
        handle = null; restoreHandle = null; confirm.checked = false; restoreConfirm.checked = false; details.textContent = '';
    }
    function render() {
        invalidate(); mapping.replaceChildren(); roleFields.clear();
        const table = tables.find(item => item.id === tableSelect.value);
        for (const role of SUMMARY_EVENT_ROLES[kind.value]) {
            const column = field(mapping, text(`role.${role}`, role)); option(column, '', text('newColumn', 'New column'));
            for (const item of table?.columns ?? []) option(column, item.id, item.label || item.id);
            column.value = table?.[SUMMARY_EVENT_TEMPLATE_KEY]?.roles?.[role] ?? '';
            let target;
            if (['characters', 'events', 'sources'].includes(role)) {
                target = field(mapping, text(`target.${role}`, `${role} reference table`)); option(target, '', text('unresolved', 'Unmapped'));
                for (const item of available.filter(item => item.groupId === table?.groupId)) option(target, item.id, item.name || item.id);
            }
            roleFields.set(role, { column, target });
        }
        update();
    }
    tableSelect.addEventListener('change', render, { signal: abort.signal });
    kind.addEventListener('change', render, { signal: abort.signal });
    mapping.addEventListener('change', () => { invalidate(); update(); }, { signal: abort.signal });
    history.addEventListener('change', () => { invalidate(); update(); }, { signal: abort.signal });
    confirm.addEventListener('change', update, { signal: abort.signal });
    restoreConfirm.addEventListener('change', update, { signal: abort.signal });
    render();
    return { destroy() { destroyed = true; abort.abort(); if (!busy) invalidate(); root.replaceChildren(); } };
}
