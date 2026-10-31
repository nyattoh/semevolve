import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { mapping, original, take, reject, rows } from './fixtures.mjs';
import { targetMapping } from './migration-fixtures.mjs';
import { pending, request } from './pending-fixtures.mjs';

function changedSnapshot(f, change) {
  return { ...f.options, store: { close: () => f.store.close(), transact: b => f.store.transact(b), async snapshot() {
    const s = structuredClone(await f.snapshot());
    change(s);
    const { digest, ...body } = s;
    s.digest = digestJson(body);
    return { ok: true, value: s };
  } } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function unchanged(f, before) {
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(take(await f.runtime.head()), f.head);
}
function preserved(before, after) {
  for (const collection of ['host.tasks', 'host.originals', 'storage.originals', 'storage.operations', 'storage.inspections']) {
    for (const entry of before.entries.filter(e => e.key.collection === collection)) {
      assert.deepEqual(after.entries.find(e => e.key.collection === collection && e.key.id === entry.key.id), entry);
    }
  }
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
}

const shadowChanges = {
  'check task': s => { for (const c of rows(s, 'storage.inspections')) c.request.taskId = 'other-task'; },
  'check result identity': s => { for (const c of rows(s, 'storage.inspections')) c.result.inputDigest = digestJson('wrong'); },
  'check original set': s => { for (const c of rows(s, 'storage.inspections')) c.originalSetDigest = digestJson([]); },
  'manifest generation': s => { for (const m of rows(s, 'storage.manifests')) m.generation = 'other-generation'; },
  'manifest through revision': s => { for (const m of rows(s, 'storage.manifests')) m.throughRevision = s.revision + 1; },
  'check expected conditions': s => { for (const c of rows(s, 'storage.inspections')) c.request.expectedConditions = {}; },
};
for (const [name, change] of Object.entries(shadowChanges)) test(`B2 switch rejects ${name} without clearing pending`, async t => {
  const f = await pending('switch'); t.after(() => f.store.close());
  const before = await f.snapshot();
  const runtime = createStoragePlanner(changedSnapshot(f, change));
  reject(await runtime.migration.switch(request(f, 'switch', before.revision)), 'unavailable');
  await unchanged(f, before);
});

for (const operation of ['switch', 'restore']) {
  for (const failure of ['missing head', 'different generation', 'different revision', 'intent identity', 'intent snapshot', 'receipt exists']) test(`B2 ${operation} preserves unknown ${failure}`, async t => {
    const f = await pending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
    const runtime = createStoragePlanner(changedSnapshot(f, s => {
      const state = rows(s, 'storage.migrations')[0];
      const intent = s.entries.find(e => e.key.id === `${state.intent}/intent`).value;
      if (failure === 'missing head') s.entries = s.entries.filter(e => e.key.collection !== 'storage.heads');
      if (failure === 'different generation') rows(s, 'storage.heads')[0].generation = 'other-generation';
      if (failure === 'different revision') rows(s, 'storage.heads')[0].revision += 1;
      if (failure === 'intent identity') intent.executionId = 'other-execution';
      if (failure === 'intent snapshot') intent.snapshotDigest = digestJson('wrong-snapshot');
      if (failure === 'receipt exists') s.entries.push({ key: { collection: 'storage.operations', id: `${state.intent}/receipt` }, value: { kind: 'receipt', executionId: state.intent } });
    }));
    reject(await runtime.migration[operation](request(f, operation, before.revision)), 'unavailable');
    await unchanged(f, before);
  });
  for (const failure of ['deadline', 'cancel', 'stop', 'grant missing', 'grant expired', 'grant revoked', 'grant purpose', 'policy revision']) test(`B2 ${operation} refuses ${failure} on explicit resume`, async t => {
    const f = await pending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
    const references = { ...f.options.references,
      async readTask(s, id) { const result = await f.options.references.readTask(s, id); const task = structuredClone(result.value);
        if (failure === 'deadline') task.deadline = f.clock.value;
        if (failure === 'cancel') task.cancellationRequestedAt = f.clock.value;
        if (failure === 'stop') task.stopReason = 'synthetic-stop';
        return { ok: true, value: task };
      },
      async readGrant(s, ref) { const result = await f.options.references.readGrant(s, ref); const grant = structuredClone(result.value);
        if (failure === 'grant missing') return { ok: true, value: null };
        if (failure === 'grant expired') grant.expiresAt = f.clock.value;
        if (failure === 'grant revoked') grant.revokedAt = f.clock.value;
        if (failure === 'grant purpose') grant.name = 'storage.copy';
        if (failure === 'policy revision') grant.policyRevision += 1;
        return { ok: true, value: grant };
      } };
    const runtime = createStoragePlanner({ ...f.options, references });
    reject(await runtime.migration[operation](request(f, operation, before.revision)), 'unavailable');
    await unchanged(f, before);
  });

  test(`B2 ${operation} keeps CAS loser as conflict with overlapping resumes`, async t => {
    const f = await pending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
    const reached = deferred(), release = deferred(); let calls = 0;
    const runtime = createStoragePlanner({ ...f.options, policy: { async authorise(input) {
      const decision = await f.options.policy.authorise(input);
      if (++calls <= 2) { if (calls === 2) reached.resolve(); await release.promise; }
      return decision;
    } } });
    const a = runtime.migration[operation](request(f, operation, before.revision));
    const b = runtime.migration[operation](request(f, operation, before.revision));
    await reached.promise; release.resolve();
    const results = await Promise.all([a, b]);
    assert.equal(results.filter(r => r.ok).length, 1);
    reject(results.find(r => !r.ok), 'revision_conflict');
    const after = await f.snapshot(); preserved(before, after);
    assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === f.pendingState.intent).length, 1);
  });

  test(`B2 ${operation} final CAS failure retains intent and requires a separate request`, async t => {
    const f = await pending(operation); t.after(() => f.store.close()); let armed = true;
    const runtime = createStoragePlanner({ ...f.options, store: { snapshot: () => f.store.snapshot(), close: () => f.store.close(), async transact(batch) {
      if (armed && batch.events.some(e => e.kind === `storage.${operation}.committed`)) { armed = false; await f.append('synthetic.audit', 'competing-write', { value: 1 }); }
      return f.store.transact(batch);
    } } });
    reject(await runtime.migration[operation](request(f, operation, (await f.snapshot()).revision)), 'revision_conflict');
    const before = await f.snapshot();
    assert.equal(rows(before, 'storage.migrations')[0].phase, `${operation}_pending`);
    assert.deepEqual(take(await f.runtime.head()), f.head);
    take(await f.runtime.migration[operation](request(f, operation, before.revision)));
    preserved(before, await f.snapshot());
  });

  test(`B2 ${operation} reconciles committed response loss without a second application`, async t => {
    const f = await pending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
    const runtime = createStoragePlanner({ ...f.options, store: { snapshot: () => f.store.snapshot(), close: () => f.store.close(), async transact(batch) {
      const result = await f.store.transact(batch);
      if (result.ok && batch.events.some(e => e.kind === `storage.${operation}.committed`)) throw new Error('Synthetic committed response loss');
      return result;
    } } });
    reject(await runtime.migration[operation](request(f, operation, before.revision)), 'unavailable');
    const after = await f.snapshot(); preserved(before, after);
    const done = take(await f.runtime.migration.reconcile('migration-1'));
    assert.equal(done.pendingOperation, null);
    assert.deepEqual(await f.snapshot(), after);
    assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === f.pendingState.intent).length, 1);
  });
}

test('B2 switch delta is atomically superseded by explicit catch-up', async t => {
  const f = await pending('switch'); t.after(() => f.store.close());
  const before = await f.snapshot();
  await f.append('host.originals', 'message-2', original('message-2'));
  take(await f.runtime.store('message-2', mapping()));
  reject(await f.runtime.migration.switch(request(f, 'switch', (await f.snapshot()).revision)), 'unavailable');
  take(await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision));
  const caught = await f.snapshot(); const state = rows(caught, 'storage.migrations')[0];
  const terminal = rows(caught, 'storage.operations').find(r => r.kind === 'not_applied');
  assert.equal(terminal.executionId, f.pendingState.intent);
  assert.equal(terminal.successor, state.intent); assert.equal(Object.hasOwn(terminal, 'pass'), false);
  assert.equal(rows(caught, 'storage.operations').some(r => r.kind === 'receipt' && r.executionId === f.pendingState.intent), false);
  take(await f.runtime.migration.switch(request(f, 'switch', caught.revision)));
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
  preserved(before, await f.snapshot());
});

test('B2 delayed restore cannot overwrite a superseding restore intent', async t => {
  const f = await pending('restore'); t.after(() => f.store.close());
  const reached = deferred(), release = deferred(); let armed = true;
  const slow = createStoragePlanner({ ...f.options, evaluator: { ...f.options.evaluator, async evaluateStorage(r) {
    if (armed) { armed = false; reached.resolve(); await release.promise; }
    return f.options.evaluator.evaluateStorage(r);
  } } });
  const old = slow.migration.restore(request(f, 'restore', (await f.snapshot()).revision));
  await reached.promise;
  const changed = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, criteriaDigest: digestJson('next-criteria') } });
  take(await changed.migration.restore(request(f, 'restore', (await f.snapshot()).revision)));
  const winner = await f.snapshot(); release.resolve(); reject(await old, 'revision_conflict');
  assert.deepEqual(await f.snapshot(), winner);
  const terminal = rows(winner, 'storage.operations').find(r => r.kind === 'not_applied');
  assert.equal(terminal.executionId, f.pendingState.intent);
  assert.equal(rows(winner, 'storage.operations').some(r => r.kind === 'receipt' && r.executionId === f.pendingState.intent), false);
});

for (const operation of ['switch', 'restore']) test(`B2 ${operation} rechecks clock after authorisation await`, async t => {
  const f = await pending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
  const runtime = createStoragePlanner({ ...f.options, policy: { async authorise(input) {
    const result = await f.options.policy.authorise(input); f.clock.value = '2026-10-30T00:00:00.000Z'; return result;
  } } });
  reject(await runtime.migration[operation](request(f, operation, before.revision)), 'unavailable');
  await unchanged(f, before);
});

for (const field of ['criteriaDigest', 'evaluatorVersion', 'queries', 'expectedConditions']) test(`B2 changed ${field} requires catch-up before switch`, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const before = await f.snapshot();
  const comparison = structuredClone({ ...f.options.comparison, measurement: null }); comparison.measurement = f.options.comparison.measurement;
  if (field === 'criteriaDigest') comparison.criteriaDigest = digestJson('next-criteria');
  if (field === 'evaluatorVersion') comparison.evaluatorVersion = 'next-evaluator';
  if (field === 'queries') comparison.queries = [{ all: true, next: true }];
  if (field === 'expectedConditions') comparison.expectedConditions.extra = 'new-independent-condition';
  const runtime = createStoragePlanner({ ...f.options, comparison });
  reject(await runtime.migration.switch(request(f, 'switch', before.revision)), 'unavailable');
  await unchanged(f, before);
  take(await runtime.migration.catchUp('migration-1', before.revision));
  take(await runtime.migration.switch(request(f, 'switch', (await f.snapshot()).revision)));
  const after = await f.snapshot(); preserved(before, after);
  assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'not_applied' && r.executionId === f.pendingState.intent).length, 1);
  assert.equal(take(await runtime.head()).mappingId, 'M2');
});

test('B2 reference-only delta requires fresh projection and preserves its original check history', async t => {
  let revision = 0;
  const f = await pending('switch', { referenceChanges: {
    async readOriginal(s, id) {
      const value = structuredClone(rows(s, 'host.originals').find(o => o.message.envelope.message_id === id) ?? null);
      if (value) value.checkRefs = ['related-check'];
      return { ok: true, value };
    },
    async readCheck(s, id) {
      return { ok: true, value: { context: { taskId: 'storage-task', messageId: 'message-1', languageVersionId: 'L1', scope: 'storage-scope' },
        execution: { taskId: 'storage-task', executionId: `related-execution-${revision}`, inputDigest: digestJson(revision), performedAt: '2026-10-28T00:00:00.000Z',
          result: { checkId: id, targetMessageId: 'message-1', languageVersionId: 'L1', scope: 'storage-scope', dimension: 'factuality', verdict: revision ? 'fail' : 'pass' } } } };
    } } });
  t.after(() => f.store.close()); const before = await f.snapshot(); revision = 1;
  reject(await f.runtime.migration.switch(request(f, 'switch', before.revision)), 'unavailable');
  await unchanged(f, before);
  take(await f.runtime.migration.catchUp('migration-1', before.revision));
  take(await f.runtime.migration.switch(request(f, 'switch', (await f.snapshot()).revision)));
  const after = await f.snapshot(); preserved(before, after);
  const state = rows(after, 'storage.migrations')[0];
  assert.equal(state.dataset.references[0].checks[0].result.verdict, 'fail');
  assert.equal(rows(before, 'storage.migrations')[0].dataset.references[0].checks[0].result.verdict, 'pass');
});

test('B2 delayed switch cannot finalise after its intent was superseded', async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const reached = deferred(), release = deferred();
  const slow = createStoragePlanner({ ...f.options, policy: { async authorise(input) {
    const decision = await f.options.policy.authorise(input); reached.resolve(); await release.promise; return decision;
  } } });
  const old = slow.migration.switch(request(f, 'switch', (await f.snapshot()).revision)); await reached.promise;
  await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', mapping()));
  take(await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision));
  const caught = await f.snapshot(); release.resolve(); reject(await old, 'revision_conflict');
  assert.deepEqual(await f.snapshot(), caught);
  take(await f.runtime.migration.switch(request(f, 'switch', caught.revision)));
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
});
