import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { original, mapping, take, rows } from './fixtures.mjs';
import { migrationFixture, checkedMigration, targetMapping } from './migration-fixtures.mjs';

test('L-F1 complete shadow switches and restores despite reversed storage-key order without changing semantic arrays', async t => {
  const f = await migrationFixture();
  t.after(() => f.store.close());
  await f.append('host.originals', 'message-2', original('message-2'));
  take(await f.runtime.store('message-2', mapping()));
  const realNewId = f.options.identity.newId;
  let generation = 0;
  f.options.identity.newId = kind => {
    if (kind !== 'storage-generation') return realNewId(kind);
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = `synthetic-order-generation-${generation++}`;
      if (digestJson([id, 'message-1', targetMapping]) > digestJson([id, 'message-2', targetMapping])) return id;
    }
    assert.fail('Fixture must find a reversed storage-key order');
  };
  await checkedMigration(f);
  const before = await f.snapshot();
  const state = rows(before, 'storage.migrations')[0];
  const units = rows(before, 'storage.derived').filter(r => r.generation === state.generation).flatMap(r => r.units);
  assert.deepEqual(state.dataset.originals.map(o => o.message.envelope.message_id), ['message-1', 'message-2']);
  assert.deepEqual(units.map(u => u.source.messageId), ['message-2', 'message-1']);
  const expected = new Map(units.map(u => [u.source.messageId, structuredClone(u)]));
  const switched = take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: before.revision, authorisationRef: 'grant-switch' }));
  assert.ok(switched.switchedAtRevision > before.revision);
  assert.equal(take(await f.runtime.head()).mappingId, 'M2');
  for (const unit of take(await f.runtime.retrieve({ all: true }, targetMapping))) assert.deepEqual(unit, expected.get(unit.source.messageId));
  const after = await f.snapshot();
  assert.deepEqual(rows(after, 'storage.derived').filter(r => r.generation === state.generation).flatMap(r => r.units), units);
  take(await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: after.revision, authorisationRef: 'grant-restore' }));
  assert.equal(take(await f.runtime.head()).mappingId, 'M1');
  const restored = take(await f.runtime.retrieve({ all: true }, mapping()));
  assert.deepEqual(restored.map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
  for (const unit of restored) assert.deepEqual(unit.representation, expected.get(unit.source.messageId).representation);
});
