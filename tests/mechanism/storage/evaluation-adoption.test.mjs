import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { take, rows, mapping } from './fixtures.mjs';
import { certifiedRecording } from './recording-evaluation-fixtures.mjs';
import { checkedMigration, targetMapping } from './migration-fixtures.mjs';

for (const change of ['queries', 'conditions']) test(`L-rem current conformance cannot be reused for changed ${change}`, async t => {
  const f = await certifiedRecording(); t.after(() => f.store.close());
  const comparison = { ...f.options.comparison };
  if (change === 'queries') comparison.queries = [{ all: true, condition: 'new' }];
  else comparison.expectedConditions = { ...comparison.expectedConditions, condition: 'new' };
  const runtime = createStoragePlanner({ ...f.options, comparison }); const before = await f.snapshot();
  assert.equal((await runtime.retrieve({ all: true }, mapping())).ok, false, 'L_REM_CURRENT_CONFORMANCE_INPUTS');
  assert.deepEqual(await f.snapshot(), before);
});

test('L-rem live projection uses its own current inspection eligibility', async t => {
  const f = await certifiedRecording(); t.after(() => f.store.close()); await checkedMigration(f);
  take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  const before = await f.snapshot(); const head = take(await f.runtime.head());
  const manifest = before.entries.find(e => e.key.collection === 'storage.manifests' && e.key.id === head.generation).value;
  const inspection = rows(before, 'storage.inspections').find(c => c.checkId === manifest.checkIds[0]);
  await f.withdraw(inspection.request.executionId);
  assert.equal((await f.runtime.retrieve({ all: true }, targetMapping)).ok, false, 'L_REM_LIVE_GENERATION_CURRENT_ELIGIBILITY');
  assert.deepEqual(rows(await f.snapshot(), 'storage.inspections'), rows(before, 'storage.inspections'));
});
