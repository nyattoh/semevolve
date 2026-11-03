import assert from 'node:assert/strict';
import test from 'node:test';
import { operationSteps } from '@semevolve/core';
import { fixture, identity, request, value } from './support/fixture.mjs';

const pending = 'Execution is pending or unknown; no new start permitted';
function crashOnce(step, name) {
  let armed = true;
  return async (at, operation) => {
    if (armed && at === step && operation === name) {
      armed = false;
      throw new Error(`crash after ${name} ${step}`);
    }
  };
}
const rows = async (store, collection) => value(await store.snapshot()).entries.filter(entry => entry.key.collection === collection);
const budgetOf = (starts, settlements) => ({
  async start() { starts.count += 1; return { ok: true, value: { started: true } }; },
  async settle(input) { settlements.push(input.outcome.kind); return { ok: true, value: undefined }; },
});

for (const step of operationSteps) test(`evaluator.execution recovers after a crash at ${step}`, { timeout: 30000 }, async () => {
  const starts = { count: 0 };
  const settlements = [];
  const f = fixture({ budget: budgetOf(starts, settlements), fault: crashOnce(step, 'evaluator.execution') });
  const req = await request(f, 'transmission', { certainty: 'candidate' });
  const first = await f.runtime.evaluate(req);
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.error.code, 'unavailable');
  assert.match(first.error.reason, new RegExp(`crash after evaluator.execution ${step}`));
  assert.equal(starts.count, step === 'effect' ? 1 : 0);
  assert.deepEqual(settlements, step === 'effect' ? ['completed'] : []);
  assert.equal((await rows(f.store, 'evaluator.requests')).length, step === 'prepared' ? 0 : 1);
  assert.equal((await rows(f.store, 'evaluator.executions')).length, 0);
  assert.equal((await rows(f.store, 'evaluator.evidence')).some(entry => entry.key.id === `observation-${req.executionId}`), false);
  const retried = await f.runtime.evaluate(structuredClone(req));
  if (step === 'prepared') {
    assert.equal(value(retried).result.verdict, 'pass');
    assert.equal(starts.count, 1);
    assert.deepEqual(settlements, ['completed']);
    assert.equal((await rows(f.store, 'evaluator.executions')).length, 1);
    assert.deepEqual(value(await f.runtime.evaluate(structuredClone(req))), value(retried));
    assert.equal(starts.count, 1);
    return;
  }
  assert.equal(retried.ok, false, JSON.stringify(retried));
  assert.equal(retried.error.reason, pending);
  assert.equal(starts.count, step === 'effect' ? 1 : 0);
  assert.deepEqual(settlements, step === 'effect' ? ['completed'] : []);
  assert.equal((await rows(f.store, 'evaluator.executions')).length, 0);
  assert.equal((await f.runtime.evaluate(structuredClone(req))).error.reason, pending);
  assert.equal(starts.count, step === 'effect' ? 1 : 0);
});

for (const step of operationSteps) test(`evaluator.settle keeps a single start after a crash at ${step}`, { timeout: 30000 }, async () => {
  const starts = { count: 0 };
  const settlements = [];
  const f = fixture({ budget: budgetOf(starts, settlements), fault: crashOnce(step, 'evaluator.settle') });
  const req = await request(f, 'transmission', { certainty: 'candidate' });
  const first = await f.runtime.evaluate(req);
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.error.code, 'unavailable');
  assert.match(first.error.reason, new RegExp(`Execution outcome unknown: crash after evaluator.settle ${step}`));
  assert.equal(starts.count, 1);
  assert.equal((await rows(f.store, 'evaluator.executions')).length, 0);
  assert.equal((await rows(f.store, 'evaluator.requests')).length, 1);
  assert.equal(value(await f.store.snapshot()).events.some(event => event.kind === 'evaluator.unknown_outcome' && event.data.executionId === req.executionId), true);
  if (step === 'effect') assert.deepEqual(settlements, ['completed', 'unknown_outcome']);
  else assert.deepEqual(settlements, ['unknown_outcome']);
  assert.equal((await rows(f.store, 'evaluator.settle-intents')).length, step === 'prepared' ? 0 : 1);
  assert.equal((await rows(f.store, 'evaluator.settle-proofs')).length, 0);
  const retried = await f.runtime.evaluate(structuredClone(req));
  assert.equal(retried.ok, false, JSON.stringify(retried));
  assert.equal(retried.error.reason, pending);
  assert.equal(starts.count, 1);
  if (step === 'effect') assert.deepEqual(settlements, ['completed', 'unknown_outcome']);
  else assert.deepEqual(settlements, ['unknown_outcome']);
  assert.equal((await rows(f.store, 'evaluator.executions')).length, 0);
});

for (const step of operationSteps) test(`evaluator.invalidate recovers after a crash at ${step}`, { timeout: 30000 }, async () => {
  let calls = 0;
  const f = fixture({
    fault: crashOnce(step, 'evaluator.invalidate'),
    async invalidateEvidence() { calls += 1; return { ok: true, value: undefined }; },
  });
  const evidence = { evidenceId: 'public-source', source: 'public-fixture', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'reference_only' } };
  value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [evidence])));
  const withdrawal = { evidenceId: evidence.evidenceId, reason: 'synthetic source withdrawn', withdrawnAt: identity.now() };
  const first = await f.runtime.withdraw(withdrawal);
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.error.code, 'unavailable');
  assert.match(first.error.reason, new RegExp(`crash after evaluator.invalidate ${step}`));
  assert.equal(calls, step === 'effect' ? 1 : 0);
  assert.equal((await rows(f.store, 'evaluator.withdrawals')).length, step === 'prepared' ? 0 : 1);
  assert.equal((await rows(f.store, 'evaluator.withdrawal-reconciliation')).length, 0);
  value(await f.runtime.withdraw(structuredClone(withdrawal)));
  assert.equal(calls, step === 'effect' ? 2 : 1);
  const reconciled = await rows(f.store, 'evaluator.withdrawal-reconciliation');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].value.applied, true);
  value(await f.runtime.withdraw(structuredClone(withdrawal)));
  assert.equal(calls, step === 'effect' ? 2 : 1);
  assert.equal((await rows(f.store, 'evaluator.withdrawal-reconciliation')).length, 1);
});
