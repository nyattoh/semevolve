import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryTaskStore, openFileTaskStore } from '@semevolve/core';
import { fixture, identity, request, value } from './support/fixture.mjs';

const failure = reason => ({ ok: false, error: { code: 'unavailable', reason } });
const success = { ok: true, value: undefined };
const state = async f => value(await f.store.snapshot());
const rows = s => s.entries.filter(e => e.key.collection === 'evaluator.withdrawal-reconciliation');
const outcome = r => r.ok ? null : r.error;
async function setup(sequence, overrides = {}) {
  let calls = 0;
  const f = fixture({ ...overrides, async invalidateEvidence() { assert.ok(calls < sequence.length, 'unexpected invalidation'); return sequence[calls++]; } });
  const body = '{"cause":"X"}';
  const evidence = { evidenceId: 'public-withdrawal-source', source: 'synthetic', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'retrieved', body, digest: createHash('sha256').update(body).digest('hex'), retrievedAt: identity.now() } };
  const req = await request(f, 'factuality', { cause: 'X' }, [evidence]);
  const check = value(await f.runtime.evaluate(req)); assert.equal(check.result.verdict, 'pass');
  const withdrawal = { evidenceId: evidence.evidenceId, reason: 'synthetic source withdrawn', withdrawnAt: identity.now() };
  const initial = await state(f);
  return { f, req, check, withdrawal, initial, calls: () => calls };
}
async function eligibility(x, expected) {
  const result = value(await x.f.runtime.readCheckEligibility(x.check.result.checkId));
  assert.deepEqual([result.eligible, result.recheckRequired, result.tomboInvalidationPending], expected);
  assert.deepEqual(result.execution, x.check);
  const current = await state(x.f);
  for (const original of x.initial.entries) assert.deepEqual(current.entries.find(e => e.key.collection === original.key.collection && e.key.id === original.key.id), original);
}
for (const reasons of [['A', 'B'], ['A', 'A'], ['A', 'B', 'A']]) test(`N2 failed withdrawal observations ${reasons.join('-')} preserve history without false collision`, { timeout: 30000 }, async () => {
  const x = await setup(reasons.map(failure));
  await eligibility(x, [true, false, false]);
  for (const reason of reasons) {
    assert.equal(outcome(await x.f.runtime.withdraw(structuredClone(x.withdrawal))), null);
    assert.ok(rows(await state(x.f)).some(e => e.value.applied === false && e.value.reason.reason === reason));
  }
  const snapshot = await state(x.f);
  assert.equal(x.calls(), reasons.length);
  assert.equal(snapshot.entries.filter(e => e.key.collection === 'evaluator.withdrawals').length, 1);
  assert.equal(rows(snapshot).length, new Set(reasons).size);
  assert.deepEqual(rows(snapshot).map(e => e.value.reason.reason).sort(), [...new Set(reasons)].sort());
  await eligibility(x, [false, true, true]);
});
test('N2 failed then successful invalidation replays without another callback or write', { timeout: 30000 }, async () => {
  const x = await setup([failure('A'), success]);
  value(await x.f.runtime.withdraw(x.withdrawal)); await eligibility(x, [false, true, true]);
  value(await x.f.runtime.withdraw(x.withdrawal)); await eligibility(x, [false, true, false]);
  const snapshot = await state(x.f);
  assert.equal(rows(snapshot).length, 2);
  assert.equal(rows(snapshot).filter(e => e.value.applied).length, 1);
  value(await x.f.runtime.withdraw(x.withdrawal));
  assert.equal(x.calls(), 2); assert.deepEqual(await state(x.f), snapshot);
});
async function seed(f, collection, id, val) {
  value(await f.store.transact({ transactionId: identity.newId('transaction'), expectedRevision: (await state(f)).revision, mutations: [{ kind: 'insert', entry: { key: { collection, id }, value: val } }], events: [] }));
}
for (const reason of ['A', 'B']) test(`N2 legacy failed observation is retained on ${reason} redelivery`, { timeout: 30000 }, async () => {
  const x = await setup([failure(reason)]), id = identity.digest(x.withdrawal);
  const observation = { schema: 1, withdrawalId: id, evidenceId: x.withdrawal.evidenceId, applied: false, reason: failure('A').error };
  await seed(x.f, 'evaluator.withdrawals', id, { schema: 1, ...x.withdrawal });
  const key = identity.digest([id, false]);
  await seed(x.f, 'evaluator.withdrawal-reconciliation', key, observation);
  const before = await state(x.f);
  value(await x.f.runtime.withdraw(x.withdrawal));
  const after = await state(x.f);
  assert.deepEqual(after.entries.find(e => e.key.id === key).value, observation);
  assert.equal(rows(after).length, reason === 'A' ? 1 : 2);
  if (reason === 'A') assert.deepEqual(after, before);
  await eligibility(x, [false, true, true]);
});
test('N2 true withdrawal identity collision preserves the original and never calls invalidation', { timeout: 30000 }, async () => {
  const x = await setup([]), id = identity.digest(x.withdrawal);
  await seed(x.f, 'evaluator.withdrawals', id, { schema: 1, ...x.withdrawal, reason: 'other committed withdrawal' });
  const snapshot = await state(x.f);
  assert.deepEqual((await x.f.runtime.withdraw(x.withdrawal)).error, { code: 'id_collision', id });
  assert.equal(x.calls(), 0); assert.deepEqual(await state(x.f), snapshot);
});
for (const mode of ['one-conflict', 'result', 'throw']) test(`N2 observation ${mode} never retries invalidation or fabricates success`, { timeout: 30000 }, async () => {
  const backing = createMemoryTaskStore(); let armed = false, attempts = 0;
  const store = { snapshot: () => backing.snapshot(), async transact(batch) {
    if (armed && batch.events.some(e => e.kind === 'evaluator.withdrawal_reconciled')) {
      attempts++;
      if (mode === 'result') return failure('observation persistence unavailable');
      if (mode === 'throw') throw new Error('observation persistence unavailable');
      if (attempts === 1) value(await backing.transact({ transactionId: identity.newId('transaction'), expectedRevision: value(await backing.snapshot()).revision, mutations: [], events: [{ eventId: identity.newId('event'), taskId: 'public-task', actor: 'host', kind: 'public.concurrent', occurredAt: identity.now(), data: {} }] }));
    }
    return backing.transact(batch);
  } };
  const x = await setup([failure('A')], { store }); armed = true;
  const result = await x.f.runtime.withdraw(x.withdrawal);
  assert.equal(x.calls(), 1);
  if (mode === 'one-conflict') { value(result); assert.equal(attempts, 2); assert.equal(rows(await state(x.f)).length, 1); }
  else { assert.equal(result.error.code, 'unavailable'); assert.equal(attempts, 1); assert.equal(rows(await state(x.f)).length, 0); }
  assert.equal((await state(x.f)).entries.filter(e => e.key.collection === 'evaluator.withdrawals').length, 1);
  await eligibility(x, [false, true, true]);
});
test('N2 failure history and success survive file reopen and suppress completed invalidation', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-withdrawal-'));
  let store = await openFileTaskStore(directory);
  try {
    const x = await setup([failure('A')], { store }); value(await x.f.runtime.withdraw(x.withdrawal));
    await store.close(); store = await openFileTaskStore(directory);
    let calls = 0;
    let f = fixture({ store, async invalidateEvidence() { calls++; return calls === 1 ? failure('B') : success; } });
    value(await f.runtime.withdraw(x.withdrawal)); await eligibility({ ...x, f }, [false, true, true]);
    value(await f.runtime.withdraw(x.withdrawal)); await eligibility({ ...x, f }, [false, true, false]);
    assert.equal(calls, 2); const snapshot = await state(f); assert.equal(rows(snapshot).length, 3);
    await store.close(); store = await openFileTaskStore(directory);
    f = fixture({ store, async invalidateEvidence() { assert.fail('completed withdrawal must replay'); } });
    value(await f.runtime.withdraw(x.withdrawal)); assert.deepEqual(await state(f), snapshot);
    await eligibility({ ...x, f }, [false, true, false]);
  } finally { await store.close(); }
});
