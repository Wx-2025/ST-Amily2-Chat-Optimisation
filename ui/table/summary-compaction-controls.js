import { COMPACTION_KEY, COMPACTION_LIMITS, createCompactionCandidateTemplate } from '../../core/table-system/summary-compaction.js';
import { t } from '../../utils/i18n/index.js';

const tr = (key, params) => t(`tableRuntimeUi.compaction.${key}`, params);

function describeIssue(issue) {
    switch (issue.code) {
        case 'STALE_RECEIPT': return tr('staleReceipt', { receipt: issue.receiptId });
        case 'CROSS_BOUNDARY': return tr('crossBoundary', { receipt: issue.receiptId, start: issue.start, end: issue.end });
        case 'SOURCE_CHANGED': return tr('sourceChanged', { row: issue.rowId });
        case 'COVERAGE_GAPS': return tr('coverageGaps', { positions: issue.positions.join(', ') });
        case 'NO_SOURCES': return tr('noSources');
        case 'SUMMARY_CHANGED': return tr('summaryChanged', { row: issue.rowId });
        case 'ARCHIVE_CHANGED': return tr('archiveChanged', { row: issue.rowId,
            expected: issue.expectedHash, actual: issue.actualHash ?? tr('missingRow') });
        default: return JSON.stringify(issue);
    }
}

/** Mount into the existing table panel. No global listeners or automatic work. */
export function mountSummaryCompactionControls(root, { service, tables, onSaved = () => {} }) {
    const document = root.ownerDocument;
    const panel = document.createElement('section');
    panel.setAttribute('aria-label', tr('panel'));
    panel.style.cssText = 'min-width:0;max-width:100%;text-align:left;overflow-wrap:anywhere;letter-spacing:0';
    root.append(panel);
    const element = (tag, parent = panel, text) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        parent.append(node);
        return node;
    };
    const field = (name, tag = 'input', parent = panel) => {
        const label = element('label', parent, name);
        label.style.cssText = 'display:block;min-width:0;margin:6px 0';
        const node = element(tag, label);
        node.setAttribute('aria-label', name);
        node.style.cssText = 'display:block;width:100%;max-width:100%;box-sizing:border-box';
        return node;
    };
    const button = (name, icon, parent = panel) => {
        const node = element('button', parent);
        node.type = 'button';
        node.className = 'menu_button';
        node.title = name;
        node.style.cssText = 'min-height:32px;white-space:normal;max-width:100%';
        const glyph = element('i', node);
        glyph.className = `fa-solid ${icon}`;
        glyph.setAttribute('aria-hidden', 'true');
        node.append(document.createTextNode(` ${name}`));
        return node;
    };
    const option = (select, value, label) => {
        const node = element('option', select, label);
        node.value = value;
    };
    const checkbox = (name, parent) => {
        const label = element('label', parent, name);
        label.style.display = 'block';
        const node = element('input', label);
        node.type = 'checkbox';
        node.setAttribute('aria-label', name);
        return node;
    };
    element('h3', panel, tr('title'));
    const configuration = element('fieldset');
    element('legend', configuration, tr('configuration'));
    const source = field(tr('sourceTable'), 'select', configuration);
    const target = field(tr('targetTable'), 'select', configuration);
    const available = tables.filter(t => t.owner === 'user' && t.readOnly !== true && t.softDelete === true);
    for (const table of available.filter(t => t.summaryEventTemplate?.kind !== 'large')) {
        option(source, table.id, table.name);
    }
    const columns = element('div', configuration);
    const targetColumn = field(tr('summaryColumn'), 'select', configuration);
    const targetFields = element('div', configuration);
    const numeric = (name, value, min, max) => {
        const node = field(name, 'input', configuration);
        node.type = 'number'; node.step = '1'; node.min = String(min);
        node.max = String(max); node.value = String(value);
        return node;
    };
    const start = numeric(tr('rangeStart'), 0, 0, Number.MAX_SAFE_INTEGER);
    const end = numeric(tr('rangeEnd'), 0, 0, Number.MAX_SAFE_INTEGER);
    const chars = numeric(tr('maxCharacters'), 4000, 1, COMPACTION_LIMITS.outputChars);
    const tokens = numeric(tr('maxTokens'), 2000, 1, COMPACTION_LIMITS.outputTokens);
    let sourceChecks = [];
    let valueFields = [];
    function renderColumns() {
        columns.replaceChildren();
        sourceChecks = (available.find(t => t.id === source.value)?.columns || []).map(c => {
            const check = checkbox(c.label, columns);
            check.dataset.columnId = c.id;
            return check;
        });
    }
    function renderTargetFields() {
        targetFields.replaceChildren();
        valueFields = (available.find(t => t.id === target.value)?.columns || [])
            .filter(c => c.id !== targetColumn.value).map(c => {
                const input = field(c.label, 'textarea', targetFields);
                input.rows = 2; input.maxLength = COMPACTION_LIMITS.outputChars;
                input.required = Boolean(c.required || c.primaryKey);
                return { columnId: c.id, input };
            });
    }
    function renderTarget() {
        targetColumn.replaceChildren();
        for (const c of available.find(t => t.id === target.value)?.columns || []) {
            if (c.type === 'string') option(targetColumn, c.id, c.label);
        }
        renderTargetFields();
    }
    function renderTargets() {
        const selected = available.find(t => t.id === source.value);
        const previous = target.value;
        target.replaceChildren();
        for (const table of available.filter(t => t.id !== selected?.id && t.groupId === selected?.groupId)) {
            option(target, table.id, table.name);
        }
        if ([...target.options].some(item => item.value === previous)) target.value = previous;
        renderTarget();
    }
    renderColumns(); renderTargets();
    const previewButton = button(tr('preview'), 'fa-magnifying-glass');
    const expand = button(tr('expand'), 'fa-expand');
    expand.hidden = true;
    const status = element('p'); status.setAttribute('role', 'status');
    const sources = element('pre');
    sources.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto';
    const candidate = field(tr('candidate'), 'textarea');
    candidate.rows = 10; candidate.maxLength = COMPACTION_LIMITS.candidateChars;
    const generate = button(tr('generate'), 'fa-wand-magic-sparkles');
    const validate = button(tr('validate'), 'fa-check');
    const comparison = element('pre');
    comparison.style.cssText = sources.style.cssText;
    const review = checkbox(tr('review'), panel);
    const save = button(tr('save'), 'fa-floppy-disk');
    const cancel = button(tr('cancel'), 'fa-xmark');
    const errors = element('p'); errors.setAttribute('role', 'alert');
    const history = element('fieldset');
    element('legend', history, tr('restoreBatch'));
    const historySelect = field(tr('savedSummary'), 'select', history);
    option(historySelect, '', tr('selectSummary'));
    const historyEntries = [];
    for (const table of available) for (const meta of table.rowMeta || []) {
        const p = meta[COMPACTION_KEY];
        if (!p || p.status === 'restored') continue;
        historyEntries.push({ tableId: table.id, rowId: meta.id });
        option(historySelect, String(historyEntries.length - 1), `${table.name}: ${meta.id}`);
    }
    const restorePreview = button(tr('previewRestore'), 'fa-magnifying-glass', history);
    const restoreInfo = element('pre', history);
    restoreInfo.style.cssText = sources.style.cssText;
    const restoreConfirmed = checkbox(tr('confirmRestore'), history);
    const restore = button(tr('restore'), 'fa-rotate-left', history);
    let handle = null;
    let restoreHandle = null;
    let validated = false;
    let busy = false;
    let disposed = false;
    let completed = false;
    function update() {
        configuration.disabled = busy || completed;
        previewButton.disabled = busy || completed || !source.value || !target.value;
        expand.disabled = busy || completed;
        generate.disabled = busy || completed || !handle?.preview.canSave || !service.modelAvailable;
        validate.disabled = busy || completed || !handle?.preview.canSave;
        candidate.disabled = busy || completed || !handle?.preview.canSave;
        review.disabled = busy || completed || !validated;
        save.disabled = busy || completed || !validated || !review.checked;
        cancel.disabled = busy || completed || !handle;
        historySelect.disabled = busy || completed;
        restorePreview.disabled = busy || completed || !historySelect.value;
        restore.disabled = busy || completed || !restoreHandle?.preview.canRestore || !restoreConfirmed.checked;
        restoreConfirmed.disabled = busy || completed || !restoreHandle?.preview.canRestore;
    }
    function invalidate() {
        if (handle) service.cancel(handle);
        handle = null; validated = false; review.checked = false;
        candidate.value = ''; sources.textContent = ''; comparison.textContent = '';
        status.textContent = ''; expand.hidden = true;
        update();
    }
    async function run(action) {
        if (busy || disposed) return;
        busy = true; errors.textContent = ''; update();
        try { await action(); }
        catch (error) {
            if (!disposed) errors.textContent = tr('failed', { code: error.code || 'SUMMARY_COMPACTION_FAILED', error: error.message });
        } finally { busy = false; if (!disposed) update(); }
    }
    source.addEventListener('change', () => { renderColumns(); renderTargets(); invalidate(); });
    target.addEventListener('change', () => { invalidate(); renderTarget(); });
    targetColumn.addEventListener('change', () => { invalidate(); renderTargetFields(); });
    configuration.addEventListener('input', invalidate);
    candidate.addEventListener('input', () => { validated = false; review.checked = false; comparison.textContent = ''; update(); });
    review.addEventListener('change', update);
    cancel.addEventListener('click', invalidate);
    previewButton.addEventListener('click', () => run(async () => {
        invalidate();
        handle = await service.preview({ sourceTableId: source.value, targetTableId: target.value,
            sourceColumnIds: sourceChecks.filter(c => c.checked).map(c => c.dataset.columnId),
            targetColumnId: targetColumn.value, start: Number(start.value), end: Number(end.value),
            maxOutputChars: Number(chars.value), maxOutputTokens: Number(tokens.value),
            targetValues: Object.fromEntries(valueFields.map(f => [f.columnId, f.input.value])) });
        if (disposed) { service.cancel(handle); return; }
        const p = handle.preview;
        status.textContent = [tr('previewStatus', { rows: p.sourceRows.length,
            characters: p.input.characters, tokens: p.input.estimatedTokens }), ...p.blockers.map(describeIssue)].join('\n');
        sources.textContent = p.sourceRows.map(r => `${r.rowId}\n${r.fields.map(f => `${f.label}: ${f.value}`).join('\n')}`).join('\n\n');
        candidate.value = JSON.stringify(createCompactionCandidateTemplate(p), null, 2);
        expand.hidden = p.expandedRange.start === p.options.start && p.expandedRange.end === p.options.end;
    }));
    expand.addEventListener('click', () => {
        if (!handle) return;
        start.value = String(handle.preview.expandedRange.start);
        end.value = String(handle.preview.expandedRange.end);
        invalidate();
    });
    generate.addEventListener('click', () => run(async () => {
        candidate.value = JSON.stringify(await service.generate(handle), null, 2);
        validated = false; review.checked = false; comparison.textContent = '';
    }));
    validate.addEventListener('click', () => run(async () => {
        validated = false; review.checked = false;
        const result = service.validate(handle, candidate.value);
        comparison.textContent = `${result.text}\n\n${tr('outputStatus', {
            characters: result.output.characters, tokens: result.output.estimatedTokens,
        })}\n${tr('omissions', { omissions: JSON.stringify(result.omissions) })}`;
        validated = true;
    }));
    save.addEventListener('click', () => run(async () => {
        if (!validated || !review.checked) return;
        const result = await service.save(handle, candidate.value, { reviewed: true });
        completed = true; status.textContent = tr('saved', { row: result.summaryRowId });
        // Render-only callback; main must not vectorize via table-update events.
        try { onSaved(result); } catch { errors.textContent = tr('savedRefreshFailed'); }
    }));
    historySelect.addEventListener('change', () => {
        if (restoreHandle) service.cancel(restoreHandle);
        restoreHandle = null; restoreConfirmed.checked = false; restoreInfo.textContent = ''; update();
    });
    restorePreview.addEventListener('click', () => run(async () => {
        const selected = historyEntries[Number(historySelect.value)];
        if (!selected || !historySelect.value) return;
        if (restoreHandle) service.cancel(restoreHandle);
        restoreHandle = await service.previewRestore(selected.tableId, selected.rowId);
        if (disposed) { service.cancel(restoreHandle); return; }
        restoreConfirmed.checked = false;
        const p = restoreHandle.preview;
        restoreInfo.textContent = [tr(p.canRestore ? 'restoreReady' : 'restoreBlocked'),
            tr('restoreDetails', { table: p.targetTableId, row: p.summaryRowId,
                rows: p.sourceRowIds.join(', '), batch: p.requestId, fingerprint: p.fingerprint }),
            ...p.conflicts.map(describeIssue)].join('\n');
    }));
    restoreConfirmed.addEventListener('change', update);
    restore.addEventListener('click', () => run(async () => {
        if (!restoreConfirmed.checked) return;
        const result = await service.restore(restoreHandle, { confirmed: true });
        completed = true; status.textContent = tr('restored', { row: result.summaryRowId });
        try { onSaved(result); } catch { errors.textContent = tr('restoredRefreshFailed'); }
    }));
    update();
    return Object.freeze({ destroy() {
        disposed = true;
        for (const current of [handle, restoreHandle]) {
            try { if (current) service.cancel(current); } catch { /* In-flight host saves retain their lease. */ }
        }
        panel.remove();
    } });
}
