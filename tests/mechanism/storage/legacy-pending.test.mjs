import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { mapping, original, take, reject, rows } from './fixtures.mjs';
import { targetMapping } from './migration-fixtures.mjs';
import { request } from './pending-fixtures.mjs';
import { legacyPending } from './legacy-pending-fixtures.mjs';

for (const operation of ['switch', 'restore']) {
  test(`B2 legacy ${operation} explicitly resumes its verified existing intent`, async t => {
    const f = await legacyPending(operation); t.after(() => f.store.close());
    const before = await f.snapshot();
    const intent = before.entries.find(e => e.key.id === `${f.pendingState.intent}/intent`).value;
    assert.equal(Object.hasOwn(intent, 'inspectionDigest'), false);
    const event = before.events.find(e => e.kind === `storage.${operation}.intent` && e.data.intent === f.pendingState.intent);
    assert.equal(Object.hasOwn(event.data, 'stateDigest'), false);
    assert.deepEqual(take(await f.runtime.migration.reconcile('migration-1')), f.pendingState.migration);
    assert.deepEqual(await f.snapshot(), before);
    const result = await f.runtime.migration[operation](request(f, operation, before.revision));
    assert.equal(result.ok, true, `B2_LEGACY_${operation.toUpperCase()} ${JSON.stringify(result)}`);
    const after = await f.snapshot();
    assert.equal(rows(after, 'storage.migrations')[0].intent, f.pendingState.intent);
    assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === f.pendingState.intent).length, 1);
    assert.deepEqual(after.entries.find(e => e.key.id === `${f.pendingState.intent}/intent`).value, intent);
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    for (const c of ['host.tasks', 'storage.originals']) assert.deepEqual(rows(after, c), rows(before, c));
    assert.deepEqual(take(await f.runtime.retrieve({ all: true }, operation === 'switch' ? targetMapping : mapping())).map(u => u.source.messageId).sort(), operation === 'switch' ? ['message-1'] : ['message-1', 'message-2']);
  });

  for (const damage of ['event missing', 'event task', 'partial new evidence', 'source head', 'target mapping', 'input digest', 'manifest missing', 'manifest checks', 'receipt missing', 'generation']) {
    test(`B2 legacy ${operation} keeps ${damage} unknown without mutation`, async t => {
      const f = await legacyPending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
      const store = { close: () => f.store.close(), transact: b => f.store.transact(b), async snapshot() {
        const s = structuredClone(before); const state = rows(s, 'storage.migrations')[0];
        const intent = s.entries.find(e => e.key.id === `${state.intent}/intent`).value;
        const event = s.events.find(e => e.kind === `storage.${operation}.intent` && e.data.intent === state.intent);
        if (damage === 'event missing') s.events = s.events.filter(e => e !== event);
        if (damage === 'event task') event.taskId = 'other-task';
        if (damage === 'partial new evidence') event.data.intentDigest = digestJson(intent);
        if (damage === 'source head') state.sourceHead.generation = 'unknown';
        if (damage === 'target mapping') state.targetMapping.retrievalSpecification = 'different';
        if (damage === 'input digest') intent.inputDigest = digestJson('wrong');
        if (damage === 'manifest missing') s.entries = s.entries.filter(e => e.key.collection !== 'storage.manifests');
        if (damage === 'manifest checks') for (const m of rows(s, 'storage.manifests')) m.checkIds = [];
        if (damage === 'receipt missing') s.entries = s.entries.filter(e => e.value.kind !== 'receipt');
        if (damage === 'generation') state.generation = state.sourceHead.generation;
        const { digest, ...body } = s; s.digest = digestJson(body);
        return { ok: true, value: s };
      } };
      const runtime = createStoragePlanner({ ...f.options, store });
      reject(await runtime.migration[operation](request(f, operation, before.revision)), 'unavailable');
      assert.deepEqual(await f.snapshot(), before); assert.deepEqual(take(await f.runtime.head()), f.head);
    });
  }
}

test('B2 legacy switch delta requires atomic supersession and new checks', async t => {
  const f = await legacyPending('switch'); t.after(() => f.store.close());
  await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', mapping()));
  reject(await f.runtime.migration.switch(request(f, 'switch', (await f.snapshot()).revision)), 'unavailable');
  const result = await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision);
  assert.equal(result.ok, true, `B2_LEGACY_DELTA ${JSON.stringify(result)}`);
  const s = await f.snapshot(); const state = rows(s, 'storage.migrations')[0];
  const terminal = rows(s, 'storage.operations').find(r => r.kind === 'not_applied');
  assert.equal(terminal.executionId, f.pendingState.intent); assert.equal(terminal.successor, state.intent);
  assert.equal(Object.hasOwn(terminal, 'pass'), false);
  take(await f.runtime.migration.switch(request(f, 'switch', s.revision)));
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
});

test('B2 legacy restore with changed criteria records a new attempt and retains its old intent', async t => {
  const f = await legacyPending('restore'); t.after(() => f.store.close()); const before = await f.snapshot();
  const runtime = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, criteriaDigest: digestJson('next-criteria') } });
  const result = await runtime.migration.restore(request(f, 'restore', before.revision));
  assert.equal(result.ok, true, `B2_LEGACY_RESTORE_CRITERIA ${JSON.stringify(result)}`);
  const after = await f.snapshot(); const state = rows(after, 'storage.migrations')[0];
  const terminal = rows(after, 'storage.operations').find(r => r.kind === 'not_applied');
  assert.equal(terminal.executionId, f.pendingState.intent); assert.equal(terminal.successor, state.intent);
  assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === f.pendingState.intent).length, 0);
  for (const e of before.entries.filter(e => e.key.collection === 'storage.operations')) assert.deepEqual(after.entries.find(a => a.key.collection === e.key.collection && a.key.id === e.key.id), e);
});
