import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { mapping, take, reject, rows, original } from './fixtures.mjs';
import { migrationFixture, migrationRequest, checkedMigration, targetMapping } from './migration-fixtures.mjs';
import { generations, assertLatest } from './generation-fixtures.mjs';

for (const oldLast of [true, false]) test(`B1 nonlive retrieval follows confirmed revision with oldLast=${oldLast}`, async t => {
  const f = await migrationFixture();
  t.after(() => f.store.close());
  const evidence = await generations(f, oldLast);
  t.diagnostic(JSON.stringify(evidence));
  assertLatest(await f.runtime.retrieve({ all: true }, targetMapping));
});

test('B1 live head wins over a newer shadow and ordinary retired store remains readable', async t => {
  const f = await migrationFixture(); t.after(() => f.store.close());
  const oldHead = take(await f.runtime.head());
  await checkedMigration(f);
  const before = await f.snapshot();
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, mapping())).map(u => u.source.messageId), ['message-1']);
  assert.deepEqual(await f.snapshot(), before);
  take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: before.revision, authorisationRef: 'grant-switch' }));
  assert.notEqual(take(await f.runtime.head()).generation, oldHead.generation);
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, mapping())).map(u => u.source.messageId), ['message-1']);
});

test('B1 a restored generation and the retired target both retain new writes', async t => {
  const f = await migrationFixture(); t.after(() => f.store.close());
  await checkedMigration(f);
  take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  await f.append('host.originals', 'message-2', original('message-2'));
  take(await f.runtime.store('message-2', targetMapping));
  take(await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' }));
  assertLatest(await f.runtime.retrieve({ all: true }, targetMapping));
  const restored = take(await f.runtime.retrieve({ all: true }, mapping()));
  take(await f.runtime.migration.prepare(await migrationRequest(f, 'migration-2')));
  take(await f.runtime.migration.catchUp('migration-2', (await f.snapshot()).revision));
  take(await f.runtime.migration.switch({ migrationId: 'migration-2', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, mapping())), restored);
});

test('B1 failed and pending projections never replace the latest successful generation', async t => {
  const f = await migrationFixture(); t.after(() => f.store.close());
  await generations(f);
  const evaluator = f.options.evaluator.evaluateStorage;
  f.options.evaluator.evaluateStorage = async request => {
    const result = await evaluator(request);
    return { ok: true, value: { ...result.value, meaningPreservation: 'fail' } };
  };
  take(await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision));
  assertLatest(await f.runtime.retrieve({ all: true }, targetMapping));
  const saved = rows(await f.snapshot(), 'storage.derived').find(r => r.mappingId === 'M2');
  await f.append('storage.derived', 'unconfirmed-projection', { ...saved, generation: 'pending-only' });
  assertLatest(await f.runtime.retrieve({ all: true }, targetMapping));
});

for (const defect of ['receipt-missing', 'manifest-missing', 'dataset', 'check-task', 'criteria', 'evaluator', 'scope', 'source-head', 'ambiguity']) {
  test(`B1 ${defect} cannot silently select an older generation`, async t => {
    const f = await migrationFixture(); t.after(() => f.store.close());
    const { next } = await generations(f);
    const snapshot = await f.snapshot();
    const receipt = rows(snapshot, 'storage.operations').find(r => r.kind === 'receipt' && r.generation === next);
    const manifest = rows(snapshot, 'storage.manifests').find(m => m.generation === next);
    const store = { ...f.store, async snapshot() {
      const s = structuredClone(snapshot);
      if (defect === 'receipt-missing') s.entries = s.entries.filter(e => e.key.id !== `${receipt.executionId}/receipt`);
      if (defect === 'manifest-missing') s.entries = s.entries.filter(e => !(e.key.collection === 'storage.manifests' && e.key.id === next));
      const proof = s.entries.find(e => e.key.id === manifest.checkIds[0]).value;
      if (defect === 'dataset') s.entries.find(e => e.key.id === `${receipt.executionId}/receipt`).value.datasetDigest = digestJson('wrong-dataset');
      if (defect === 'check-task') proof.request.taskId = 'other-task';
      if (defect === 'criteria') proof.request.criteriaDigest = digestJson('other-criteria');
      if (defect === 'evaluator') proof.request.evaluatorVersion = 'other-evaluator';
      if (defect === 'scope') proof.request.scope = 'other-scope';
      if (defect === 'source-head') s.entries.find(e => e.key.id === `${receipt.executionId}/intent`).value.sourceHeadDigest = digestJson('other-head');
      if (defect === 'ambiguity') {
        const older = s.entries.find(e => e.key.collection === 'storage.operations' && e.value.kind === 'receipt' && e.value.operation === 'copy');
        older.value.revision = receipt.revision;
      }
      return { ok: true, value: s };
    } };
    const runtime = createStoragePlanner({ ...f.options, store });
    reject(await runtime.retrieve({ all: true }, targetMapping), 'unavailable');
    assert.deepEqual(await f.snapshot(), snapshot);
  });
}
