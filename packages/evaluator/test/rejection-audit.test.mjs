import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTaskStore, openFileTaskStore } from '@semevolve/core';
import { createEvaluator } from '@semevolve/evaluator';
import { fixture, identity, request, storageRequest, value } from './support/fixture.mjs';
import { policyHost } from './support/policy.mjs';

const state = async f => value(await f.store.snapshot());
function auditDelta(before, after, expected) {
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.revision, before.revision + 1);
  const event = after.events.at(-1);
  assert.equal(event.kind, 'evaluator.rejected');
  assert.equal(event.actor, 'host');
  assert.equal(event.taskId, 'public-task');
  for (const [key, val] of Object.entries(expected)) assert.deepEqual(event.data[key], val);
}
async function collisionSetup(overrides = {}) {
  const f = fixture(overrides);
  const req = await request(f, 'transmission', { certainty: 'candidate' });
  const result = value(await f.runtime.evaluate(req));
  assert.equal(result.result.verdict, 'pass');
  return { f, req, result, changed: { ...req, extra: 'distinct-request' } };
}
for (const kind of ['evaluation', 'storage']) test(`N1 ${kind} execution collision is audited without changing originals`, { timeout: 30000 }, async () => {
  const f = fixture();
  const req = kind === 'evaluation' ? await request(f, 'transmission', { certainty: 'candidate' }) : storageRequest(f, { certainty: 'candidate', ids: ['record-a'] }, { certainty: 'candidate', ids: ['record-a'] });
  const evaluate = r => kind === 'evaluation' ? f.runtime.evaluate(r) : f.runtime.evaluateStorage(r);
  const original = value(await evaluate(req));
  const before = await state(f);
  const changed = { ...req, extra: 'distinct-request' };
  assert.deepEqual((await evaluate(changed)).error, { code: 'id_collision', id: req.executionId });
  const saved = await state(f);
  auditDelta(before, saved, { operation: kind === 'evaluation' ? 'evaluate' : 'evaluateStorage', runId: f.run.runId, executionId: req.executionId, requestDigest: identity.digest({ runId: f.run.runId, kind, request: changed }), error: { code: 'id_collision', id: req.executionId } });
  assert.deepEqual(value(await evaluate(req)), original);
  assert.deepEqual(await state(f), saved);
});
test('N1 evidence collision audits the rejected reference and keeps the original execution', { timeout: 30000 }, async () => {
  let starts = 0;
  const f = fixture({ budget: { async start() { starts++; return { ok: true, value: { started: true } }; }, async settle() { return { ok: true, value: undefined }; } } });
  const evidence = { evidenceId: 'public-source', source: 'public-source', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'retrieved', body: '{"cause":"X"}', digest: createHash('sha256').update('{"cause":"X"}').digest('hex'), retrievedAt: identity.now() } };
  const req = await request(f, 'transmission', { certainty: 'candidate' }, [evidence]);
  const original = value(await f.runtime.evaluate(req));
  const changed = structuredClone(req); changed.executionId = identity.newId('execution');
  changed.evidence[0].content.body = '{"cause":"Y"}';
  changed.evidence[0].content.digest = createHash('sha256').update(changed.evidence[0].content.body).digest('hex');
  const { taskId, targetMessageId, languageVersionId, dimension, interpretation, scope } = changed;
  changed.inputDigest = identity.digest({ taskId, targetMessageId, languageVersionId, dimension, interpretation, evidence: changed.evidence, scope });
  const before = await state(f);
  assert.deepEqual((await f.runtime.evaluate(changed)).error, { code: 'id_collision', id: evidence.evidenceId });
  const after = await state(f);
  auditDelta(before, after, { operation: 'evaluate', executionId: changed.executionId, evidenceId: evidence.evidenceId, error: { code: 'id_collision', id: evidence.evidenceId } });
  assert.equal(starts, 1);
  assert.deepEqual(value(await f.runtime.evaluate(req)), original);
  assert.deepEqual(await state(f), after);
});
for (const stage of ['start-before-commit', 'start-after-commit', 'checker']) test(`N1 pending duplicate at ${stage} adds one audit and never repeats the check`, { timeout: 30000 }, async () => {
  const host = await policyHost();
  let entered, release, starts = 0, calls = 0;
  const observed = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  const budget = { async start(binding) { starts++; if (stage === 'start-before-commit') { entered(); await barrier; } const result = await host.budget.start(binding); if (stage === 'start-after-commit') { entered(); await barrier; } return result; }, settle: b => host.budget.settle(b) };
  const observe = { async authorisation() { return { allowed: true }; }, async taskOutcome() { calls++; if (stage === 'checker') { entered(); await barrier; } return { finished: true }; } };
  const f = fixture({ ...host, budget, observe });
  const req = await request(f, 'task_outcome');
  const pending = f.runtime.evaluate(req);
  await observed;
  try {
    const before = await state(f);
    const duplicate = await f.runtime.evaluate(structuredClone(req));
    assert.deepEqual(duplicate.error, { code: 'unavailable', reason: 'Execution is pending or unknown; no new start permitted' });
    auditDelta(before, await state(f), { operation: 'evaluate', executionId: req.executionId, error: duplicate.error });
    assert.equal(starts, 1); assert.equal(calls, stage === 'checker' ? 1 : 0);
  } finally { release(); }
  const original = value(await pending); assert.equal(original.result.verdict, 'pass');
  const saved = await state(f);
  assert.deepEqual(value(await f.runtime.evaluate(req)), original);
  const reopened = createEvaluator({ store: f.store, run: f.run, identity: host.identity, budget, observe });
  assert.deepEqual(value(await reopened.evaluate(req)), original);
  assert.deepEqual(await state(f), saved);
  assert.equal(starts, 1); assert.equal(calls, 1);
  assert.equal(value(await host.policy.snapshot(host.task.taskId)).reservations.length, 1);
});
for (const mode of ['one-conflict', 'all-conflicts', 'result', 'throw', 'snapshot-result', 'snapshot-throw']) test(`N1 rejection audit ${mode} is finite and does not promote success`, { timeout: 30000 }, async () => {
  const backing = createMemoryTaskStore(); let armed = false, attempted = 0, snapshots = 0;
  const store = {
    async snapshot() {
      if (armed && mode.startsWith('snapshot-') && ++snapshots === 4) {
        if (mode === 'snapshot-throw') throw new Error('audit snapshot failure');
        return { ok: false, error: { code: 'unavailable', reason: 'audit snapshot failure' } };
      }
      return backing.snapshot();
    },
    async transact(batch) {
      if (armed && batch.events.some(e => e.kind === 'evaluator.rejected')) {
        attempted++;
        if (mode === 'throw') throw new Error('audit write failure');
        if (mode === 'result') return { ok: false, error: { code: 'unavailable', reason: 'audit write failure' } };
        if (mode === 'all-conflicts' || (mode === 'one-conflict' && attempted === 1)) {
          value(await backing.transact({ transactionId: identity.newId('transaction'), expectedRevision: value(await backing.snapshot()).revision, mutations: [], events: [{ eventId: identity.newId('event'), taskId: 'public-task', actor: 'host', kind: 'public.concurrent', occurredAt: identity.now(), data: {} }] }));
        }
      }
      return backing.transact(batch);
    },
  };
  const { f, changed } = await collisionSetup({ store, maxReadAttempts: 2 });
  const before = value(await backing.snapshot()); armed = true;
  const result = await f.runtime.evaluate(changed);
  const after = value(await backing.snapshot());
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  if (mode === 'one-conflict') {
    assert.equal(result.error.code, 'id_collision'); assert.equal(attempted, 2);
    assert.deepEqual(after.events.slice(before.events.length).map(e => e.kind), ['public.concurrent', 'evaluator.rejected']);
  } else {
    assert.equal(result.error.code, 'unavailable'); assert.match(result.error.reason, /audit.*unconfirmed/i);
    assert.equal(attempted, mode === 'all-conflicts' ? 2 : mode.startsWith('snapshot-') ? 0 : 1);
    assert.equal(after.events.filter(e => e.kind === 'evaluator.rejected').length, 0);
    assert.equal(after.events.length - before.events.length, mode === 'all-conflicts' ? 2 : 0);
  }
});
test('N1 rejection audit and canonical execution survive file store reopen', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-rejection-'));
  let store = await openFileTaskStore(directory);
  try {
    const { f, req, result, changed } = await collisionSetup({ store });
    const before = await state(f);
    assert.equal((await f.runtime.evaluate(changed)).error.code, 'id_collision');
    const saved = await state(f); auditDelta(before, saved, { executionId: req.executionId });
    await store.close(); store = await openFileTaskStore(directory);
    const reopened = fixture({ store });
    assert.deepEqual(await state(reopened), saved);
    assert.deepEqual(value(await reopened.runtime.evaluate(req)), result);
    assert.deepEqual(await state(reopened), saved);
  } finally { await store.close(); }
});
