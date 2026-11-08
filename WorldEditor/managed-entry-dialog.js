import { showHtmlModal } from '../ui/page-window.js';
import { t } from '../utils/i18n/index.js';
import { createManagedEntryEditor } from '../core/historiography/entry-editing.js';
import { loadBookFresh } from '../core/historiography/storage.js';
import { mutateSegmentedLedgerWithHistory } from '../core/historiography/segmented-runtime.js';
import { downloadEntryBackup, safeEntryMessage } from './safe-entry-service.js';

const editor = createManagedEntryEditor({ loadBook: loadBookFresh,
    mutateBook: (name, fn, options) => mutateSegmentedLedgerWithHistory(name, fn, { ...options, verifyAfterSave: true }) });

export async function openManagedEntryDialog({ bookName, entryKey, assertCurrent, onSaved,
    manager = editor, modal = showHtmlModal, backup = downloadEntryBackup }) {
    const preview = await manager.prepare({ bookName, entryKey, assertCurrent });
    const source = preview.source.entries[preview.entryKey];
    const documents = preview.documents;
    let busy = false;
    let expired = false;
    let root;
    let mode;
    let documentSelect;
    let body;
    let status;
    let fields;
    let currentDocument = documents[0]?.editId;
    const drafts = new Map(documents.map(item => [item.editId, item.text]));
    const text = key => t(`worldEditorUi.managed.${key}`);
    const element = (tag, content) => {
        const node = document.createElement(tag);
        if (content !== undefined) node.textContent = content;
        return node;
    };
    const readonly = Boolean(preview.readonlyReason);
    const dialog = modal(text('title'), '<div class="world-editor-managed"></div>', {
        okText: t(readonly ? 'worldEditorUi.managed.close' : 'worldEditorUi.modal.confirm'),
        onShow(dialog) {
            dialog[0].addEventListener('cancel', event => { if (busy) event.preventDefault(); });
            root = dialog.find('.world-editor-managed')[0];
            root.style.cssText = 'display:grid;gap:12px;text-align:left;min-width:0';
            root.append(element('p', `UID ${preview.uid} · ${source.comment || ''}`));
            root.append(element('p', text('lockReason')));
            status = element('p'); status.setAttribute('role', 'status');
            status.style.overflowWrap = 'anywhere';
            root.append(status);
            if (readonly) {
                status.textContent = text(preview.readonlyReason);
                const raw = element('textarea'); raw.readOnly = true; raw.value = String(source.content || '');
                raw.style.cssText = 'width:100%;min-height:34vh;box-sizing:border-box';
                root.append(raw); return;
            }
            mode = element('select'); mode.setAttribute('aria-label', text('operation'));
            for (const value of ['body', 'display']) {
                if (value === 'body' && !preview.bodyEditable) continue;
                const option = element('option', text(value)); option.value = value; mode.append(option);
            }
            root.append(mode, element('p', text('locked')));
            const bodyPanel = element('div'); bodyPanel.style.cssText = 'display:grid;gap:10px;min-width:0';
            documentSelect = element('select'); documentSelect.setAttribute('aria-label', text('document'));
            for (const item of documents) {
                const option = element('option', `${item.kind === 'micro-batch' ? text('micro') : text('macro')} ${item.startFloor}–${item.endFloor}`);
                option.value = item.editId; documentSelect.append(option);
            }
            body = element('textarea'); body.setAttribute('aria-label', text('body'));
            body.style.cssText = 'width:100%;min-height:30vh;box-sizing:border-box;resize:vertical';
            body.value = drafts.get(currentDocument) || '';
            documentSelect.addEventListener('change', () => {
                drafts.set(currentDocument, body.value); currentDocument = documentSelect.value;
                body.value = drafts.get(currentDocument) || '';
            });
            bodyPanel.append(documentSelect, body); root.append(bodyPanel);
            const displayPanel = element('div'); displayPanel.style.cssText = 'display:grid;gap:10px;min-width:0';
            fields = {};
            const display = preview.display;
            for (const key of preview.displayFields) {
                const label = element('label'); label.style.cssText = 'display:grid;gap:5px';
                const field = element(key === 'key' ? 'textarea' : key === 'position' ? 'select' : 'input');
                field.setAttribute('aria-label', text(key));
                if (key === 'key') field.value = (display.key || []).join('\n');
                else if (key === 'position') {
                    for (let index = 0; index <= 4; index++) {
                        const option = element('option', text(`position${index}`)); option.value = String(index); field.append(option);
                    }
                    field.value = String(display.position ?? 4);
                } else if (['constant', 'excludeRecursion', 'preventRecursion'].includes(key)) {
                    field.type = 'checkbox'; field.checked = Boolean(display[key]);
                } else {
                    field.type = 'number'; field.min = '0'; field.max = '9999';
                    field.value = String(display[key] ?? (key === 'depth' ? 4 : 100));
                }
                field.style.maxWidth = '100%'; fields[key] = field;
                label.append(element('span', text(key)), field); displayPanel.append(label);
            }
            root.append(displayPanel);
            const selectMode = () => { bodyPanel.hidden = mode.value !== 'body'; displayPanel.hidden = mode.value !== 'display';
                bodyPanel.style.display = bodyPanel.hidden ? 'none' : 'grid'; displayPanel.style.display = displayPanel.hidden ? 'none' : 'grid'; };
            mode.addEventListener('change', selectMode); selectMode();
        },
        onOk(dialog) {
            if (readonly) return true;
            if (busy || expired) return false;
            busy = true;
            const controls = [...dialog[0].querySelectorAll('button,input,textarea,select')];
            controls.forEach(control => { control.disabled = true; });
            const change = mode.value === 'body'
                ? { documentId: documentSelect.value, replacementText: body.value }
                : { display: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
                    key === 'key' ? field.value.split('\n').map(value => value.trim()).filter(Boolean)
                        : field.type === 'checkbox' ? field.checked : Number(field.value)])) };
            (async () => {
                try {
                    await assertCurrent();
                    if (!await backup(bookName, preview.source)) return;
                    await assertCurrent();
                    expired = true;
                    const result = await manager.apply(preview, change, { assertCurrent });
                    if (result?.reason || result?.mutation?.reason || (result?.committed === false && result?.changed !== false)) {
                        status.textContent = text('notCommitted');
                        return;
                    }
                    await onSaved();
                    dialog[0].close(); dialog.remove();
                } catch (error) {
                    status.textContent = safeEntryMessage(error);
                } finally {
                    busy = false;
                    controls.forEach(control => { control.disabled = false; });
                    // A consumed preview must be reopened; never repeat an uncertain write.
                    if (expired) dialog.find('.popup-button-ok').prop('disabled', true);
                }
            })();
            return false;
        },
    });
    return dialog;
}
