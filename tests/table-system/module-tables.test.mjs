import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ensureRegisteredTable,
    mutateOwnedRecord,
    queryTableRecords,
    registerTableDefinition,
} from '../../core/table-system/module-tables.js';

const OWNER = 'TableSystemTest';

test('module tables enforce keys, references, owner writes, and deterministic queries', () => {
    registerTableDefinition(OWNER, {
        id: 'test.people',
        owner: OWNER,
        name: 'People',
        columns: [
            { id: 'id', label: 'ID', type: 'string', primaryKey: true },
            { id: 'name', label: 'Name', type: 'string', required: true },
            { id: 'score', label: 'Score', type: 'number' },
        ],
    });
    registerTableDefinition(OWNER, {
        id: 'test.items',
        owner: OWNER,
        name: 'Items',
        columns: [
            { id: 'id', label: 'ID', type: 'string', primaryKey: true },
            {
                id: 'ownerId',
                label: 'Owner',
                type: 'reference',
                required: true,
                references: { tableId: 'test.people', columnId: 'id', onDelete: 'restrict' },
            },
            { id: 'name', label: 'Name', type: 'string' },
        ],
    });

    let state = ensureRegisteredTable(OWNER, 'test.people', []).state;
    state = ensureRegisteredTable(OWNER, 'test.items', state).state;
    state = mutateOwnedRecord(OWNER, {
        tableId: 'test.people', action: 'insert', values: { id: 'alice', name: 'Alice', score: 20 },
    }, state).state;
    state = mutateOwnedRecord(OWNER, {
        tableId: 'test.people', action: 'insert', values: { id: 'bob', name: 'Bob', score: 10 },
    }, state).state;
    state = mutateOwnedRecord(OWNER, {
        tableId: 'test.items', action: 'insert', values: { id: 'sword', ownerId: 'alice', name: 'Sword' },
    }, state).state;

    assert.throws(() => mutateOwnedRecord(OWNER, {
        tableId: 'test.items', action: 'insert', values: { id: 'broken', ownerId: 'missing' },
    }, state), { code: 'FOREIGN_KEY_VIOLATION' });
    assert.throws(() => mutateOwnedRecord(OWNER, {
        tableId: 'test.people', action: 'insert', values: { id: 'alice', name: 'Again' },
    }, state), { code: 'UNIQUE_CONSTRAINT_VIOLATION' });
    assert.throws(() => mutateOwnedRecord('OtherModule', {
        tableId: 'test.people', action: 'insert', values: { id: 'eve', name: 'Eve' },
    }, state), { code: 'TABLE_ACCESS_DENIED' });

    const aliceId = state.find(table => table.id === 'test.people').rowMeta[0].id;
    assert.throws(() => mutateOwnedRecord(OWNER, {
        tableId: 'test.people', action: 'delete', recordId: aliceId,
    }, state), { code: 'REFERENCE_RESTRICTED' });

    const result = queryTableRecords('test.people', {
        filters: [{ columnId: 'score', op: 'gte', value: 10 }],
        sort: [{ columnId: 'score', direction: 'desc' }],
        select: ['name', 'score'],
    }, state);
    assert.deepEqual(result.records.map(record => record.values), [
        { name: 'Alice', score: '20' },
        { name: 'Bob', score: '10' },
    ]);
});

test('setNull clears non-required references before deleting a target record', () => {
    registerTableDefinition(OWNER, {
        id: 'test.null-target',
        owner: OWNER,
        name: 'Null target',
        columns: [{ id: 'id', label: 'ID', type: 'string', primaryKey: true }],
    });
    registerTableDefinition(OWNER, {
        id: 'test.null-source',
        owner: OWNER,
        name: 'Null source',
        columns: [
            { id: 'id', label: 'ID', type: 'string', primaryKey: true },
            {
                id: 'targetId',
                label: 'Target',
                type: 'reference',
                references: { tableId: 'test.null-target', columnId: 'id', onDelete: 'setNull' },
            },
        ],
    });

    let state = ensureRegisteredTable(OWNER, 'test.null-target', []).state;
    state = ensureRegisteredTable(OWNER, 'test.null-source', state).state;
    const target = mutateOwnedRecord(OWNER, {
        tableId: 'test.null-target', action: 'insert', values: { id: 'target-1' },
    }, state);
    state = target.state;
    state = mutateOwnedRecord(OWNER, {
        tableId: 'test.null-source', action: 'insert', values: { id: 'source-1', targetId: 'target-1' },
    }, state).state;

    state = mutateOwnedRecord(OWNER, {
        tableId: 'test.null-target', action: 'delete', recordId: target.result.recordId,
    }, state).state;
    const source = queryTableRecords('test.null-source', {}, state);
    assert.equal(source.records[0].values.targetId, '');
});
