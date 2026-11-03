import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticStorageAdapters } from '@semevolve/storage-planner';
import { original, mapping, clausePayload, take, reject, rows } from './fixtures.mjs';
import { migrationFixture, checkedMigration, targetMapping } from './migration-fixtures.mjs';

export async function switched(f) {
  await checkedMigration(f);
  return take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
}
test('L5 restores the latest originals, corrections and relationships into a fresh old-format generation', async () => {
  const correction = { ...clausePayload, clauses: [...clausePayload.clauses, { id: 'new-relation', from: 'B', to: 'C', correctionOf: 'message-1', uncertainty: 'unknown' }] };
  const f = await migrationFixture({ plan: { expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': correction } } } });
  const oldHead = take(await f.runtime.head()); await switched(f);
  const switchedHead = take(await f.runtime.head());
  await f.append('host.originals', 'message-2', original('message-2', correction));
  take(await f.runtime.store('message-2', targetMapping));
  const result = take(await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' }));
  assert.equal(result.restoration.verified, true, 'L5_RESTORE_VERIFIED');
  const head = take(await f.runtime.head()); assert.equal(head.mappingId, 'M1');
  assert.notEqual(head.generation, oldHead.generation); assert.notEqual(head.generation, switchedHead.generation);
  const units = take(await f.runtime.retrieve({ all: true }, mapping()));
  assert.deepEqual(units.map(u => u.source.messageId).sort(), ['message-1', 'message-2'], 'L5_NEW_WRITE_RETAINED');
  assert.deepEqual(units.find(u => u.source.messageId === 'message-2').representation.meaning.clauses.at(-1), correction.clauses.at(-1));
  assert.ok(rows(await f.snapshot(), 'storage.derived').some(r => r.generation === switchedHead.generation));
  assert.ok(rows(await f.snapshot(), 'storage.derived').some(r => r.generation === oldHead.generation));
  assert.deepEqual(take(await f.runtime.migration.reconcile('migration-1')), result);
  await f.store.close();
});

test('L5 refuses to call restoration verified when the old adapter cannot retain new information', async () => {
  const adapters = syntheticStorageAdapters(); const base = adapters[0];
  const limited = { ...base, async decompose(o, ...args) { if (JSON.parse(o.message.envelope.payload).unrepresentable) return { ok: false, error: { code: 'unavailable', reason: 'Old format cannot retain the new relation' } }; return base.decompose(o, ...args); } };
  const capable = { ...base, id: 'capable' };
  const newPayload = { ...clausePayload, unrepresentable: true };
  const f = await migrationFixture({ adapters: [limited, capable, adapters[1]], targetAdapterId: 'capable', plan: { expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': newPayload } } } });
  await switched(f); const before = take(await f.runtime.head());
  await f.append('host.originals', 'message-2', original('message-2', newPayload));
  take(await f.runtime.store('message-2', targetMapping));
  reject(await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' }), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), before);
  const state = rows(await f.snapshot(), 'storage.migrations')[0];
  assert.equal(state.migration.restoration.verified, false);
  assert.match(state.migration.restoration.reason, /cannot retain/);
  assert.ok(rows(await f.snapshot(), 'storage.derived').some(r => r.generation === before.generation));
  assert.ok(rows(await f.snapshot(), 'storage.originals').some(o => o.message.envelope.message_id === 'message-2'));
  await f.store.close();
});
