import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluator } from '@semevolve/evaluator';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, identity, request, value } from './support/fixture.mjs';
import { policyHost } from './support/policy.mjs';

test('AT10 concurrent delivery returns one exact result and consumes one reservation', { timeout: 30000 }, async () => {
  let starts = 0, settlements = 0;
  const f = fixture({ maxReadAttempts: 64, budget: { async start() { starts++; return { ok: true, value: { started: true } }; }, async settle() { settlements++; return { ok: true, value: undefined }; } } });
  const req = await request(f, 'transmission', { certainty: 'candidate' });
  const [one, two] = await Promise.all([f.runtime.evaluate(req), f.runtime.evaluate(structuredClone(req))]);
  const result = value(one);
  assert.deepEqual(value(two), result);
  assert.equal(starts, 1);
  assert.equal(settlements, 1);
  assert.deepEqual(value(await f.runtime.evaluate(req)), result);
  assert.deepEqual(value(await f.runtime.evaluate(req)).usage, result.usage);
  const changed = { ...req, scope: 'another' };
  assert.equal((await f.runtime.evaluate(changed)).error.code, 'invalid_input');
  const collision = { ...req, evidence: [], expectedConditions: req.expectedConditions, interpretation: req.interpretation, inputDigest: req.inputDigest, extra: 'different-body' };
  assert.equal((await f.runtime.evaluate(collision)).error.code, 'id_collision');
});

test('AT11 a new execution ID runs a new check without deleting the original', { timeout: 30000 }, async () => {
  const f = fixture();
  const req = await request(f);
  const first = value(await f.runtime.evaluate(req));
  const second = value(await f.runtime.evaluate({ ...req, executionId: identity.newId('execution') }));
  assert.notEqual(first.executionId, second.executionId);
  assert.notEqual(first.result.checkId, second.result.checkId);
  const state = value(await f.store.snapshot());
  assert.equal(state.entries.filter(e => e.key.collection === 'evaluator.requests').length, 2);
  assert.equal(state.entries.filter(e => e.key.collection === 'evaluator.executions').length, 2);
});

test('unknown start survives runtime restart without reclaim, new reservation or invented usage', { timeout: 30000 }, async () => {
  let starts = 0;
  const budget = { async start() { starts++; throw new Error('Host timed out after reservation'); }, async settle() { return { ok: true, value: undefined }; } };
  const f = fixture({ budget });
  const req = await request(f);
  const first = await f.runtime.evaluate(req);
  assert.equal(first.error.code, 'unavailable');
  const reopened = createEvaluator({ store: f.store, run: f.run, budget });
  const second = await reopened.evaluate(req);
  assert.equal(second.error.code, 'unavailable');
  assert.match(second.error.reason, /pending|unknown/);
  assert.equal(starts, 1);
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.executions').length, 0);
});

test('request mutation and forged interpretation chronology cannot alter the committed execution', { timeout: 30000 }, async () => {
  const f = fixture();
  const req = await request(f);
  const before = structuredClone(req);
  const pending = f.runtime.evaluate(req);
  req.executionId = 'forged'; req.interpretation.answer.certainty = 'candidate';
  const result = value(await pending);
  assert.equal(result.executionId, before.executionId);
  assert.equal(result.result.verdict, 'fail');
  const forged = { ...before, executionId: identity.newId('execution'), interpretation: { ...before.interpretation, recordedAt: '1900-01-01T00:00:00.000Z' } };
  const base = { taskId: forged.taskId, targetMessageId: forged.targetMessageId, languageVersionId: forged.languageVersionId, dimension: forged.dimension, interpretation: forged.interpretation, evidence: forged.evidence, scope: forged.scope };
  forged.inputDigest = identity.digest(base);
  assert.equal((await f.runtime.evaluate(forged)).error.code, 'invalid_input');
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.executions').length, 1);
});

for (const reason of ['timeout', 'cancelled']) test(`${reason} after start retains unknown usage and does not rerun on delivery`, { timeout: 30000 }, async () => {
  const controller = new AbortController();
  let entered;
  const observed = new Promise(resolve => { entered = resolve; });
  const settled = [];
  const f = fixture({ checkerTimeoutMs: 20, signal: controller.signal,
    observe: { async authorisation() { return null; }, async taskOutcome() { entered(); return new Promise(() => {}); } },
    budget: { async start() { return { ok: true, value: { started: true } }; }, async settle(input) { settled.push(input); return { ok: true, value: undefined }; } } });
  const req = await request(f, 'task_outcome');
  const pending = f.runtime.evaluate(req);
  await observed;
  if (reason === 'cancelled') controller.abort();
  const result = await pending;
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.reason, new RegExp(reason));
  assert.equal(settled[0].outcome.kind, 'unknown_outcome');
  assert.equal(settled[0].outcome.usage.costYen, null);
  assert.equal((await f.runtime.evaluate(req)).error.code, 'unavailable');
  assert.equal(settled.length, 1);
  const snapshot = value(await f.store.snapshot());
  assert.equal(snapshot.entries.filter(e => e.key.collection === 'evaluator.requests').length, 1);
  assert.equal(snapshot.events.some(e => e.kind === 'evaluator.unknown_outcome'), true);
});

test('AT10 actual process reopen returns the identical execution, time and usage', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(process.env.SEMEVOLVE_E_EVIDENCE_ROOT ?? tmpdir(), 'semevolve-e-execution-'));
  const child = mode => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./support/persisted-process.mjs', import.meta.url)), directory, mode], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = child('first');
  const second = child('second');
  assert.notEqual(first.pid, second.pid);
  assert.deepEqual(second.execution, first.execution);
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.equal(second.execution.result.verdict, 'pass');
  assert.equal(second.execution.usage.costYen, null);
});

for (const failure of ['result', 'throw', 'none']) test(`E-B1 ${failure} snapshot after start retains accounting and records observed failure`, { timeout: 30000 }, async () => {
  const host = await policyHost({ maxInvocations: 1 });
  let armed = false, calls = 0;
  const store = {
    async snapshot() {
      if (armed && failure !== 'none') {
        armed = false;
        if (failure === 'throw') throw new Error('Injected snapshot failure after successful start');
        return { ok: false, error: { code: 'unavailable', reason: 'Injected snapshot failure after successful start' } };
      }
      return host.store.snapshot();
    },
    transact: input => host.store.transact(input),
  };
  const budget = { async start(binding) { const result = await host.budget.start(binding); if (result.ok) armed = true; return result; }, settle: input => host.budget.settle(input) };
  const observe = { async authorisation() { return { allowed: true }; }, async taskOutcome() { calls++; return { finished: true }; } };
  const f = fixture({ store, identity: host.identity, budget, observe });
  const req = await request(f, 'task_outcome');
  const result = await f.runtime.evaluate(req);
  const accounting = value(await host.policy.snapshot(host.task.taskId));
  assert.equal(accounting.reservations.length, 1);
  assert.equal(accounting.reservations[0].outcome.kind, 'unknown_outcome');
  assert.equal(accounting.usage.costYen.kind, 'partial');
  const snapshot = value(await host.store.snapshot());
  assert.equal(snapshot.entries.filter(e => e.key.collection === 'evaluator.requests').length, 1);
  assert.equal(snapshot.entries.filter(e => e.key.collection === 'policy.starts').length, 1);
  if (failure === 'none') {
    assert.equal(value(result).result.verdict, 'pass');
    assert.equal(calls, 1);
  } else {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unavailable');
    assert.equal(calls, 0);
    assert.equal(snapshot.entries.filter(e => e.key.collection === 'evaluator.executions').length, 0);
    assert.equal(snapshot.events.some(e => e.kind === 'evaluator.unknown_outcome' && e.data.executionId === req.executionId), true);
    assert.equal((await f.runtime.evaluate(req)).error.code, 'unavailable');
    const reopened = createEvaluator({ store, run: f.run, identity: host.identity, budget, observe });
    assert.equal((await reopened.evaluate(req)).error.code, 'unavailable');
    const retained = value(await host.policy.snapshot(host.task.taskId));
    assert.deepEqual(retained.reservations, accounting.reservations);
    assert.deepEqual(retained.usage, accounting.usage);
    assert.equal(calls, 0);
    const fresh = await reopened.evaluate({ ...req, executionId: identity.newId('execution') });
    assert.equal(fresh.ok, false);
    assert.equal(value(await host.policy.snapshot(host.task.taskId)).reservations.length, 1);
    assert.equal(calls, 0);
  }
});
for (const stage of ['start-before-commit', 'start-after-commit', 'checker']) test(`E-B2 bounded duplicate during ${stage} replays the committed result without another reservation`, { timeout: 30000 }, async () => {
  const host = await policyHost();
  let entered, release;
  const observed = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let calls = 0, starts = 0;
  const budget = {
    async start(binding) {
      starts++;
      if (stage === 'start-before-commit') { entered(); await barrier; }
      const result = await host.budget.start(binding);
      if (stage === 'start-after-commit') { entered(); await barrier; }
      return result;
    },
    settle: input => host.budget.settle(input),
  };
  const observe = { async authorisation() { return { allowed: true }; }, async taskOutcome() { calls++; if (stage === 'checker') { entered(); await barrier; } return { finished: true }; } };
  const f = fixture({ ...host, budget, observe, maxReadAttempts: 8 });
  const req = await request(f, 'task_outcome');
  const pending = f.runtime.evaluate(req);
  await observed;
  try {
    const duplicate = await f.runtime.evaluate(structuredClone(req));
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, 'unavailable');
    assert.equal(duplicate.error.reason, 'Execution is pending or unknown; no new start permitted');
    assert.equal(starts, 1);
    assert.equal(calls, stage === 'checker' ? 1 : 0);
  } finally { release(); }
  const first = value(await pending);
  assert.equal(first.result.verdict, 'pass');
  const before = value(await host.policy.snapshot(host.task.taskId));
  const saved = value(await host.store.snapshot());
  assert.deepEqual(value(await f.runtime.evaluate(req)), first);
  const reopened = createEvaluator({ store: host.store, run: f.run, identity: host.identity, budget, observe, maxReadAttempts: 8 });
  assert.deepEqual(value(await reopened.evaluate(structuredClone(req))), first);
  assert.deepEqual(value(await host.store.snapshot()), saved);
  const after = value(await host.policy.snapshot(host.task.taskId));
  assert.deepEqual(after, before);
  assert.equal(after.reservations.length, 1);
  assert.equal(starts, 1);
  assert.equal(calls, 1);
});
