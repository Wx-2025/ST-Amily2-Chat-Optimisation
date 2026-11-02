import { exportFillPreset, readFillPreset, describeFillPreset, prepareFillPresetImport } from '../../core/table-system/fill-automation/preset.js';

export function createFillAutomationTransferControls({ document, runtime, tableId, label, confirmAction, onError, onSaved }) {
    const element = document.createElement('fieldset');
    element.style.gridColumn = '1 / -1'; element.style.minWidth = '0';
    const legend = document.createElement('legend'); legend.textContent = label('preset'); element.append(legend);
    const controls = document.createElement('div'); element.append(controls);
    const mappings = document.createElement('div'); element.append(mappings);
    const status = document.createElement('output'); element.append(status);
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json';
    file.setAttribute('aria-label', label('presetImport')); controls.append(file);
    let disposed = false;
    let busy = false;
    let preview = null;
    const listeners = [];
    const listen = (node, event, action) => { node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action)); };
    const button = (key, icon) => {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'menu_button';
        node.title = label(key); node.setAttribute('aria-label', label(key));
        const glyph = document.createElement('i'); glyph.className = `fas fa-${icon}`; glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph); controls.append(node); return node;
    };
    const download = button('presetExport', 'download');
    const save = button('presetApply', 'save'); save.disabled = true;
    const assertCurrent = captured => {
        const live = runtime.load(tableId);
        if (disposed || live.targetId !== captured.targetId || live.config.revision !== captured.config.revision) throw new Error('FILL_UI_TARGET_CHANGED');
        return live;
    };
    const command = async action => {
        if (disposed || busy) return;
        busy = true; file.disabled = true; download.disabled = true; save.disabled = true;
        try { await action(); }
        catch (error) { if (!disposed) { status.textContent = label('failed'); onError(error); } }
        finally { busy = false; if (!disposed) { file.disabled = false; download.disabled = false; save.disabled = !preview; } }
    };
    const select = (title, options, parent) => {
        const wrap = document.createElement('label'); wrap.textContent = title;
        const node = document.createElement('select'); node.style.maxWidth = '100%'; node.setAttribute('aria-label', title);
        const empty = document.createElement('option'); empty.value = ''; empty.textContent = label('mappingRequired'); node.append(empty);
        for (const { value, text } of options) {
            const option = document.createElement('option'); option.value = value; option.textContent = text; node.append(option);
        }
        wrap.append(node); parent.append(wrap); return node;
    };
    listen(download, 'click', () => command(async () => {
        const captured = runtime.load(tableId);
        const content = JSON.stringify(exportFillPreset(captured.config), null, 2);
        if (!await confirmAction({ action: 'presetExport', details: [label('presetPrivacy')] })) return;
        assertCurrent(captured);
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        try {
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'amily-fill-preset.json';
            anchor.click();
        } finally { URL.revokeObjectURL(url); }
    }));
    listen(file, 'change', () => command(async () => {
        preview = null; mappings.replaceChildren();
        const chosen = file.files?.[0];
        if (!chosen) return;
        if (chosen.size > 1100000) throw new Error('FILL_PRESET_LIMIT');
        const captured = runtime.load(tableId);
        const preset = readFillPreset(await chosen.text()); assertCurrent(captured);
        const required = describeFillPreset(preset);
        const connections = runtime.listConnections();
        const tables = runtime.listPresetTables();
        const connectionInputs = required.connections.map(slot => ({ slot, input: select(slot,
            connections.map(item => ({ value: item.connectionRef, text: item.name || item.connectionRef })), mappings) }));
        const tableInputs = required.tables.map(source => {
            const row = document.createElement('div'); mappings.append(row);
            const input = select(source.tableId, tables.map(table => ({ value: table.tableId, text: table.name || table.tableId })), row);
            const columns = document.createElement('div'); row.append(columns);
            const entry = { source, input, columns: [] };
            listen(input, 'change', () => {
                columns.replaceChildren(); entry.columns = [];
                const table = tables.find(table => table.tableId === input.value);
                if (!table) return;
                entry.columns = source.columnIds.map(columnId => ({ sourceColumnId: columnId, input: select(columnId,
                    table.columns.map(column => ({ value: column.id, text: column.label || column.id })), columns) }));
            });
            return entry;
        });
        preview = { captured, preset, connectionInputs, tableInputs };
        status.textContent = label('presetAutomaticOff');
    }));
    listen(save, 'click', () => command(async () => {
        const pending = preview;
        if (!pending) return;
        const live = assertCurrent(pending.captured);
        const selectedMappings = {
                connections: pending.connectionInputs.map(item => ({ slot: item.slot, connectionRef: item.input.value })),
                tables: pending.tableInputs.map(item => ({ sourceTableId: item.source.tableId, targetTableId: item.input.value,
                    columns: item.columns.map(column => ({ sourceColumnId: column.sourceColumnId, targetColumnId: column.input.value })) })),
            };
        const prepare = () => prepareFillPresetImport(pending.preset, { currentConfig: live.config,
            connections: runtime.listConnections(), tables: runtime.listPresetTables(), mappings: selectedMappings });
        const plan = prepare();
        if (!await confirmAction({ action: 'presetApply', details: [label('presetReplace'), ...plan.affectedTableIds] })) return;
        assertCurrent(pending.captured);
        if (JSON.stringify(prepare()) !== JSON.stringify(plan)) throw new Error('FILL_PRESET_MAPPING_CHANGED');
        if (await runtime.saveConfig({ ...live, config: plan.config, expectedRevision: plan.expectedRevision, purpose: 'preset-import' }) !== true) throw new Error('FILL_CONFIG_SAVE_NOT_CONFIRMED');
        preview = null; mappings.replaceChildren(); file.value = '';
        status.textContent = label('status.succeeded'); onSaved();
    }));
    return { element, dispose() { disposed = true; listeners.forEach(remove => remove()); preview = null; } };
}
