import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { getContext } from '/scripts/extensions.js';
import { getState, getStateRevision } from '../../core/table-system/infra/store.js';
import { captureChatScope } from '../../core/table-system/infra/chat-scope.js';
import { configureCurrentUserTableIndexes } from '../../core/table-system/actions/ui-mutations.js';
import { normalizeQueryIndexes, queryTableIndex, QUERY_INDEX_LIMITS } from '../../core/table-system/query-indexes.js';
import { t } from '../../utils/i18n/index.js';
import { formatTableError } from './error-message.js';
import { readCurrentIndexDependencies } from '../../core/table-system/index-dependencies-runtime.js';
import { assertIndexChangesAllowed } from '../../core/table-system/index-dependencies.js';

const label = key => t(`tableRuntimeUi.index.${key}`);

export function createIndexEditor(table) {
    const snapshot = structuredClone(table);
    let definitions = normalizeQueryIndexes(snapshot);
    let selected = definitions[0]?.id;
    const root = document.createElement('div');
    root.style.cssText = 'width:100%;max-width:640px;min-width:0;text-align:left;overflow-wrap:anywhere';
    const title = document.createElement('h3');
    title.textContent = `${table.name} · ${label('title')}`;
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px';
    const list = document.createElement('select');
    list.style.cssText = 'min-width:0;flex:1';
    list.setAttribute('aria-label', label('title'));
    const add = iconButton('fa-plus', label('add'));
    const remove = iconButton('fa-trash', label('remove'));
    toolbar.append(list, add, remove);
    const form = document.createElement('div');
    form.style.cssText = 'display:grid;gap:10px;min-width:0';
    root.append(title, toolbar, form);

    function refreshList() {
        list.replaceChildren();
        for (const item of definitions) list.add(new Option(item.name, item.id));
        list.value = selected ?? '';
        add.disabled = definitions.length >= QUERY_INDEX_LIMITS.definitions;
        remove.disabled = !selected;
    }
    function render() {
        refreshList();
        form.replaceChildren();
        const item = definitions.find(entry => entry.id === selected);
        if (!item) return;
        const name = document.createElement('input');
        name.value = item.name;
        name.maxLength = 100;
        name.addEventListener('input', () => { item.name = name.value; refreshList(); });
        form.append(field(label('name'), name));
        const columns = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = label('columns');
        columns.append(legend);
        for (const column of snapshot.columns) {
            columns.append(check(column.label, item.columnIds.includes(column.id), enabled => {
                item.columnIds = enabled ? [...item.columnIds, column.id] : item.columnIds.filter(id => id !== column.id);
                renderPreview();
            }));
        }
        form.append(columns);
        form.append(field(label('mode'), select(['exact', 'keywords'], item.mode, value => { item.mode = value; renderPreview(); })));
        form.append(field(label('fieldMatch'), select(['all', 'any'], item.fieldMatch, value => { item.fieldMatch = value; })));
        form.append(field(label('termMatch'), select(['all', 'any'], item.termMatch, value => { item.termMatch = value; })));
        form.append(check(label('trim'), item.trim, value => { item.trim = value; }));
        form.append(check(label('caseSensitive'), item.caseSensitive, value => { item.caseSensitive = value; }));
        const preview = document.createElement('fieldset');
        form.append(preview);
        function renderPreview() {
            preview.replaceChildren();
            const caption = document.createElement('legend');
            caption.textContent = label('preview');
            preview.append(caption);
            const inputs = item.columnIds.map(columnId => {
                const column = snapshot.columns.find(entry => entry.id === columnId);
                const input = document.createElement('textarea');
                input.rows = item.mode === 'keywords' ? 2 : 1;
                input.maxLength = QUERY_INDEX_LIMITS.terms * (QUERY_INDEX_LIMITS.termChars + 1);
                preview.append(field(column.label, input));
                return { column, input };
            });
            const run = iconButton('fa-search', label('preview'));
            const result = document.createElement('output');
            result.style.cssText = 'display:block;white-space:pre-wrap;overflow-wrap:anywhere';
            result.setAttribute('aria-live', 'polite');
            preview.append(run, result);
            run.addEventListener('click', () => {
                try {
                    const values = inputs.map(({ column, input }) => {
                        if (item.mode === 'keywords') return input.value.split(/\r?\n/u).filter(value => value.trim());
                        if (column.type === 'number' && input.value.trim()) return Number(input.value);
                        if (column.type === 'boolean' && ['true', 'false'].includes(input.value.trim())) return input.value.trim() === 'true';
                        return input.value;
                    });
                    const found = queryTableIndex({ ...snapshot, indexes: definitions }, item.id, { values, limit: 50 }, {
                        owner: 'user', groupId: snapshot.groupId, columnIds: snapshot.columns.map(column => column.id),
                    });
                    result.textContent = `${label('matches')}: ${found.matches}${found.truncated ? ' (50)' : ''}\n${found.records.map(row => row.rowId).join('\n')}`;
                } catch (error) {
                    result.textContent = formatTableError(error, key => t(`tableRuntimeUi.${key}`),
                        `${error.code || 'INDEX_QUERY_INVALID'}: ${error.message}`);
                }
            });
        }
        renderPreview();
    }
    list.addEventListener('change', () => { selected = list.value; render(); });
    add.addEventListener('click', () => {
        if (definitions.length >= QUERY_INDEX_LIMITS.definitions || !snapshot.columns.length) return;
        selected = `idx-${crypto.randomUUID()}`;
        definitions.push({ version: 1, id: selected, name: label('new'), columnIds: [snapshot.columns[0].id], mode: 'exact', fieldMatch: 'all', termMatch: 'all', trim: false, caseSensitive: true });
        render();
    });
    remove.addEventListener('click', () => {
        definitions = definitions.filter(item => item.id !== selected);
        selected = definitions[0]?.id;
        render();
    });
    render();
    return { root, read: () => normalizeQueryIndexes(snapshot, definitions) };
}

function iconButton(icon, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.style.cssText = 'width:36px;height:36px;flex:0 0 36px;margin:0';
    const symbol = document.createElement('i');
    symbol.className = `fas ${icon}`;
    symbol.setAttribute('aria-hidden', 'true');
    button.append(symbol);
    return button;
}
function field(text, input) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:grid;gap:4px;min-width:0';
    input.style.width = '100%';
    input.style.minWidth = '0';
    wrapper.append(document.createTextNode(text), input);
    return wrapper;
}
function check(text, value, update) {
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = value;
    input.addEventListener('change', () => update(input.checked));
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:8px';
    wrapper.append(input, document.createTextNode(text));
    return wrapper;
}
function select(values, value, update) {
    const input = document.createElement('select');
    for (const option of values) input.add(new Option(label(option), option));
    input.value = value;
    input.addEventListener('change', () => update(input.value));
    return input;
}

export async function openTableIndexes(tableIndex) {
    const table = getState()?.[tableIndex];
    if (!table || table.owner !== 'user') return false;
    const scope = captureChatScope(getContext());
    const revision = getStateRevision();
    let dependencies;
    try { dependencies = readCurrentIndexDependencies(table); }
    catch (error) {
        toastr.error(formatTableError(error, key => t(`tableRuntimeUi.${key}`), error.message), t('tableRuntimeUi.common.failed'));
        return false;
    }
    const editor = createIndexEditor(table);
    const errorText = document.createElement('p');
    errorText.setAttribute('role', 'alert');
    editor.root.append(errorText);
    while (await callGenericPopup(editor.root, POPUP_TYPE.CONFIRM, '', {
        okButton: t('tableRuntimeUi.common.save'), cancelButton: t('tableRuntimeUi.common.cancel'),
    })) {
        try {
            const definitions = editor.read();
            assertIndexChangesAllowed(table, definitions, dependencies);
            return await configureCurrentUserTableIndexes(table.id, definitions, scope, revision, dependencies);
        }
        catch (error) {
            errorText.textContent = formatTableError(error, key => t(`tableRuntimeUi.${key}`),
                `${error.code || 'INDEX_CONFIG_INVALID'}: ${error.message}`);
            if (['TABLE_STALE', 'TABLE_PERSIST_FAILED', 'INDEX_DEPENDENCIES_STALE', 'INDEX_DEPENDENCIES_UNAVAILABLE'].includes(error.code)) {
                toastr.error(errorText.textContent, t('tableRuntimeUi.common.failed'));
                return false;
            }
        }
    }
    return false;
}
