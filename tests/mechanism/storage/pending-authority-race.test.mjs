import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { pending, request } from './pending-fixtures.mjs';
import { legacyPending } from './legacy-pending-fixtures.mjs';
import { rows, take, reject, original, mapping } from './fixtures.mjs';
import { targetMapping } from './migration-fixtures.mjs';
import { authorised, switchRequest, preserve, assertTerminal, deferred, captureStore, corrupt } from './supersession-fixtures.mjs';

test('F1 concurrent authority replacements overlap at CAS with one winner', { timeout: 30000 }, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const before = await f.snapshot(); const { options, ref } = await authorised(f);
  const reached = deferred(), release = deferred(); let admitted = 0;
  const captured = captureStore(f, async b => { if (b.mutations.some(m => m.entry.value.kind === 'not_applied')) { if (++admitted === 2) reached.resolve(); await release.promise; } });
  const runtime = createStoragePlanner({ ...options, store: captured.store }); let settled = 0;
  const calls = [0, 1].map(() => runtime.migration.switch(switchRequest(before.revision, ref)).then(r => { settled++; return r; }));
  await reached.promise; assert.equal(settled, 0); release.resolve(); const results = await Promise.all(calls);
  assert.equal(results.filter(r => r.ok).length, 1); reject(results.find(r => !r.ok), 'revision_conflict');
  const after = await f.snapshot(); assertTerminal(after, f.pendingState, rows(after, 'storage.migrations')[0].intent);
});

test('F1 late old authorisation cannot overwrite renewed authority', { timeout: 30000 }, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const reached = deferred(), release = deferred();
  const slow = createStoragePlanner({ ...f.options, policy: { async authorise(input) { const result = await f.options.policy.authorise(input); reached.resolve(); await release.promise; return result; } } });
  const old = slow.migration.switch(request(f, 'switch', (await f.snapshot()).revision)); await reached.promise;
  const { runtime, ref } = await authorised(f); take(await runtime.migration.switch(switchRequest((await f.snapshot()).revision, ref)));
  const winner = await f.snapshot(); release.resolve(); reject(await old, 'revision_conflict'); assert.deepEqual(await f.snapshot(), winner);
});

for (const loss of ['refused', 'lost']) test(`F1 replacement ${loss} preserves atomic outcome`, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const before = await f.snapshot(); const { options, ref } = await authorised(f);
  const store = { snapshot: () => f.store.snapshot(), close: () => f.store.close(), async transact(batch) {
    if (!batch.mutations.some(m => m.entry.value.kind === 'not_applied')) return f.store.transact(batch);
    if (loss === 'refused') return { ok: false, error: { code: 'unavailable', reason: 'Synthetic admission refusal' } };
    take(await f.store.transact(batch)); throw new Error('Synthetic lost response');
  } };
  reject(await createStoragePlanner({ ...options, store }).migration.switch(switchRequest(before.revision, ref)), 'unavailable');
  if (loss === 'refused') assert.deepEqual(await f.snapshot(), before);
  else { const after = await f.snapshot(); const state = rows(after, 'storage.migrations')[0]; assertTerminal(after, f.pendingState, state.intent);
    assert.deepEqual(take(await f.runtime.migration.reconcile('migration-1')), state.migration); assert.deepEqual(await f.snapshot(), after);
    take(await createStoragePlanner(options).migration.switch(switchRequest(after.revision, ref))); }
});
