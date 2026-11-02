import { pmText } from '../core/progressive-memory/i18n.js';
import { resolveEffectiveTokenBudget } from '../core/progressive-memory/policy.js';
import { mountProgressiveMemoryRules } from './progressive-memory-rules.js';

export function pmElement(tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
}

export function pmField(parent, name, control) {
    const label = pmElement('label', '', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0;max-width:100%;' });
    label.append(pmElement('span', pmText(name), { 'data-pm-i18n': name }), control);
    control.style.maxWidth = '100%';
    control.style.minWidth = '0';
    parent.append(label);
    return control;
}

export function pmSelect(options, value, multiple = false, labelKeys = []) {
    const select = pmElement('select', '', { class: 'text_pole' });
    select.multiple = multiple;
    if (multiple) select.size = 5;
    options.forEach(([id, name], index) => {
        const option = new Option(name, id, false, multiple ? value.includes(id) : value === id);
        if (labelKeys[index]) option.setAttribute('data-pm-i18n', labelKeys[index]);
        select.add(option);
    });
    return select;
}

export function mountProgressiveMemorySources(host, api) {
    if (!host) return;
    host.replaceChildren();
    const store = api.getStore();
    if (store.sourcesVersionError) {
        host.append(pmElement('p', pmText('versionRetained'), { role: 'alert', 'data-pm-i18n': 'versionRetained' }));
        return;
    }
    // Existing single-source values migrate without changing enablement or consent.
    store.sourcesVersion = 2;
    for (const legacy of document.querySelectorAll('[data-pm-legacy-budget]')) legacy.hidden = true;
    const section = pmElement('fieldset', '', { class: 'sm-settings-group' });
    section.append(pmElement('legend', pmText('title'), { 'data-pm-i18n': 'title' }));
    host.append(section);
    const tables = api.getTables();
    const groups = [...new Set(tables.map(table => table.groupId).filter(Boolean))];
    const group = pmField(section, 'group', pmSelect(groups.map(id => [id, id]), store.groupId));
    const save = () => { api.save(); mountProgressiveMemorySources(host, api); };
    group.addEventListener('change', () => {
        const current = api.getStore();
        current.groupId = group.value;
        current.dataEgressAcknowledged = false;
        current.secondary.dataEgressAcknowledged = false;
        current.memoryRules.dataEgressAcknowledged = false;
        save();
    });
    const check = (name, value, change) => {
        const input = pmField(section, name, pmElement('input', '', { type: 'checkbox' }));
        input.checked = value;
        input.addEventListener('change', () => { change(input.checked); save(); });
        return input;
    };
    const numeric = (name, value, max, change) => {
        const input = pmField(section, name, pmElement('input', '', { type: 'number', min: 0, max, step: 1, value, style: 'width:110px' }));
        input.addEventListener('change', () => { change(Number(input.value)); save(); });
    };
    check('primary', store.primaryEnabled, value => { api.getStore().primaryEnabled = value; });
    numeric('tokens', store.primaryTokens ?? resolveEffectiveTokenBudget(store.maxTokens, 12000), 12000,
        value => { api.getStore().primaryTokens = value; });
    check('secondary', store.secondary.enabled, value => { api.getStore().secondary.enabled = value; });
    const scoped = tables.filter(table => table.groupId === store.groupId);
    const source = pmField(section, 'source', pmSelect([['', pmText('choose')], ...scoped.map(table => [table.id, table.name || table.id])], store.secondary.targetTableId, false, ['choose']));
    source.addEventListener('change', () => {
        Object.assign(api.getStore().secondary, { targetTableId: source.value, allowedColumnIds: [], dataEgressAcknowledged: false });
        save();
    });
    const table = scoped.find(table => table.id === store.secondary.targetTableId);
    const columns = pmField(section, 'columns', pmSelect((table?.columns ?? []).map((column, index) => [column.id, column.label || table.headers[index] || column.id]), store.secondary.allowedColumnIds, true));
    columns.addEventListener('change', () => {
        Object.assign(api.getStore().secondary, { allowedColumnIds: Array.from(columns.selectedOptions, option => option.value), dataEgressAcknowledged: false });
        save();
    });
    for (const [name, key, max] of [['threshold', 'minEligibleRows', 10000], ['samples', 'sampleCount', 128], ['tokens', 'maxTokens', 8000]]) {
        numeric(name, store.secondary[key], max, value => { api.getStore().secondary[key] = value; });
    }
    check('consent', store.secondary.dataEgressAcknowledged, value => { api.getStore().secondary.dataEgressAcknowledged = value; });
    numeric('total', store.totalTokens, 16000, value => { api.getStore().totalTokens = value; });
    check('borrow', store.borrowUnusedBudget, value => { api.getStore().borrowUnusedBudget = value; });
    const priority = pmField(section, 'priority', pmSelect(['primary', 'secondary'].map(id => [id, pmText(id)]), store.sourcePriority, false, ['primary', 'secondary']));
    priority.addEventListener('change', () => { api.getStore().sourcePriority = priority.value; save(); });
    const rules = pmElement('fieldset', '', { class: 'sm-settings-group' });
    host.append(rules);
    mountProgressiveMemoryRules(rules, api);
}
