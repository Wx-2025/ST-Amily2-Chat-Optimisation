import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { getState } from '../../core/table-system/infra/store.js';
import { getCurrentRecordRelationSnapshot, commitCurrentRecordRelation } from '../../core/table-system/actions/ui-mutations.js';
import { decodeRecordRelation, assertRecordRelationCommitContext } from '../../core/table-system/record-relations.js';
import { createRecordRelationControls } from './relation-controls.js';
import { formatTableError } from './error-message.js';
import { t } from '../../utils/i18n/index.js';

const text = key => t(`tableRuntimeUi.${key.startsWith('errors.') ? key : `relation.${key}`}`);

export function describeRelationCell(column, value) {
    try { return `${text('records')}: ${decodeRecordRelation(value, column.recordRelation).length}`; }
    catch { return text('invalid'); }
}

export async function openTableRelations(tableIndex, rowIndex, columnIndex, { viewOnly = false } = {}) {
    const table = getState()?.[tableIndex];
    if (!table || table.owner !== 'user') return false;
    const controls = createRecordRelationControls({ document,
        getSnapshot: () => getCurrentRecordRelationSnapshot(table.groupId),
        commit: commitCurrentRecordRelation,
        showDialog: (root, options) => callGenericPopup(root, options.readOnly ? POPUP_TYPE.TEXT : POPUP_TYPE.CONFIRM, '', options),
        translate: text,
    });
    try {
        const captured = getCurrentRecordRelationSnapshot(table.groupId);
        const expected = { expectedChatScope: captured.scope, expectedStateRevision: captured.revision,
            expectedGroupRevision: captured.access?.registry?.revision, expectedGroupId: captured.access?.groupId,
            expectedCaller: captured.access?.caller };
        assertRecordRelationCommitContext(expected, captured);
        const source = captured.state.find(item => item.id === table.id);
        if (!source || captured.access.canReadTable?.(source) !== true) return false;
        const writable = !viewOnly && source.readOnly !== true && captured.access.caller === 'user'
            && captured.access.registry.groups.find(group => group.id === source.groupId)?.readOnly === false
            && captured.access.canWriteTable?.(source) === true;
        const choices = [];
        let rowId; let columnId;
        if (Number.isInteger(rowIndex) && Number.isInteger(columnIndex)) {
            rowId = source.rowMeta[rowIndex]?.id; columnId = source.columns[columnIndex]?.id;
            if (!rowId || !columnId) return false;
            if (!writable) { await controls.openDetails(source.id, rowId, columnId); return false; }
            choices.push(['details', text('details')], ['edit', text('edit')], ['deletion', text('deletionPreview')]);
        } else {
            if (source.columns.some(column => column.recordRelation)) choices.push(['details', text('details')]);
            choices.push(['deletion', text('deletionPreview')]);
            if (writable) {
                choices.push(['configure', text('settings')]);
                source.columns.forEach((column, index) => {
                    if (column.type === 'reference' && column.references) choices.push([`migration:${index}`, `${text('migration')}: ${column.label || column.id}`]);
                });
            }
        }
        const root = document.createElement('div');
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;min-width:0'; select.setAttribute('aria-label', text('action'));
        for (const [value, title] of choices) {
            const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option);
        }
        root.append(select);
        if (!await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: text('continue'), cancelButton: text('cancel') })) return false;
        const live = getCurrentRecordRelationSnapshot(table.groupId);
        assertRecordRelationCommitContext(expected, live);
        if (live.access.canReadTable?.(live.state.find(item => item.id === source.id)) !== true) return false;
        const action = select.value;
        if (!choices.some(([value]) => value === action)) return false;
        if (action === 'details' || action === 'deletion') {
            if (rowId) {
                if (action === 'details') await controls.openDetails(source.id, rowId, columnId);
                else await controls.openDeletionPreview(source.id, rowId);
            } else await controls.openDiagnostics(source.id, action);
            return false;
        }
        if (!writable) return false;
        if (action === 'edit') return await controls.openPicker(source.id, rowId, columnId);
        if (action.startsWith('migration:')) return await controls.openMigration(source.id, source.columns[Number(action.slice(10))].id);
        return await controls.openSettings(source.id);
    } catch (error) {
        toastr.error(formatTableError(error, text), text('title'));
        return false;
    }
}
