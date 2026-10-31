import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { take, reject, rows } from './fixtures.mjs';
import { migrationFixture, migrationRequest } from './migration-fixtures.mjs';
import { projectionPending } from './projection-pending-fixtures.mjs';
import { captureStore, deferred, assertTerminal } from './supersession-fixtures.mjs';

for (const operation of ['copy', 'catch_up']) for (const point of ['decompose', 'check']) for (const winner of ['replacement', 'old']) test(`F2 ${operation} delayed ${point} winner=${winner}`, { timeout: 30000 }, async t => {
  const f = await migrationFixture(); t.after(() => f.store.close());
  if (operation === 'catch_up') take(await f.runtime.migration.prepare(await migrationRequest(f)));
  const reached = deferred(), release = deferred(); let armed = true;
  const pause = async () => { if (armed) { armed = false; reached.resolve(); await release.promise; } };
  const slow = createStoragePlanner({ ...f.options,
    adapters: f.options.adapters.map(a => ({ ...a, async decompose(...args) { if (point === 'decompose') await pause(); return a.decompose(...args); } })),
    evaluator: { ...f.options.evaluator, async evaluateStorage(r) { if (point === 'check') await pause(); return f.options.evaluator.evaluateStorage(r); } } });
  const oldCall = operation === 'copy' ? slow.migration.prepare(await migrationRequest(f)) : slow.migration.catchUp('migration-1', (await f.snapshot()).revision);
  await reached.promise; const old = rows(await f.snapshot(), 'storage.migrations')[0];
  const batchReached = deferred(), batchRelease = deferred();
  const captured = captureStore(f, async b => { if (winner === 'old' && b.mutations.some(m => m.entry.value.kind === 'not_applied')) { batchReached.resolve(); await batchRelease.promise; } });
  const next = createStoragePlanner({ ...f.options, store: captured.store }).migration.catchUp('migration-1', (await f.snapshot()).revision);
  if (winner === 'old') {
    await batchReached.promise; release.resolve(); take(await oldCall); const settled = await f.snapshot();
    batchRelease.resolve(); reject(await next, 'revision_conflict'); assert.deepEqual(await f.snapshot(), settled);
    assert.equal(rows(settled, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === old.intent).length, 1);
    assert.equal(rows(settled, 'storage.operations').filter(r => r.kind === 'not_applied' && r.executionId === old.intent).length, 0);
  } else {
    take(await next); const settled = await f.snapshot(); release.resolve(); reject(await oldCall, 'revision_conflict');
    assert.deepEqual(await f.snapshot(), settled); assertTerminal(settled, old, rows(settled, 'storage.migrations')[0].intent);
    for (const c of ['storage.derived', 'storage.manifests']) assert.equal(rows(settled, c).filter(r => r.generation === old.generation).length, 0);
  }
});

for (const operation of ['copy', 'catch_up']) test(`F2 ${operation} concurrent replacements have one winner without retry`, { timeout: 30000 }, async t => {
  const f = await projectionPending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
  const reached = deferred(), release = deferred(); let count = 0, settled = 0;
  const captured = captureStore(f, async b => { if (b.mutations.some(m => m.entry.value.kind === 'not_applied')) { if (++count === 2) reached.resolve(); await release.promise; } });
  const runtime = createStoragePlanner({ ...f.options, store: captured.store });
  const calls = [0, 1].map(() => runtime.migration.catchUp('migration-1', before.revision).then(r => { settled++; return r; }));
  await reached.promise; assert.equal(settled, 0); release.resolve(); const results = await Promise.all(calls);
  assert.equal(results.filter(r => r.ok).length, 1); reject(results.find(r => !r.ok), 'revision_conflict');
  const after = await f.snapshot(); assertTerminal(after, f.pendingState, rows(after, 'storage.migrations')[0].intent);
});
