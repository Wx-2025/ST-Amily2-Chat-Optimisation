import {
    assertRecordRelationCommitContext, createRecordRelationCandidate, inspectRecordRelation, normalizeRecordRelation,
    previewRecordDeletion, previewValueReferenceMigration, RECORD_RELATION_LIMITS,
    searchRecordRelationTargets,
} from '../../core/table-system/record-relations.js';
import { formatTableError } from './error-message.js';

const TEXT = Object.freeze({
    save: 'Save', cancel: 'Cancel', close: 'Close', source: 'Source field', target: 'Target table',
    cardinality: 'Cardinality', one: 'One record', many: 'Many records', required: 'Required',
    policy: 'On deletion', restrict: 'Restrict', maxItems: 'Maximum records', search: 'Search records',
    selected: 'Selected records', previous: 'Previous page', next: 'Next page',
    active: 'Active', archived: 'Archived', deleted: 'Deleted', 'pending-deletion': 'Pending deletion',
    missing: 'Missing record', 'missing-table': 'Missing table', forbidden: 'Access denied',
    empty: 'No reference', invalid: 'Invalid relation', matched: 'Matched', ambiguous: 'Ambiguous',
    blocked: 'Deletion blocked', allowed: 'No incoming record relations', hidden: 'Hidden or omitted references',
    migrate: 'Migrate', migration: 'Value reference migration',
    details: 'Relation details', deletionPreview: 'Deletion impact', record: 'Record', continue: 'Continue',
    noRecords: 'No records', deletionUnavailable: 'Deletion is not permitted; impact was not evaluated.', resolved: 'Resolved',
});
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Dependencies are host capabilities, never model/card/preset data. No direct store writes. */
export function createRecordRelationControls({ document, getSnapshot, commit, showDialog, translate }) {
    if (!document || typeof getSnapshot !== 'function' || typeof commit !== 'function'
        || typeof showDialog !== 'function') throw new TypeError('Relation controls require trusted host adapters.');
    const text = key => translate?.(key) || TEXT[key] || key;
    const element = (tag, content) => {
        const node = document.createElement(tag);
        if (content !== undefined) node.textContent = content;
        return node;
    };
    const root = title => {
        const node = element('div');
        node.style.overflowWrap = 'anywhere';
        node.style.textAlign = 'left';
        node.style.maxHeight = '65vh';
        node.style.overflowY = 'auto';
        node.append(element('h3', title));
        return node;
    };
    const field = (parent, title, input) => {
        const label = element('label', title);
        label.style.display = 'block';
        input.setAttribute('aria-label', title);
        input.style.maxWidth = '100%';
        label.append(input);
        parent.append(label);
        return input;
    };
    const select = entries => {
        const input = element('select');
        entries.forEach(([value, label]) => {
            const option = element('option', label);
            option.value = value;
            input.append(option);
        });
        return input;
    };
    const capture = () => {
        const snapshot = getSnapshot();
        if (!snapshot?.scope?.chatId || !Number.isSafeInteger(snapshot.revision)
            || !Number.isSafeInteger(snapshot.access?.registry?.revision)) fail('TABLE_STALE');
        return { ...snapshot, scope: { ...snapshot.scope }, groupRevision: snapshot.access.registry.revision,
            caller: snapshot.access.caller, groupId: snapshot.access.groupId };
    };
    const commitContext = snapshot => ({
        expectedChatScope: snapshot.scope, expectedStateRevision: snapshot.revision,
        expectedGroupRevision: snapshot.groupRevision, expectedGroupId: snapshot.groupId,
        expectedCaller: snapshot.caller,
    });
    const fresh = expected => {
        const current = capture();
        assertRecordRelationCommitContext(commitContext(expected), current);
        return current;
    };
    const canRead = (table, snapshot) => Boolean(table && table.groupId === snapshot.groupId
        && (snapshot.access.canReadTable ? snapshot.access.canReadTable(table) === true : table.owner === snapshot.caller));
    const source = (snapshot, tableId) => {
        const table = snapshot.state.find(item => item.id === tableId);
        if (!table || !canRead(table, snapshot) || table.owner !== 'user' || snapshot.caller !== 'user'
            || snapshot.access.canWriteTable?.(table) === false || table.readOnly === true
            || snapshot.access.registry.groups.find(group => group.id === snapshot.groupId)?.readOnly !== false) fail('RELATION_ACCESS_DENIED');
        return table;
    };
    const errorBox = parent => {
        const error = element('p');
        error.setAttribute('role', 'alert');
        parent.append(error);
        return error;
    };
    async function saveDialog(node, snapshot, build, button = 'save') {
        const error = errorBox(node);
        while (await showDialog(node, { okButton: text(button), cancelButton: text('cancel') })) {
            try {
                const current = fresh(snapshot);
                const request = build();
                createRecordRelationCandidate(current.state, request, current.access);
                // Only this callback may lock/recheck/persist/publish. UI candidate is never passed as authority.
                const saved = await commit(request, commitContext(snapshot));
                if (saved !== true) fail('TABLE_PERSIST_FAILED');
                return true;
            } catch (cause) {
                error.textContent = formatTableError(cause, translate);
                if (['TABLE_STALE', 'TABLE_PERSIST_FAILED', 'RELATION_ACCESS_DENIED'].includes(cause.code)) {
                    node.replaceChildren(error);
                    await showDialog(node, { okButton: text('close'), readOnly: true });
                    return false;
                }
            }
        }
        return false;
    }

    async function openSettings(tableId, columnId) {
        const snapshot = capture();
        const table = source(snapshot, tableId);
        const node = root(table.name || table.id);
        const columns = table.columns.filter(column => column.type === 'string' && column.references == null
            && !column.primaryKey && !column.unique && !column.required
            && !table.primaryKey?.columnIds?.includes(column.id));
        if (!columns.length) fail('RELATION_COLUMN_MISSING');
        const sourceInput = field(node, text('source'), select(columns.map(column => [column.id, column.label || column.id])));
        if (columnId !== undefined) {
            if (!columns.some(column => column.id === columnId)) fail('RELATION_COLUMN_MISSING');
            sourceInput.value = columnId;
        }
        const targets = snapshot.state.filter(target => canRead(target, snapshot) && target.owner === 'user');
        const targetInput = field(node, text('target'), select(targets.map(target => [target.id, `${target.name || target.id} [${target.id}]`])));
        const cardinality = field(node, text('cardinality'), select([['one', text('one')], ['many', text('many')]]));
        const required = element('input');
        required.type = 'checkbox';
        field(node, text('required'), required);
        const maxItems = element('input');
        maxItems.type = 'number'; maxItems.min = '1'; maxItems.max = String(RECORD_RELATION_LIMITS.items); maxItems.step = '1';
        field(node, text('maxItems'), maxItems);
        const policy = field(node, text('policy'), select([['restrict', text('restrict')]]));
        policy.disabled = true;
        const modeChanged = () => {
            maxItems.disabled = cardinality.value === 'one';
            maxItems.value = cardinality.value === 'one' ? '1' : String(RECORD_RELATION_LIMITS.items);
        };
        const loadColumn = () => {
            const column = columns.find(item => item.id === sourceInput.value);
            const relation = column.recordRelation === undefined ? null : normalizeRecordRelation(column.recordRelation);
            cardinality.value = relation?.cardinality || 'one';
            required.checked = relation?.required || false;
            modeChanged();
            if (relation) {
                targetInput.value = relation.targetTableId;
                maxItems.value = String(relation.maxItems);
            }
        };
        sourceInput.addEventListener('change', loadColumn);
        cardinality.addEventListener('change', modeChanged);
        loadColumn();
        return saveDialog(node, snapshot, () => ({ type: 'configure', tableId, columnId: sourceInput.value,
            relation: { kind: 'record', version: 1, targetTableId: targetInput.value,
                cardinality: cardinality.value, required: required.checked, onDelete: 'restrict', maxItems: Number(maxItems.value) } }));
    }

    async function openPicker(tableId, rowId, columnId) {
        const snapshot = capture();
        const table = source(snapshot, tableId);
        const request = { tableId, rowId, columnId };
        const initial = inspectRecordRelation(snapshot.state, request, snapshot.access);
        if (['invalid', 'forbidden'].includes(initial.status)) fail(initial.code || 'RELATION_ACCESS_DENIED');
        const node = root(table.columns.find(column => column.id === columnId)?.label || columnId);
        const search = element('input'); search.type = 'search'; search.maxLength = RECORD_RELATION_LIMITS.queryChars;
        field(node, text('search'), search);
        const selected = new Map(initial.records.map(record => [record.rowId, record]));
        const selectedList = element('div'); selectedList.setAttribute('aria-label', text('selected'));
        const results = element('div');
        const error = errorBox(node);
        node.append(selectedList, results);
        const previous = element('button', text('previous')); previous.type = 'button';
        const next = element('button', text('next')); next.type = 'button';
        node.append(previous, next);
        let offset = 0;
        const renderSelected = () => {
            selectedList.replaceChildren();
            for (const record of selected.values()) {
                const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
                field(selectedList, `${record.label || ''} [${record.tableId}/${record.rowId}] (${text(record.status)})`, checkbox);
                checkbox.addEventListener('change', () => { selected.delete(record.rowId); render(); });
            }
        };
        const render = () => {
            results.replaceChildren();
            previous.disabled = true; next.disabled = true;
            try {
                const current = fresh(snapshot);
                const inspected = inspectRecordRelation(current.state, request, current.access);
                if (['forbidden', 'invalid'].includes(inspected.status)) fail(inspected.code || 'RELATION_ACCESS_DENIED');
                const page = searchRecordRelationTargets(current.state, { ...request, query: search.value, offset, limit: 50 }, current.access);
                if (page.status !== 'ok') fail(page.status === 'forbidden' ? 'RELATION_ACCESS_DENIED' : 'RELATION_TARGET_MISSING');
                renderSelected();
                error.textContent = '';
                page.records.forEach(record => {
                    const checkbox = element('input'); checkbox.type = initial.relation.cardinality === 'one' ? 'radio' : 'checkbox';
                    checkbox.name = 'record-relation-target'; checkbox.checked = selected.has(record.rowId);
                    field(results, `${record.label} [${record.tableId}/${record.rowId}]`, checkbox);
                    checkbox.addEventListener('change', () => {
                        if (!checkbox.checked) selected.delete(record.rowId);
                        else {
                            if (initial.relation.cardinality === 'one') selected.clear();
                            if (!selected.has(record.rowId) && selected.size >= initial.relation.maxItems) {
                                checkbox.checked = false; error.textContent = formatTableError('RELATION_CARDINALITY', translate); return;
                            }
                            selected.set(record.rowId, record);
                        }
                        render();
                    });
                });
                previous.disabled = offset === 0;
                next.disabled = !page.hasMore;
            } catch (cause) {
                selectedList.replaceChildren();
                error.textContent = formatTableError(cause, translate);
            }
        };
        search.addEventListener('input', () => { offset = 0; render(); });
        previous.addEventListener('click', () => { offset = Math.max(0, offset - 50); render(); });
        next.addEventListener('click', () => { offset += 50; render(); });
        render();
        return saveDialog(node, snapshot, () => ({ type: 'set', ...request, rowIds: [...selected.keys()] }));
    }

    async function openDetails(tableId, rowId, columnId) {
        const snapshot = capture();
        const detail = inspectRecordRelation(snapshot.state, { tableId, rowId, columnId }, snapshot.access);
        const node = root(text(detail.status));
        detail.records.forEach(record => node.append(element('p', record.status === 'forbidden' ? text('forbidden')
            : `${record.label || ''} [${record.tableId}/${record.rowId}] (${text(record.status)})`)));
        if (detail.code) node.append(element('p', formatTableError(detail.code, translate)));
        await showDialog(node, { okButton: text('close'), readOnly: true });
        return detail;
    }

    async function openDeletionPreview(tableId, rowId) {
        const snapshot = capture();
        const table = snapshot.state.find(item => item.id === tableId);
        if (!table || !canRead(table, snapshot)) fail('RELATION_ACCESS_DENIED');
        if (table.readOnly === true || snapshot.access.canWriteTable?.(table) === false
            || snapshot.access.registry.groups.find(group => group.id === snapshot.groupId)?.readOnly !== false) {
            const node = root(text('deletionPreview')); node.append(element('p', text('deletionUnavailable')));
            await showDialog(node, { okButton: text('close'), readOnly: true });
            return { allowed: false, visible: [], hiddenCount: 0, reasons: ['RELATION_ACCESS_DENIED'] };
        }
        const preview = previewRecordDeletion(snapshot.state, { tableId, rowId }, snapshot.access);
        const node = root(text(preview.allowed ? 'allowed' : 'blocked'));
        preview.visible.forEach(item => node.append(element('p', `${item.label} [${item.tableId}/${item.rowId}/${item.columnId}]`)));
        if (preview.hiddenCount) node.append(element('p', `${text('hidden')}: ${preview.hiddenCount}`));
        preview.reasons.forEach(reason => node.append(element('p', formatTableError(reason, translate))));
        await showDialog(node, { okButton: text('close'), readOnly: true });
        // Deliberately no delete/force-delete callback. Main must recheck inside the deletion transaction.
        return preview;
    }

    async function openDiagnostics(tableId, kind = 'details') {
        const snapshot = capture();
        const table = snapshot.state.find(item => item.id === tableId);
        if (!table || !canRead(table, snapshot)) fail('RELATION_ACCESS_DENIED');
        if (!['details', 'deletion'].includes(kind)) fail('RELATION_OPERATION_UNSUPPORTED');
        const node = root(text(kind === 'details' ? 'details' : 'deletionPreview'));
        if (!table.rows.length) {
            node.append(element('p', text('noRecords')));
            await showDialog(node, { okButton: text('close'), readOnly: true }); return;
        }
        const row = field(node, text('record'), select(table.rowMeta.map((meta, index) => [meta.id, `${index + 1}: ${meta.id}`])));
        const columns = table.columns.filter(column => column.recordRelation);
        if (kind === 'details' && !columns.length) fail('RELATION_COLUMN_MISSING');
        const column = kind === 'details' ? field(node, text('source'), select(columns.map(item => [item.id, item.label || item.id]))) : null;
        if (!await showDialog(node, { okButton: text('continue'), cancelButton: text('cancel') })) return;
        const current = fresh(snapshot);
        if (!canRead(current.state.find(item => item.id === tableId), current)) fail('RELATION_ACCESS_DENIED');
        if (!table.rowMeta.some(meta => meta.id === row.value) || (column && !columns.some(item => item.id === column.value))) fail('TABLE_STALE');
        return kind === 'details' ? openDetails(tableId, row.value, column.value) : openDeletionPreview(tableId, row.value);
    }

    async function openMigration(tableId, columnId) {
        const snapshot = capture();
        const preview = previewValueReferenceMigration(snapshot.state, { tableId, columnId }, snapshot.access);
        const node = root(text('migration'));
        preview.rows.forEach(row => node.append(element('p', `${row.rowId}: ${text(row.status)} ${row.rowIds.join(' ')}`)));
        if (!preview.ok) {
            await showDialog(node, { okButton: text('close'), readOnly: true });
            return false;
        }
        return saveDialog(node, snapshot, () => ({ type: 'migrate', tableId, columnId }), 'migrate');
    }

    return Object.freeze({ openSettings, openPicker, openDetails, openDeletionPreview, openDiagnostics, openMigration });
}
