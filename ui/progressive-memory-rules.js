import { pmText } from '../core/progressive-memory/i18n.js';
import { pmElement, pmField, pmSelect } from './progressive-memory-sources.js';

export function deriveMemoryRuleGrants(rule, tables) {
    const trigger = tables.find(table => table.id === rule.trigger.tableId);
    const source = tables.find(table => table.id === rule.source.tableId);
    if (!trigger || !source || trigger.groupId !== source.groupId || trigger.owner !== 'user' || source.owner !== 'user') throw new Error('MEMORY_ACCESS_DENIED');
    const triggerColumns = rule.trigger.conditions.flatMap(condition => {
        const index = trigger.indexes?.find(item => item.id === condition.indexId);
        if (!index) throw new Error('MEMORY_INDEX_UNAVAILABLE');
        return index.columnIds;
    });
    if (rule.maxHops === 1) triggerColumns.push(rule.relationId);
    const grants = new Map([[trigger.id, new Set(triggerColumns)]]);
    if (!grants.has(source.id)) grants.set(source.id, new Set());
    rule.source.columnIds.forEach(id => grants.get(source.id).add(id));
    return [...grants].map(([tableId, columns]) => ({ tableId, columnIds: [...columns] }));
}

export function mountProgressiveMemoryRules(host, api) {
    host.replaceChildren(pmElement('legend', pmText('rules'), { 'data-pm-i18n': 'rules' }));
    const store = api.getStore();
    if (store.memoryRulesError) {
        host.append(pmElement('p', pmText('configRetained'), { role: 'alert', 'data-pm-i18n': 'configRetained' }));
        return;
    }
    const config = store.memoryRules;
    const consumer = pmField(host, 'consumer', pmSelect(['progressive', 'memory-blocks', 'super-memory'].map(value => [value, pmText(value)]),
        config.consumer, false, ['progressive', 'memory-blocks', 'super-memory']));
    consumer.addEventListener('change', () => {
        if (!window.confirm(pmText('confirmConsumer'))) { consumer.value = config.consumer; return; }
        api.getStore().memoryRules.consumer = consumer.value;
        api.save(); mountProgressiveMemoryRules(host, api);
    });
    const enable = pmField(host, 'enabled', pmElement('input', '', { type: 'checkbox' }));
    enable.checked = config.enabled;
    enable.addEventListener('change', () => { api.getStore().memoryRules.enabled = enable.checked; api.save(); });
    const budget = pmField(host, 'tokens', pmElement('input', '', { type: 'number', min: 0, max: 8000, value: config.maxTokens }));
    budget.addEventListener('change', () => { api.getStore().memoryRules.maxTokens = Number(budget.value); api.save(); });
    const button = (parent, name, icon, action) => {
        const control = pmElement('button', '', { type: 'button', class: 'menu_button', title: pmText(name), 'aria-label': pmText(name), 'data-pm-i18n-title': name });
        control.append(pmElement('i', '', { class: `fas fa-${icon}` }));
        control.addEventListener('click', action);
        parent.append(control);
        return control;
    };
    for (const rule of config.rules) {
        const row = pmElement('div', '', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;' });
        const toggle = pmElement('input', '', { type: 'checkbox', 'aria-label': pmText('enabled'), 'data-pm-i18n-title': 'enabled' });
        toggle.checked = rule.enabled;
        toggle.addEventListener('change', () => {
            const current = api.getStore().memoryRules;
            const saved = current.rules.find(item => item.id === rule.id);
            if (toggle.checked && !window.confirm(pmText('confirm') + '\n' + JSON.stringify(current.grants))) { toggle.checked = false; return; }
            saved.enabled = toggle.checked;
            saved.revision++;
            if (toggle.checked) current.dataEgressAcknowledged = true;
            api.save();
        });
        row.append(toggle, pmElement('span', pmText(rule.kind), { 'data-pm-i18n': rule.kind }), pmElement('span', rule.id, { style: 'overflow-wrap:anywhere' }));
        button(row, 'edit', 'pen', () => edit(rule));
        button(row, 'remove', 'trash', () => {
            api.getStore().memoryRules.rules = api.getStore().memoryRules.rules.filter(item => item.id !== rule.id);
            api.save(); mountProgressiveMemoryRules(host, api);
        });
        host.append(row);
    }
    button(host, 'new', 'plus', () => edit());
    const editor = pmElement('div');
    host.append(editor);
    function edit(existing) {
        editor.replaceChildren();
        const groupId = api.getStore().groupId;
        const tables = api.getTables().filter(table => table.groupId === groupId);
        const options = [['', pmText('choose')], ...tables.map(table => [table.id, table.name || table.id])];
        const kind = pmField(editor, 'kind', pmSelect(['character', 'event'].map(id => [id, pmText(id)]), existing?.kind || 'character', false, ['character', 'event']));
        const trigger = pmField(editor, 'trigger', pmSelect(options, existing?.trigger.tableId || '', false, ['choose']));
        const match = pmField(editor, 'match', pmSelect(['all', 'any'].map(id => [id, pmText(id)]), existing?.trigger.match || 'all', false, ['all', 'any']));
        const conditions = pmElement('div');
        editor.append(conditions);
        const conditionInputs = [];
        function addCondition(condition = {}) {
            if (conditionInputs.length >= 4) return;
            const row = pmElement('div');
            const table = tables.find(item => item.id === trigger.value);
            const index = pmField(row, 'index', pmSelect((table?.indexes ?? []).map(item => [item.id, item.name || item.id]), condition.indexId || ''));
            const values = pmField(row, 'values', pmElement('textarea', '', { rows: 2, maxlength: 4096, style: 'width:100%;box-sizing:border-box' }));
            values.value = JSON.stringify(condition.values ?? []);
            const pair = { row, index, values };
            conditionInputs.push(pair);
            button(row, 'remove', 'minus', () => { conditionInputs.splice(conditionInputs.indexOf(pair), 1); row.remove(); });
            conditions.append(row);
        }
        button(editor, 'condition', 'plus', () => addCondition());
        for (const condition of existing?.trigger.conditions ?? [{}]) addCondition(condition);
        trigger.addEventListener('change', () => { conditions.replaceChildren(); conditionInputs.length = 0; addCondition(); refreshRoute(); });
        const source = pmField(editor, 'source', pmSelect(options, existing?.source.tableId || '', false, ['choose']));
        const columns = pmField(editor, 'columns', pmSelect([], [], true));
        function refreshColumns(ids = []) {
            columns.replaceChildren();
            const table = tables.find(item => item.id === source.value);
            for (const column of table?.columns ?? []) columns.add(new Option(column.label || column.id, column.id, false, ids.includes(column.id)));
        }
        refreshColumns(existing?.source.columnIds);
        const route = pmField(editor, 'route', pmSelect([], ''));
        function refreshRoute() {
            route.replaceChildren(new Option(pmText('direct'), ''));
            route.options[0].setAttribute('data-pm-i18n', 'direct');
            for (const column of tables.find(item => item.id === trigger.value)?.columns ?? []) {
                if (column.recordRelation?.targetTableId === source.value) route.add(new Option(column.label || column.id, column.id));
            }
            route.value = existing?.relationId || '';
        }
        refreshRoute();
        source.addEventListener('change', () => { refreshColumns(); refreshRoute(); });
        const results = pmField(editor, 'results', pmElement('input', '', { type: 'number', min: 1, max: 200, value: existing?.budget.results ?? 10 }));
        const tokens = pmField(editor, 'ruleTokens', pmElement('input', '', { type: 'number', min: 1, max: 65536, value: existing?.budget.tokens ?? 4096 }));
        const output = pmElement('pre', '', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto', 'aria-live': 'polite' });
        function draft() {
            const rule = { version: 1, id: existing?.id || crypto.randomUUID(), revision: (existing?.revision ?? 0) + 1,
                enabled: true, kind: kind.value, trigger: { tableId: trigger.value, match: match.value,
                    conditions: conditionInputs.map(pair => ({ indexId: pair.index.value, values: JSON.parse(pair.values.value) })) },
                source: { tableId: source.value, columnIds: Array.from(columns.selectedOptions, option => option.value) },
                maxHops: route.value ? 1 : 0, ...(route.value ? { relationId: route.value } : {}),
                budget: { results: Number(results.value), tokens: Number(tokens.value) } };
            return { rule, grants: deriveMemoryRuleGrants(rule, tables) };
        }
        async function preview() {
            const value = draft();
            const result = await api.previewRule(value.rule, value.grants);
            if (result.diagnostics.length) throw new Error('MEMORY_RULE_INVALID');
            return { ...value, result };
        }
        button(editor, 'preview', 'eye', async () => {
            try {
                const { result } = await preview();
                output.textContent = result.budgetPreview
                    ? `${pmText('finalPreview')}\n${JSON.stringify(result.budgetPreview, null, 2)}`
                    : result.candidates.map(item => item.record.content).join('\n') || pmText('empty');
            } catch { output.textContent = pmText('invalid'); }
        });
        button(editor, 'save', 'save', async () => {
            try {
                const value = await preview();
                if (!window.confirm(pmText('confirm') + '\n' + JSON.stringify(value.grants))) return;
                // Revalidate after confirmation; preview never grants persisted authority.
                if (!value.result.isCurrent()) throw new Error('MEMORY_STALE');
                const checked = await api.previewRule(value.rule, value.grants);
                if (checked.diagnostics.length || !checked.isCurrent() || !value.result.isCurrent()) throw new Error('MEMORY_STALE');
                const current = api.getStore().memoryRules;
                if (!existing && current.rules.length >= 16) throw new Error('MEMORY_LIMIT');
                const rules = [...current.rules.filter(rule => rule.id !== value.rule.id), value.rule];
                const merged = new Map(current.grants.map(grant => [grant.tableId, new Set(grant.columnIds)]));
                for (const grant of value.grants) {
                    if (!merged.has(grant.tableId)) merged.set(grant.tableId, new Set());
                    grant.columnIds.forEach(id => merged.get(grant.tableId).add(id));
                }
                const next = { ...current, rules, grants: [...merged].map(([tableId, ids]) => ({ tableId, columnIds: [...ids] })),
                    dataEgressAcknowledged: true, enabled: true };
                if (!api.validateRuleConfig(next)) throw new Error('MEMORY_CONFIG_LIMIT');
                api.getStore().memoryRules = next;
                api.save(); mountProgressiveMemoryRules(host, api);
            } catch { output.textContent = pmText('invalid'); }
        });
        editor.append(output);
    }
}
