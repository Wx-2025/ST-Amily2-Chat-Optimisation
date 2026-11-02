import { queryTableIndex } from './query-indexes.js';
import { isInactiveRow } from './row-lifecycle.js';

export const MEMORY_RULE_PLAN_LIMITS = Object.freeze({
    rules: 16, conditions: 4, tables: 32, columns: 128, sourceColumns: 16,
    rows: 20000, scannedRows: 100000, relations: 32, links: 4000,
    results: 200, tokens: 65536, cellChars: 8192, inputChars: 1024 * 1024,
    coveredSources: 400, outputChars: 512 * 1024,
});
const SNAPSHOT_KEYS = ['chatId', 'epoch', 'groupId', 'stateRevision', 'authorizationRevision', 'configRevision'];
const RULE_KEYS = new Set(['version', 'id', 'revision', 'enabled', 'kind', 'trigger', 'source', 'maxHops', 'relationId', 'budget']);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value); }
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function ids(value, max, allowEmpty = false) {
    return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= max
        && value.every(validId) && new Set(value).size === value.length;
}
function shape(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function snapshotOf(value) {
    if (!value || !validId(value.chatId) || !revision(value.epoch) || !validId(value.groupId)
        || SNAPSHOT_KEYS.slice(3).some(key => !revision(value[key]))) fail('MEMORY_SNAPSHOT_INVALID');
    return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, value[key]]));
}
function budgetOf(value) {
    if (!shape(value, ['results', 'tokens']) || !Number.isInteger(value.results) || value.results < 1
        || value.results > MEMORY_RULE_PLAN_LIMITS.results || !Number.isInteger(value.tokens)
        || value.tokens < 1 || value.tokens > MEMORY_RULE_PLAN_LIMITS.tokens) fail('MEMORY_BUDGET_INVALID');
    return { results: value.results, tokens: value.tokens };
}
function validateRule(rule) {
    if (!shape(rule, [...RULE_KEYS]) || rule.version !== 1 || !validId(rule.id) || !revision(rule.revision)
        || typeof rule.enabled !== 'boolean' || !['character', 'event'].includes(rule.kind)
        || !shape(rule.trigger, ['tableId', 'match', 'conditions']) || !validId(rule.trigger.tableId)
        || !['all', 'any'].includes(rule.trigger.match) || !Array.isArray(rule.trigger.conditions)
        || !rule.trigger.conditions.length || rule.trigger.conditions.length > MEMORY_RULE_PLAN_LIMITS.conditions
        || rule.trigger.conditions.some(item => !shape(item, ['indexId', 'values']) || !validId(item.indexId)
            || !Array.isArray(item.values) || !item.values.length || item.values.length > 8)
        || !shape(rule.source, ['tableId', 'columnIds']) || !validId(rule.source.tableId)
        || !ids(rule.source.columnIds, MEMORY_RULE_PLAN_LIMITS.sourceColumns)
        || ![0, 1].includes(rule.maxHops)
        || (rule.maxHops === 0 && (rule.relationId !== undefined || rule.source.tableId !== rule.trigger.tableId))
        || (rule.maxHops === 1 && !validId(rule.relationId))) fail('MEMORY_RULE_INVALID');
    budgetOf(rule.budget);
}
function cellKey(source, columnId) {
    return JSON.stringify([source.chatId, source.epoch, source.groupId, source.tableId, source.rowId, source.stateRevision, columnId]);
}

/**
 * Pure, synchronous, local candidate planning. Inputs must be trusted authorized
 * snapshots, never permission objects provided by a card/model. Relations are
 * explicit stable-row-ID edges, NOT legacy business-value reference cells.
 * Rule order then source rowId (UTF-16 lexical order) is the deterministic order.
 * No registry, Type discovery, recursive traversal, tokenizer/model or egress.
 */
export function planMemoryRules(input) {
    const snapshot = snapshotOf(input?.snapshot);
    const budget = budgetOf(input?.budget);
    const access = input?.access;
    if (access?.owner !== 'user' || !validId(access.groupId) || access.groupId !== snapshot.groupId || !Array.isArray(access.tables)
        || access.tables.length > MEMORY_RULE_PLAN_LIMITS.tables
        || access.tables.some(grant => !validId(grant?.tableId) || !ids(grant.columnIds, MEMORY_RULE_PLAN_LIMITS.columns))
        || new Set(access.tables.map(grant => grant.tableId)).size !== access.tables.length
        || !ids(access.relationIds, MEMORY_RULE_PLAN_LIMITS.relations, true)) fail('MEMORY_ACCESS_DENIED');
    if (!Array.isArray(input.tables) || input.tables.length > MEMORY_RULE_PLAN_LIMITS.tables
        || input.tables.some(table => !validId(table?.id))
        || new Set(input.tables.map(table => table.id)).size !== input.tables.length
        || !Array.isArray(input.rules) || input.rules.length > MEMORY_RULE_PLAN_LIMITS.rules) fail('MEMORY_INPUT_INVALID');
    const relations = input.relations ?? [];
    const coveredSources = input.coveredSources ?? [];
    if (!Array.isArray(relations) || relations.length > MEMORY_RULE_PLAN_LIMITS.relations
        || !Array.isArray(coveredSources) || coveredSources.length > MEMORY_RULE_PLAN_LIMITS.coveredSources) fail('MEMORY_LIMIT');
    const seenRuleIds = new Set();
    for (const rule of input.rules) {
        if (!validId(rule?.id) || seenRuleIds.has(rule.id)) fail('MEMORY_RULE_IDENTITY_INVALID');
        seenRuleIds.add(rule.id);
    }
    const covered = new Set();
    for (const source of coveredSources) {
        if (!source || !validId(source.chatId) || !revision(source.epoch) || !validId(source.groupId)
            || !validId(source.tableId) || !validId(source.rowId) || !revision(source.stateRevision)
            || !ids(source.columnIds, MEMORY_RULE_PLAN_LIMITS.sourceColumns)) fail('MEMORY_COVERAGE_INVALID');
        // Different revisions/epochs are not proof of coverage of this source.
        if (source.chatId !== snapshot.chatId || source.epoch !== snapshot.epoch || source.groupId !== access.groupId
            || source.stateRevision !== snapshot.stateRevision) continue;
        for (const id of source.columnIds) covered.add(cellKey(source, id));
    }
    const usage = { scannedRows: 0, inputChars: 0, outputChars: 0, links: 0, results: 0, estimatedTokens: 0 };
    const grants = new Map(access.tables.map(grant => [grant.tableId, grant]));
    const tables = new Map(input.tables.map(table => [table.id, table]));
    function authorize(tableId, columnIds) {
        const table = tables.get(tableId);
        const grant = grants.get(tableId);
        if (!table || table.owner !== 'user' || table.groupId !== access.groupId || !grant
            || columnIds.some(id => !grant.columnIds.includes(id))) fail('MEMORY_ACCESS_DENIED');
        if (!Array.isArray(table.columns) || table.columns.length > MEMORY_RULE_PLAN_LIMITS.columns
            || !ids(table.columns.map(column => column?.id), MEMORY_RULE_PLAN_LIMITS.columns)
            || columnIds.some(id => !table.columns.some(column => column.id === id))) fail('MEMORY_SCHEMA_INVALID');
        return table;
    }
    function readRows(tableId, columnIds, selectedIds = null) {
        const table = authorize(tableId, columnIds);
        if (!Array.isArray(table.rows) || table.rows.length > MEMORY_RULE_PLAN_LIMITS.rows) fail('MEMORY_LIMIT');
        usage.scannedRows += table.rows.length;
        if (usage.scannedRows > MEMORY_RULE_PLAN_LIMITS.scannedRows) fail('MEMORY_LIMIT');
        const positions = columnIds.map(id => table.columns.findIndex(column => column.id === id));
        const seen = new Set();
        const records = [];
        for (let index = 0; index < table.rows.length; index++) {
            if (isInactiveRow(table, index)) continue;
            const rowId = table.rowMeta?.[index]?.id;
            if (!validId(rowId) || seen.has(rowId)) fail('MEMORY_SOURCE_IDENTITY_INVALID');
            seen.add(rowId);
            if (selectedIds && !selectedIds.has(rowId)) continue;
            const values = positions.map(position => {
                const value = table.rows[index]?.[position];
                if (!(value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean'
                    || (typeof value === 'number' && Number.isFinite(value)))) fail('MEMORY_SOURCE_VALUE_INVALID');
                const size = typeof value === 'string' ? value.length : 8;
                usage.inputChars += size;
                if (size > MEMORY_RULE_PLAN_LIMITS.cellChars || usage.inputChars > MEMORY_RULE_PLAN_LIMITS.inputChars) fail('MEMORY_LIMIT');
                return value;
            });
            records.push({ rowId, values });
        }
        return { table, records };
    }
    const candidates = [];
    const diagnostics = [];
    const dependencies = [];
    let truncated = false;
    for (const rule of input.rules) {
        try {
            validateRule(rule);
            if (!rule.enabled) continue;
            // Validate source authorization independently, before running a trigger.
            authorize(rule.source.tableId, rule.source.columnIds);
            const triggerTable = authorize(rule.trigger.tableId, []);
            if (!Array.isArray(triggerTable.indexes) || triggerTable.indexes.length > 16) fail('MEMORY_RULE_INVALID');
            const definitions = rule.trigger.conditions.map(condition => {
                const definition = triggerTable.indexes.find(index => index?.id === condition.indexId);
                if (!definition || !ids(definition.columnIds, 8)) fail('MEMORY_RULE_INVALID');
                authorize(triggerTable.id, definition.columnIds);
                return definition;
            });
            const triggerColumns = [...new Set(definitions.flatMap(definition => definition.columnIds))];
            const triggerRead = readRows(triggerTable.id, triggerColumns);
            const view = { id: triggerTable.id, owner: 'user', groupId: access.groupId,
                columns: triggerColumns.map(id => ({ id })), indexes: [...new Map(definitions.map(def => [def.id, def])).values()],
                rows: triggerRead.records.map(record => record.values), rowMeta: triggerRead.records.map(record => ({ id: record.rowId })) };
            const hits = rule.trigger.conditions.map(condition => {
                // Empty/null exact triggers must not turn blank records into a
                // broad memory activation; keyword validation stays in the index.
                if (condition.values.some(value => value === undefined || value === null || (typeof value === 'string' && !value.trim()))) fail('MEMORY_TRIGGER_EMPTY');
                usage.scannedRows += view.rows.length;
                if (usage.scannedRows > MEMORY_RULE_PLAN_LIMITS.scannedRows) fail('MEMORY_LIMIT');
                const result = queryTableIndex(view, condition.indexId, { values: condition.values, limit: MEMORY_RULE_PLAN_LIMITS.results },
                    { owner: 'user', groupId: access.groupId, columnIds: triggerColumns });
                if (result.truncated) fail('MEMORY_TRIGGER_LIMIT');
                return new Set(result.records.map(record => record.rowId));
            });
            const matchedIds = rule.trigger.match === 'all'
                ? new Set([...hits[0]].filter(id => hits.every(set => set.has(id))))
                : new Set(hits.flatMap(set => [...set]));
            const routes = new Map([...matchedIds].map(rowId => [rowId, [rowId]]));
            let relation = null;
            if (rule.maxHops === 1) {
                if (!access.relationIds.includes(rule.relationId)) fail('MEMORY_ACCESS_DENIED');
                const matches = relations.filter(item => item?.id === rule.relationId);
                if (matches.length !== 1) fail('MEMORY_RELATION_INVALID');
                relation = matches[0];
                if (!shape(relation, ['id', 'revision', 'fromTableId', 'toTableId', 'columnId', 'links']) || !revision(relation.revision)
                    || relation.fromTableId !== rule.trigger.tableId || relation.toTableId !== rule.source.tableId
                    || !validId(relation.columnId)) fail('MEMORY_RELATION_INVALID');
                authorize(relation.fromTableId, [relation.columnId]);
                if (!Array.isArray(relation.links) || relation.links.length > MEMORY_RULE_PLAN_LIMITS.links) fail('MEMORY_RELATION_INVALID');
                usage.links += relation.links.length;
                if (usage.links > MEMORY_RULE_PLAN_LIMITS.links) fail('MEMORY_LIMIT');
                routes.clear();
                for (const link of relation.links) {
                    if (!shape(link, ['fromRowId', 'toRowId']) || !validId(link.fromRowId) || !validId(link.toRowId)) fail('MEMORY_RELATION_INVALID');
                    if (!matchedIds.has(link.fromRowId)) continue;
                    if (!routes.has(link.toRowId)) routes.set(link.toRowId, []);
                    const from = routes.get(link.toRowId);
                    if (!from.includes(link.fromRowId)) from.push(link.fromRowId);
                }
            }
            dependencies.push({ ruleId: rule.id, revision: rule.revision,
                triggerTableId: rule.trigger.tableId, sourceTableId: rule.source.tableId,
                ...(relation ? { relationId: relation.id, relationRevision: relation.revision, relationColumnId: relation.columnId } : {}) });
            if (!routes.size) continue;
            const sourceRead = readRows(rule.source.tableId, rule.source.columnIds, new Set(routes.keys()));
            const ordered = sourceRead.records.sort((a, b) => a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);
            const pending = [];
            let ruleTokens = 0;
            let ruleOutputChars = 0;
            for (const record of ordered) {
                const source = { chatId: snapshot.chatId, epoch: snapshot.epoch, groupId: access.groupId,
                    tableId: rule.source.tableId, rowId: record.rowId, stateRevision: snapshot.stateRevision,
                    columnIds: rule.source.columnIds.filter(id => !covered.has(cellKey({ ...snapshot, groupId: access.groupId,
                        tableId: rule.source.tableId, rowId: record.rowId }, id))) };
                if (!source.columnIds.length) continue;
                const cells = source.columnIds.map(id => [id, record.values[rule.source.columnIds.indexOf(id)]]);
                if (cells.some(([, value]) => value === undefined)) fail('MEMORY_SOURCE_VALUE_INVALID');
                const content = JSON.stringify(cells);
                // Explicit conservative cost unit, not a claim about a provider's
                // tokenizer. The final prompt still needs its own real token gate.
                const estimatedTokens = new TextEncoder().encode(content).length;
                if (pending.length >= rule.budget.results || candidates.length + pending.length >= budget.results
                    || ruleTokens + estimatedTokens > rule.budget.tokens || usage.estimatedTokens + ruleTokens + estimatedTokens > budget.tokens) {
                    truncated = true;
                    continue;
                }
                const candidate = { kind: rule.kind, ruleId: rule.id, ruleRevision: rule.revision, source, content,
                    estimatedTokens, trigger: { tableId: rule.trigger.tableId, rowIds: [...routes.get(record.rowId)].sort(),
                        indexIds: rule.trigger.conditions.map(condition => condition.indexId),
                        ...(relation ? { relationId: relation.id, revision: relation.revision, columnId: relation.columnId } : {}) } };
                ruleOutputChars += JSON.stringify(candidate).length + JSON.stringify(source).length;
                if (usage.outputChars + ruleOutputChars > MEMORY_RULE_PLAN_LIMITS.outputChars) fail('MEMORY_LIMIT');
                pending.push(candidate);
                ruleTokens += estimatedTokens;
            }
            // Publish one rule's candidates only after all its sources validate.
            for (const candidate of pending) {
                candidates.push(candidate);
                for (const id of candidate.source.columnIds) covered.add(cellKey(candidate.source, id));
            }
            usage.estimatedTokens += ruleTokens;
            usage.outputChars += ruleOutputChars;
        } catch (error) {
            // Global work ceilings are not a per-rule fallback to more scanning.
            if (error.code === 'MEMORY_LIMIT') throw error;
            diagnostics.push({ ruleId: rule.id, code: typeof error.code === 'string' ? error.code : 'MEMORY_RULE_INVALID' });
        }
    }
    usage.results = candidates.length;
    return { version: 1, snapshot, budget, candidates, dependencies, diagnostics, truncated, usage,
        tokenEstimator: 'utf8-bytes-v1', coverage: candidates.map(candidate => ({ ...candidate.source, columnIds: [...candidate.source.columnIds] })) };
}

/** Equality of trusted invalidation counters only; never an authorization grant. */
export function isMemoryRulePlanCurrent(plan, currentSnapshot) {
    try {
        return plan?.version === 1 && JSON.stringify(snapshotOf(plan.snapshot)) === JSON.stringify(snapshotOf(currentSnapshot));
    } catch { return false; }
}
