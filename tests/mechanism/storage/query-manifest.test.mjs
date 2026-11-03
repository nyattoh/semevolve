import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { take, reject, clausePayload, graphPayload } from './fixtures.mjs';
import { migrationFixture, checkedMigration, targetMapping } from './migration-fixtures.mjs';

test('dropping one sealed query check cannot confirm a generation', async t => {
  const queries = [{ all: true }, { all: true }];
  const f = await migrationFixture({ plan: { queries, expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': clausePayload, 'graph-1': graphPayload } } } });
  t.after(() => f.store.close());
  await checkedMigration(f);
  assert.ok(take(await f.runtime.retrieve({ all: true }, targetMapping)).length > 0);
  const snapshot = await f.snapshot();
  const targetDigest = digestJson(targetMapping);
  const store = { ...f.store, async snapshot() {
    const copy = structuredClone(snapshot);
    for (const entry of copy.entries) {
      if (entry.key.collection !== 'storage.manifests' || entry.value.mappingDigest !== targetDigest || !Array.isArray(entry.value.checkIds) || entry.value.checkIds.length < 2) continue;
      entry.value.checkIds = [entry.value.checkIds[0]];
    }
    return { ok: true, value: copy };
  } };
  const runtime = createStoragePlanner({ ...f.options, store });
  reject(await runtime.retrieve({ all: true }, targetMapping), 'unavailable');
  assert.deepEqual(await f.snapshot(), snapshot);
});
