import {
    normalizeFillAutomationConfig, normalizeFillBinding, replaceFillBinding, replaceFillProfile, removeFillProfile,
} from '../../core/table-system/fill-automation/config.js';
import { t } from '../../utils/i18n/index.js';
import { createFillAutomationTransferControls } from './fill-automation-transfer-controls.js';
import { createFillAutomationMaintenanceControls } from './fill-automation-maintenance-controls.js';

/** Host owns markup, translated labels, scope capture, confirmation and persistence. */
export function bindFillAutomationControls(elements, callbacks) {
    const { load, save, preview, run, cancel, onError = () => {} } = callbacks;
    if ([load, save, preview, run, cancel, onError].some(callback => typeof callback !== 'function')) {
        throw new TypeError('Trusted fill automation UI callbacks are required.');
    }
    const required = ['mode', 'profile', 'cycleMode', 'every', 'start', 'automatic',
        'commitMode', 'unitId', 'save', 'preview', 'run', 'retry', 'cancel', 'status'];
    if (required.some(name => !elements[name])) throw new TypeError('Missing fill automation control.');
    let disposed = false;
    let busy = false;
    let captured;
    const listeners = [];

    function refresh() {
        if (disposed) return;
        const loaded = load();
        const config = normalizeFillAutomationConfig(loaded.config);
        captured = { config, tableId: loaded.tableId, targetId: loaded.targetId };
        if (typeof captured.targetId !== 'string' || !captured.targetId) throw new TypeError('Missing UI scope identity.');
        const binding = config.bindings.find(item => item.tableId === captured.tableId)
            ?? normalizeFillBinding({ tableId: captured.tableId });
        elements.profile.replaceChildren();
        for (const profile of config.profiles) {
            const option = elements.profile.ownerDocument.createElement('option');
            option.value = profile.profileId;
            option.textContent = profile.profileId;
            elements.profile.append(option);
        }
        elements.mode.value = binding.mode;
        elements.profile.value = binding.profileRef ?? '';
        elements.cycleMode.value = binding.cycle.mode;
        elements.every.value = String(binding.cycle.every ?? 20);
        elements.start.value = String(binding.cycle.start ?? 1);
        elements.automatic.checked = binding.cycle.automaticEnabled;
        elements.commitMode.value = binding.commitUnit.mode;
        elements.unitId.value = binding.commitUnit.unitId ?? '';
        if (elements.taskKind) {
            elements.taskKind.value = binding.compression ? 'compression' : 'fill';
            elements.compressionSource.value = binding.compression?.sourceTableId ?? '';
            callbacks.refreshCompressionColumns?.(binding.compression);
            elements.compressionTarget.value = binding.compression?.targetColumnId ?? '';
            elements.compressionMaxChars.value = String(binding.compression?.maxOutputChars ?? 16000);
        }
        updateDisabled();
    }

    function updateDisabled() {
        const periodic = ['visible-messages', 'ai-replies'].includes(elements.cycleMode.value);
        for (const name of required.filter(name => !['cancel', 'status'].includes(name))) elements[name].disabled = busy;
        elements.profile.disabled = busy || elements.mode.value !== 'profile';
        elements.every.disabled = busy || !periodic;
        elements.start.disabled = busy || !periodic;
        elements.automatic.disabled = busy || !periodic;
        elements.unitId.disabled = busy || elements.commitMode.value !== 'independent';
        elements.cancel.disabled = !busy;
        for (const name of ['taskKind', 'compressionSource', 'compressionColumns', 'compressionTarget', 'compressionMaxChars']) {
            if (elements[name]) elements[name].disabled = busy;
        }
    }

    function draft() {
        const periodic = ['visible-messages', 'ai-replies'].includes(elements.cycleMode.value);
        const numeric = element => /^\d+$/u.test(element.value) ? Number(element.value) : NaN;
        return normalizeFillBinding({
            tableId: captured.tableId, mode: elements.mode.value,
            ...(elements.mode.value === 'profile' ? { profileRef: elements.profile.value } : {}),
            cycle: { mode: elements.cycleMode.value, automaticEnabled: periodic && elements.automatic.checked,
                ...(periodic ? { every: numeric(elements.every), start: numeric(elements.start) } : {}) },
            commitUnit: { mode: elements.commitMode.value,
                ...(elements.commitMode.value === 'independent' ? { unitId: elements.unitId.value } : {}) },
            ...(elements.taskKind?.value === 'compression' ? { compression: {
                sourceTableId: elements.compressionSource.value,
                sourceColumnIds: [...elements.compressionColumns.selectedOptions].map(option => option.value),
                targetColumnId: elements.compressionTarget.value, maxOutputChars: numeric(elements.compressionMaxChars),
            } } : {}),
        });
    }

    function assertTarget() {
        const live = load();
        if (live.targetId !== captured.targetId || live.tableId !== captured.tableId
            || normalizeFillAutomationConfig(live.config).revision !== captured.config.revision) {
            throw new Error('FILL_UI_TARGET_CHANGED');
        }
    }

    function bind(name, event, listener) {
        elements[name].addEventListener(event, listener);
        listeners.push(() => elements[name].removeEventListener(event, listener));
    }

    async function command(action) {
        if (disposed || busy) return;
        busy = true;
        updateDisabled();
        try {
            assertTarget();
            await action();
            if (!disposed) { assertTarget(); elements.status.textContent = t('tableRuntimeUi.fillAutomation.ready'); }
        } catch (error) {
            if (!disposed) { elements.status.textContent = t('tableRuntimeUi.fillAutomation.failed'); onError(error); }
        } finally {
            busy = false;
            if (!disposed) updateDisabled();
        }
    }

    for (const name of ['mode', 'cycleMode', 'commitMode']) bind(name, 'change', updateDisabled);
    bind('save', 'click', () => command(async () => {
        const config = replaceFillBinding(captured.config, draft(), captured.config.revision);
        const target = { tableId: captured.tableId, targetId: captured.targetId };
        const saved = await save({ ...target, config, expectedRevision: captured.config.revision });
        if (saved !== true) throw new Error('FILL_CONFIG_SAVE_NOT_CONFIRMED');
        const live = load();
        if (live.targetId !== target.targetId || live.tableId !== target.tableId) throw new Error('FILL_UI_TARGET_CHANGED');
        refresh();
    }));
    bind('preview', 'click', () => command(() => preview({ ...captured, binding: draft() })));
    // Run uses the captured saved configuration, not unpersisted form values.
    bind('run', 'click', () => command(() => run({ ...captured, retry: false })));
    bind('retry', 'click', () => command(() => run({ ...captured, retry: true })));
    bind('cancel', 'click', () => { if (!disposed) cancel(); });
    refresh();
    return Object.freeze({ refresh() {
        if (busy) throw new Error('FILL_UI_BUSY');
        refresh();
    }, dispose() {
        if (disposed) return;
        disposed = true;
        listeners.forEach(remove => remove());
        if (busy) cancel();
    } });
}

/** A single mount declaration for the parent. Labels and shared-profile confirmation stay with the host. */
export function createFillAutomationControls({ document, runtime, tableId, label, onError = () => {},
    confirmProfileImpact = async () => false, confirmAction = async () => false }) {
    if (!document || !runtime || typeof label !== 'function') throw new TypeError('Fill automation mount dependencies are required.');
    const root = document.createElement('section');
    root.className = 'amily2-fill-automation-controls';
    Object.assign(root.style, { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))', gap: '8px', minWidth: '0' });
    const elements = {};
    const listeners = [];
    let disposed = false;
    let editing = null;
    let editingRevision = null;
    let editorBusy = false;
    const append = (name, type, values, parent = root) => {
        const wrap = document.createElement('label');
        wrap.style.minWidth = '0';
        const text = document.createElement('span');
        text.textContent = label(name);
        const input = document.createElement(['select', 'textarea'].includes(type) ? type : 'input');
        if (!['select', 'textarea'].includes(type)) input.type = type;
        if (type !== 'checkbox') Object.assign(input.style, { width: '100%', minWidth: '0', boxSizing: 'border-box' });
        input.setAttribute('aria-label', label(name));
        if (values) for (const value of values) {
            const option = document.createElement('option'); option.value = value;
            option.textContent = label(`${name}.${value}`); input.append(option);
        }
        wrap.append(text, input); parent.append(wrap); elements[name] = input;
        return input;
    };
    const button = (name, icon, parent = root) => {
        const element = document.createElement('button'); element.type = 'button';
        Object.assign(element.style, { width: '32px', height: '32px', padding: '0' });
        element.className = 'menu_button'; element.title = label(name); element.setAttribute('aria-label', label(name));
        const glyph = document.createElement('i'); glyph.className = `fas fa-${icon}`; glyph.setAttribute('aria-hidden', 'true');
        element.append(glyph); parent.append(element); elements[name] = element; return element;
    };
    const listen = (element, event, callback) => { element.addEventListener(event, callback); listeners.push(() => element.removeEventListener(event, callback)); };
    append('mode', 'select', ['inherit', 'profile']); append('profile', 'select', []);
    append('cycleMode', 'select', ['inherit', 'manual', 'visible-messages', 'ai-replies']);
    for (const name of ['every', 'start']) append(name, 'number');
    append('automatic', 'checkbox'); append('commitMode', 'select', ['inherit', 'independent']); append('unitId', 'text');
    append('taskKind', 'select', ['fill', 'compression']);
    append('compressionSource', 'select', []);
    append('compressionColumns', 'select', []).multiple = true;
    append('compressionTarget', 'select', []);
    append('compressionMaxChars', 'number');
    const refreshCompressionColumns = compression => {
        const source = runtime.listColumns(tableId).find(table => table.tableId === elements.compressionSource.value);
        elements.compressionColumns.replaceChildren();
        for (const column of source?.columns ?? []) {
            const option = document.createElement('option'); option.value = column.id; option.textContent = column.label || column.id;
            option.selected = compression?.sourceColumnIds.includes(column.id) ?? false;
            elements.compressionColumns.append(option);
        }
    };
    for (const table of runtime.listColumns(tableId)) {
        if (table.tableId !== tableId) {
            const option = document.createElement('option'); option.value = table.tableId; option.textContent = table.name || table.tableId;
            elements.compressionSource.append(option);
        } else for (const column of table.columns) {
            const option = document.createElement('option'); option.value = column.id; option.textContent = column.label || column.id;
            elements.compressionTarget.append(option);
        }
    }
    listen(elements.compressionSource, 'change', () => refreshCompressionColumns());
    listen(elements.taskKind, 'change', () => {
        if (elements.taskKind.value === 'compression') {
            elements.cycleMode.value = 'visible-messages'; elements.commitMode.value = 'independent';
            elements.unitId.value ||= `compression-${tableId}`;
            elements.cycleMode.dispatchEvent(new elements.cycleMode.ownerDocument.defaultView.Event('change'));
        }
    });
    for (const [name, icon] of [['save', 'save'], ['preview', 'eye'], ['run', 'play'], ['retry', 'redo'], ['cancel', 'stop']]) button(name, icon);
    const status = document.createElement('output'); elements.status = status; root.append(status);
    const tasks = document.createElement('div'); tasks.className = 'amily2-fill-task-status'; tasks.style.gridColumn = '1 / -1'; tasks.setAttribute('role', 'status'); root.append(tasks);
    const showState = value => {
        if (disposed) return;
        tasks.replaceChildren();
        const heading = document.createElement('span'); heading.textContent = label(`status.${value.status ?? 'preview'}`); tasks.append(heading);
        const list = document.createElement('ul');
        for (const [index, item] of (value.ranges ?? value.tasks ?? []).entries()) {
            const row = document.createElement('li');
            row.textContent = value.ranges ? `${item.start}-${item.end}: ${label(`basis.${item.basis}`)}`
                : `${index + 1}: ${label(`status.${item.status}`)}`;
            list.append(row);
        }
        tasks.append(list);
    };
    const binding = bindFillAutomationControls(elements, {
        refreshCompressionColumns,
        load: () => runtime.load(tableId), save: args => runtime.saveConfig(args),
        preview: async args => showState(await runtime.preview(args)),
        run: async args => {
            const result = await runtime.run({ tableId, retry: args.retry }); showState(result);
            if (result.status !== 'succeeded') {
                const code = result.errorCode || result.units?.find(unit => unit.status !== 'succeeded')?.errorCode
                    || 'FILL_TASK_INCOMPLETE';
                throw Object.assign(new Error(code), { code });
            }
        },
        cancel: () => runtime.cancel(), onError,
    });
    const editor = document.createElement('fieldset'); editor.hidden = true; editor.style.gridColumn = '1 / -1'; editor.style.minWidth = '0'; root.append(editor);
    const fields = {};
    for (const [name, type, values] of [
        ['profileId', 'text'], ['connectionRef', 'select', []], ['model', 'text'],
        ['protocol', 'select', ['stable-selector', 'legacy-index']], ['promptRef', 'select', ['table-filling', 'profile']], ['promptText', 'textarea'],
        ['inputTokenBudget', 'number'], ['outputTokenBudget', 'number'], ['temperature', 'number'], ['topP', 'number'],
        ['readScopes', 'select', []], ['writeScopes', 'select', []],
    ]) fields[name] = append(name, type, values, editor);
    fields.model.readOnly = true;
    fields.promptText.maxLength = 16384; fields.promptText.rows = 8;
    const updatePromptInput = () => { fields.promptText.disabled = fields.promptRef.value !== 'profile'; };
    listen(fields.promptRef, 'change', updatePromptInput);
    fields.readScopes.multiple = true; fields.writeScopes.multiple = true;
    for (const name of ['temperature', 'topP']) fields[name].step = '0.01';
    const command = async action => {
        if (disposed || editorBusy) return;
        editorBusy = true;
        try { await action(); if (!disposed) binding.refresh(); }
        catch (error) { if (!disposed) onError(error); }
        finally { editorBusy = false; }
    };
    function openProfile(copy, create) {
        const loaded = runtime.load(tableId);
        const selected = loaded.config.profiles.find(profile => profile.profileId === elements.profile.value);
        if (!selected && !create) throw new Error('UNKNOWN_FILL_PROFILE');
        const tables = runtime.listColumns(tableId);
        const target = tables.find(table => table.tableId === tableId);
        if (!target) throw new Error('FILL_WRITE_FORBIDDEN');
        const connections = runtime.listConnections();
        fields.connectionRef.replaceChildren();
        for (const connection of connections) {
            const option = document.createElement('option'); option.value = connection.connectionRef;
            option.textContent = connection.name || connection.connectionRef; fields.connectionRef.append(option);
        }
        const profile = create ? { profileId: `fill-${globalThis.crypto.randomUUID()}`, revision: 0,
            tableGroupId: target.tableGroupId, connectionRef: connections[0]?.connectionRef ?? '', model: connections[0]?.model ?? '',
            protocol: 'stable-selector', promptRef: 'table-filling', inputTokenBudget: 8192, outputTokenBudget: 2048,
            parameters: {}, readScopes: [{ tableId, columnIds: target.columns.map(column => column.id) }],
            writeScopes: [{ tableId, columnIds: target.columns.map(column => column.id) }] } : structuredClone(selected);
        if (copy) { profile.profileId = `fill-${globalThis.crypto.randomUUID()}`; profile.revision = 0; }
        editing = { ...loaded, profile, isNew: create || copy };
        editingRevision = loaded.config.revision;
        for (const name of ['profileId', 'connectionRef', 'model', 'protocol', 'promptRef', 'inputTokenBudget', 'outputTokenBudget']) fields[name].value = String(profile[name]);
        fields.profileId.readOnly = !editing.isNew;
        fields.temperature.value = profile.parameters.temperature ?? '';
        fields.topP.value = profile.parameters.topP ?? '';
        fields.promptText.value = profile.promptText ?? '';
        updatePromptInput();
        for (const direction of ['readScopes', 'writeScopes']) {
            fields[direction].replaceChildren();
            for (const table of tables) for (const column of table.columns) {
                const option = document.createElement('option'); option.value = JSON.stringify([table.tableId, column.id]);
                option.textContent = `${table.name || table.tableId}: ${column.label || column.id}`;
                option.selected = profile[direction].some(scope => scope.tableId === table.tableId && scope.columnIds.includes(column.id));
                fields[direction].append(option);
            }
        }
        editor.hidden = false;
    }
    listen(fields.connectionRef, 'change', () => { fields.model.value = runtime.listConnections().find(item => item.connectionRef === fields.connectionRef.value)?.model ?? ''; });
    for (const [name, icon, copy, create] of [['profileCreate', 'plus', false, true], ['profileEdit', 'pen', false, false], ['profileCopy', 'copy', true, false]]) {
        listen(button(name, icon), 'click', () => command(() => openProfile(copy, create)));
    }
    listen(button('profileSave', 'save', editor), 'click', () => command(async () => {
        if (!editing) throw new Error('FILL_PROFILE_NOT_EDITING');
        const live = runtime.load(tableId);
        if (live.targetId !== editing.targetId || live.config.revision !== editingRevision) throw new Error('FILL_CONFIG_CHANGED');
        const scopes = direction => {
            const scopes = new Map();
            for (const option of [...fields[direction].selectedOptions]) {
                const [targetId, columnId] = JSON.parse(option.value);
                if (!scopes.has(targetId)) scopes.set(targetId, []);
                scopes.get(targetId).push(columnId);
            }
            return [...scopes].map(([tableId, columnIds]) => ({ tableId, columnIds }));
        };
        const profile = { ...editing.profile, profileId: fields.profileId.value, revision: editing.profile.revision + 1,
            connectionRef: fields.connectionRef.value, model: fields.model.value, protocol: fields.protocol.value,
            promptRef: fields.promptRef.value, inputTokenBudget: Number(fields.inputTokenBudget.value), outputTokenBudget: Number(fields.outputTokenBudget.value),
            readScopes: scopes('readScopes'), writeScopes: scopes('writeScopes'), parameters: {} };
        if (profile.promptRef === 'profile') profile.promptText = fields.promptText.value;
        else delete profile.promptText;
        for (const name of ['temperature', 'topP']) if (fields[name].value !== '') profile.parameters[name] = Number(fields[name].value);
        const affectedTableIds = live.config.bindings.filter(item => item.profileRef === profile.profileId).map(item => item.tableId);
        if (affectedTableIds.length && await confirmProfileImpact({ profile, affectedTableIds }) !== true) return;
        const config = replaceFillProfile(live.config, profile, editingRevision);
        if (disposed) return;
        if (await runtime.saveConfig({ ...live, config, expectedRevision: editingRevision }) !== true) throw new Error('FILL_CONFIG_SAVE_NOT_CONFIRMED');
        editor.hidden = true; editing = null;
    }));
    listen(button('profileDelete', 'trash'), 'click', () => command(async () => {
        const live = runtime.load(tableId);
        const config = removeFillProfile(live.config, elements.profile.value, live.config.revision);
        if (await confirmProfileImpact({ deleteProfileId: elements.profile.value, affectedTableIds: [] }) !== true || disposed) return;
        if (await runtime.saveConfig({ ...live, config, expectedRevision: live.config.revision }) !== true) throw new Error('FILL_CONFIG_SAVE_NOT_CONFIRMED');
    }));
    const transfer = createFillAutomationTransferControls({ document, runtime, tableId, label, confirmAction, onError,
        onSaved: () => { binding.refresh(); showState(runtime.getState()); } });
    root.append(transfer.element);
    const maintenance = createFillAutomationMaintenanceControls({ document, runtime, tableId, label, confirmAction, onError });
    root.append(maintenance.element);
    showState(runtime.getState());
    return Object.freeze({ element: root, elements, fields, refresh() { binding.refresh(); showState(runtime.getState()); },
        dispose() { disposed = true; binding.dispose(); transfer.dispose(); maintenance.dispose(); listeners.forEach(remove => remove()); } });
}
