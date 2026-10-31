import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticStorageAdapters } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { mapping, original, take, reject, rows } from './fixtures.mjs';
import { migrationFixture, migrationRequest, checkedMigration, targetMapping } from './migration-fixtures.mjs';

test('L4 persists copy intent, independent shadow checks, delta catch-up and atomic head switch receipts', async () => {
  const f = await migrationFixture(); const before = await f.snapshot(); const head = take(await f.runtime.head());
  const request = await migrationRequest(f); const copied = take(await f.runtime.migration.prepare(request));
  assert.notEqual(copied.shadowRef, request.shadowRef, 'L4_HOST_SHADOW');
  assert.equal(copied.switchedAtRevision, null); assert.equal(copied.pendingOperation, null); assert.ok(copied.checkRefs.length > 0);
  assert.deepEqual(take(await f.runtime.head()), head);
  assert.deepEqual(rows(await f.snapshot(), 'storage.originals'), rows(before, 'storage.originals'));
  await f.append('host.originals', 'message-2', original('message-2'));
  take(await f.runtime.store('message-2', mapping()));
  reject(await f.runtime.migration.switch({ migrationId: copied.migrationId, expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }), 'unavailable');
  const caught = take(await f.runtime.migration.catchUp(copied.migrationId, (await f.snapshot()).revision));
  assert.equal(caught.pendingOperation, null);
  const expectedRevision = (await f.snapshot()).revision;
  const switched = take(await f.runtime.migration.switch({ migrationId: copied.migrationId, expectedRevision, authorisationRef: 'grant-switch' }));
  assert.ok(switched.switchedAtRevision > expectedRevision, 'L4_PROGRESS_REVISION');
  const after = await f.snapshot(); assert.equal(switched.switchedAtRevision, after.revision);
  assert.equal(take(await f.runtime.head()).mappingId, 'M2');
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, mapping())).map(u => u.versions), [mapping().versions, mapping().versions]);
  assert.ok(rows(after, 'storage.operations').some(o => o.kind === 'receipt' && o.operation === 'switch'));
  assert.deepEqual(take(await f.runtime.migration.reconcile(copied.migrationId)), switched);
  await f.store.close();
});

test('L4 rejects fabricated future revisions, snapshot digests and claimant progress fields', async () => {
  const f = await migrationFixture();
  for (const change of [r => { r.baseRevision++; }, r => { r.snapshotDigest = digestJson('fabricated'); }, r => { r.pendingOperation = { executionId: 'fake', operation: 'switch', expectedRevision: r.baseRevision }; }, r => { r.checkRefs = ['fake']; }, r => { r.restoration = { verified: true, throughRevision: r.baseRevision, checkRefs: ['fake'] }; }]) {
    const request = await migrationRequest(f); change(request); reject(await f.runtime.migration.prepare(request));
  }
  const request = await migrationRequest(f); take(await f.runtime.migration.prepare(request));
  reject(await f.runtime.migration.catchUp(request.migrationId, (await f.snapshot()).revision + 100));
  assert.equal(rows(await f.snapshot(), 'storage.migrations').length, 1);
  await f.store.close();
});

test('L4 an ungranted, wrong-purpose, expired or revoked authorisation cannot switch a checked shadow', async () => {
  const f = await migrationFixture(); await checkedMigration(f); const head = take(await f.runtime.head());
  for (const authorisationRef of ['missing', 'grant-copy']) reject(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef }), 'unavailable');
  f.clock.value = '2026-10-30T00:00:00.000Z';
  reject(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), head);
  await f.store.close();
});

for (const failure of ['missing', 'misconnected', 'query']) test(`L4 shadow ${failure} failure preserves the current head and failure audit`, async () => {
  const base = syntheticStorageAdapters()[0];
  const broken = { ...base, id: 'broken', async decompose(...args) {
    const r = await base.decompose(...args);
    if (r.ok && failure === 'missing') r.value.splice(0);
    if (r.ok && failure === 'misconnected') r.value[0].representation.meaning.clauses[0].reference = 'wrong';
    return r;
  }, async retrieve(query, units, m) { if (failure === 'query') return { ok: true, value: [] }; return base.retrieve(query, units, m); } };
  const f = await migrationFixture({ adapters: [...syntheticStorageAdapters(), broken] });
  const bad = { ...targetMapping, mappingId: 'bad', versions: { ...targetMapping.versions, ruleVersionId: 'bad-rule' } }; await f.versions(bad, 'broken');
  const head = take(await f.runtime.head()); const request = { ...await migrationRequest(f), target: bad.versions };
  const copied = take(await f.runtime.migration.prepare(request));
  const snapshot = await f.snapshot();
  assert.equal(copied.switchedAtRevision, null); assert.ok(copied.checkRefs.length > 0);
  assert.ok(rows(snapshot, 'storage.inspections').filter(c => copied.checkRefs.includes(c.checkId)).some(c => [c.result.meaningPreservation, c.result.retrievalCorrectness, c.result.literalRestoration].includes('fail')));
  reject(await f.runtime.migration.switch({ migrationId: copied.migrationId, expectedRevision: snapshot.revision, authorisationRef: 'grant-switch' }), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), head);
  assert.ok(snapshot.events.some(e => e.kind === 'storage.copy.checked'));
  await f.store.close();
});

test('L4 concurrent same-revision switches have one winner and an explicit conflict', async () => {
  const f = await migrationFixture(); await checkedMigration(f);
  const expectedRevision = (await f.snapshot()).revision;
  const request = { migrationId: 'migration-1', expectedRevision, authorisationRef: 'grant-switch' };
  const results = await Promise.all([f.runtime.migration.switch(request), f.runtime.migration.switch(request)]);
  assert.equal(results.filter(r => r.ok).length, 1, 'L4_CAS_SINGLE_WINNER');
  reject(results.find(r => !r.ok), 'revision_conflict');
  assert.equal(take(await f.runtime.head()).mappingId, 'M2');
  await f.store.close();
});
