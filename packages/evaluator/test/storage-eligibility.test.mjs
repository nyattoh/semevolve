import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { digestJson, openFileTaskStore } from '@semevolve/core';
import { createEvaluator } from '@semevolve/evaluator';
import { createAllowListPolicyGate } from '@semevolve/policy';
import { createFixedFakeProvider } from '@semevolve/provider-adapters';
import { fixture, identity, request, storageRequest, value } from './support/fixture.mjs';
import { policyHost } from './support/policy.mjs';
import { projectionFixture, projectionRequest, rehash, verdicts } from './support/storage-projection.mjs';

test('canonical storage eligibility reads saved results and tracks withdrawal without changing replay', { timeout: 30000 }, async () => {
  const f = fixture();
  const original = { certainty: 'candidate', ids: ['record-a'] };
  const req = storageRequest(f, original, original);
  const result = value(await f.runtime.evaluateStorage(req));
  const read = await f.runtime.readStorageCheckEligibility(req.executionId);
  assert.deepEqual(read.ok ? [read.value.eligible, read.value.recheckRequired, read.value.tomboInvalidationPending] : read.error, [true, false, false]);
  assert.deepEqual(read.value.request, req);
  assert.deepEqual(read.value.result, result);
  value(await f.runtime.withdraw({ evidenceId: result.evidenceIds[0], reason: 'Retracted observation', withdrawnAt: identity.now() }));
  const after = value(await f.runtime.readStorageCheckEligibility(req.executionId));
  assert.deepEqual([after.eligible, after.recheckRequired, after.tomboInvalidationPending], [false, true, true]);
  assert.deepEqual(value(await f.runtime.evaluateStorage(req)), result);
});

for (const profile of ['storage-v1', 'storage-projection-v1']) {
  for (const invalidation of ['withdrawn', 'criteria', 'evaluator']) test(`${profile} current eligibility reflects ${invalidation} while retaining canonical results`, { timeout: 30000 }, async () => {
    const f = profile === 'storage-v1' ? fixture() : projectionFixture();
    const data = { certainty: 'candidate', ids: ['record-a'] };
    const req = profile === 'storage-v1' ? storageRequest(f, data, data) : projectionRequest(f);
    const result = value(await f.runtime.evaluateStorage(req));
    if (invalidation === 'withdrawn') value(await f.runtime.withdraw({ evidenceId: result.evidenceIds[0], reason: 'Storage observation withdrawn', withdrawnAt: identity.now() }));
    else assert.equal((await f.runtime.evaluateStorage({ ...req, executionId: identity.newId('execution'), [invalidation === 'criteria' ? 'criteriaDigest' : 'evaluatorVersion']: invalidation === 'criteria' ? digestJson('changed') : 'changed' })).error.code, 'invalid_input');
    const current = await f.runtime.readStorageCheckEligibility(req.executionId);
    assert.deepEqual(current.ok ? [current.value.eligible, current.value.recheckRequired, current.value.tomboInvalidationPending] : current.error, [false, true, invalidation === 'withdrawn']);
    assert.deepEqual(current.value.request, req);
    assert.deepEqual(current.value.result, result);
    assert.deepEqual(value(await f.runtime.evaluateStorage(req)), result);
  });
}

for (const observation of ['failed', 'unknown']) test(`canonical storage read preserves ${observation} verdicts`, { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f);
  if (observation === 'failed') req.retrieved.units[0].representation.meaning.clauses[0].negation = false;
  else delete req.retrieved.units;
  const fixed = rehash(req);
  const result = value(await f.runtime.evaluateStorage(fixed));
  const read = await f.runtime.readStorageCheckEligibility(fixed.executionId);
  assert.deepEqual(read.ok ? [read.value.eligible, read.value.recheckRequired] : read.error, [false, false]);
  assert.deepEqual(read.value.result, result);
  assert.equal(result.meaningPreservation, observation === 'failed' ? 'fail' : 'inconclusive');
});

const corruptions = [
  ['missing request', s => { s.entries = s.entries.filter(e => e.key.collection !== 'evaluator.requests'); }],
  ['missing result', s => { s.entries = s.entries.filter(e => e.key.collection !== 'evaluator.storage-results'); }],
  ['missing run', s => { s.entries = s.entries.filter(e => e.key.collection !== 'evaluator.runs'); }],
  ['missing evidence', s => { s.entries = s.entries.filter(e => e.key.collection !== 'evaluator.evidence'); }],
  ['request kind', s => { s.entries.find(e => e.key.collection === 'evaluator.requests').value.kind = 'evaluation'; }],
  ['request task', s => { s.entries.find(e => e.key.collection === 'evaluator.requests').value.request.taskId = 'other'; }],
  ['request identity', s => { s.entries.find(e => e.key.collection === 'evaluator.requests').value.request.executionId = 'other'; }],
  ['request digest', s => { s.entries.find(e => e.key.collection === 'evaluator.requests').value.requestDigest = 'a'.repeat(64); }],
  ['result identity', s => { s.entries.find(e => e.key.collection === 'evaluator.storage-results').value.result.executionId = 'other'; }],
  ['result input', s => { s.entries.find(e => e.key.collection === 'evaluator.storage-results').value.result.inputDigest = 'a'.repeat(64); }],
  ['result criteria', s => { s.entries.find(e => e.key.collection === 'evaluator.storage-results').value.result.criteriaDigest = 'a'.repeat(64); }],
  ['result evaluator', s => { s.entries.find(e => e.key.collection === 'evaluator.storage-results').value.result.evaluatorVersion = 'other'; }],
  ['result scope', s => { s.entries.find(e => e.key.collection === 'evaluator.storage-results').value.result.scope = 'other'; }],
  ['result evidence', s => { s.entries.find(e => e.key.collection === 'evaluator.storage-results').value.result.evidenceIds = []; }],
  ['observation body', s => { s.entries.find(e => e.key.collection === 'evaluator.evidence').value.evidence.retrieved = {}; }],
  ['run criteria', s => { s.entries.find(e => e.key.collection === 'evaluator.runs').value.configuration.criteriaDigest = 'a'.repeat(64); }],
  ['run identity', s => { s.entries.find(e => e.key.collection === 'evaluator.runs').value.configuration.runId = 'other'; }],
];
for (const [name, change] of corruptions) test(`canonical storage refuses ${name}`, { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f);
  value(await f.runtime.evaluateStorage(req));
  let corrupt = false;
  const store = { async snapshot() { const result = await f.store.snapshot(); if (corrupt && result.ok) change(result.value); return result; }, transact: batch => f.store.transact(batch) };
  const runtime = createEvaluator({ store, run: f.run });
  assert.equal(value(await runtime.readStorageCheckEligibility(req.executionId)).eligible, true);
  corrupt = true;
  assert.equal((await runtime.readStorageCheckEligibility(req.executionId)).error.code, 'unavailable');
  assert.deepEqual(verdicts(value(await f.runtime.evaluateStorage(req))), ['pass', 'pass', 'pass']);
});

test('storage canonical read refuses a different runtime run without assigning old results to it', { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f);
  const result = value(await f.runtime.evaluateStorage(req));
  assert.equal(value(await f.runtime.readStorageCheckEligibility(req.executionId)).eligible, true);
  const other = projectionFixture({ store: f.store, run: { runId: 'another-run' } });
  assert.equal((await other.runtime.readStorageCheckEligibility(req.executionId)).error.code, 'unavailable');
  assert.deepEqual(value(await f.runtime.evaluateStorage(req)), result);
});

async function referenced(f, dimension = 'factuality') {
  const checkRun = fixture({ store: f.store, run: { ...fixture().run, runId: 'referenced-run' } });
  const body = '{"cause":"Y"}';
  const evidence = { evidenceId: 'reference-source', source: 'public-synthetic', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'retrieved', body, digest: createHash('sha256').update(body).digest('hex'), retrievedAt: identity.now() } };
  const checkRequest = await request(checkRun, dimension, { certainty: 'candidate' }, [evidence]);
  const check = value(await checkRun.runtime.evaluate(checkRequest));
  const req = projectionRequest(f);
  req.original.originals[0].checkRefs = [check.result.checkId];
  req.retrieved.units[0].checkRefs = [check.result.checkId];
  return { checkRun, checkRequest, check, evidence, req: rehash(req) };
}
for (const cause of ['factuality fail', 'withdrawal', 'run invalidation', 'missing check', 'missing referenced request', 'missing referenced evidence', 'wrong task', 'wrong scope', 'wrong message']) test(`storage referenced proof propagates ${cause}`, { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const x = await referenced(f);
  const result = value(await f.runtime.evaluateStorage(x.req));
  assert.deepEqual(verdicts(result), ['pass', 'pass', 'pass']);
  assert.equal(x.check.result.verdict, 'fail');
  assert.equal(value(await f.runtime.readStorageCheckEligibility(x.req.executionId)).eligible, true);
  if (cause === 'withdrawal') value(await x.checkRun.runtime.withdraw({ evidenceId: x.evidence.evidenceId, reason: 'Referenced source retracted', withdrawnAt: identity.now() }));
  if (cause === 'run invalidation') assert.equal((await x.checkRun.runtime.evaluate({ ...x.checkRequest, criteriaDigest: digestJson('changed') })).error.code, 'invalid_input');
  const store = { async snapshot() {
    const s = await f.store.snapshot();
    if (!s.ok) return s;
    if (cause === 'missing check') s.value.entries = s.value.entries.filter(e => e.key.collection !== 'evaluator.executions');
    if (cause === 'missing referenced request') s.value.entries = s.value.entries.filter(e => e.key.collection !== 'evaluator.requests' || e.key.id !== x.check.executionId);
    if (cause === 'missing referenced evidence') s.value.entries = s.value.entries.filter(e => e.key.collection !== 'evaluator.evidence' || e.key.id !== x.evidence.evidenceId);
    if (cause.startsWith('wrong ')) { const result = s.value.entries.find(e => e.key.collection === 'evaluator.executions').value.result; if (cause === 'wrong task') result.taskId = 'other'; if (cause === 'wrong scope') result.result.scope = 'other'; if (cause === 'wrong message') result.result.targetMessageId = 'other'; }
    return s;
  }, transact: batch => f.store.transact(batch) };
  const runtime = createEvaluator({ store, run: f.run });
  const read = await runtime.readStorageCheckEligibility(x.req.executionId);
  if (cause.startsWith('missing') || cause.startsWith('wrong')) assert.equal(read.error.code, 'unavailable');
  else assert.deepEqual([value(read).eligible, read.value.recheckRequired, read.value.tomboInvalidationPending], [cause === 'factuality fail', cause !== 'factuality fail', cause === 'withdrawal']);
  assert.deepEqual(value(await f.runtime.evaluateStorage(x.req)), result);
});

test('storage observation withdrawal and pending reconciliation survive file reopen', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(process.env.SEMEVOLVE_E_EVIDENCE_ROOT ?? tmpdir(), 'storage-eligibility-'));
  let store = await openFileTaskStore(directory);
  try {
    const f = projectionFixture({ store });
    const req = projectionRequest(f);
    const result = value(await f.runtime.evaluateStorage(req));
    const withdrawal = { evidenceId: result.evidenceIds[0], reason: 'Storage observation withdrawn', withdrawnAt: identity.now() };
    value(await f.runtime.withdraw(withdrawal));
    await store.close();
    store = await openFileTaskStore(directory);
    const reopened = createEvaluator({ store, run: f.run, async invalidateEvidence() { return { ok: true, value: undefined }; } });
    const read = await reopened.readStorageCheckEligibility(req.executionId);
    assert.deepEqual(read.ok ? [read.value.eligible, read.value.recheckRequired, read.value.tomboInvalidationPending] : read.error, [false, true, true]);
    assert.deepEqual(read.value.result, result);
    value(await reopened.withdraw(withdrawal));
    const applied = value(await reopened.readStorageCheckEligibility(req.executionId));
    assert.deepEqual([applied.eligible, applied.recheckRequired, applied.tomboInvalidationPending], [false, true, false]);
    const state = value(await store.snapshot());
    assert.equal(state.entries.filter(e => e.key.collection === 'evaluator.withdrawals').length, 1);
    assert.equal(state.entries.filter(e => e.key.collection === 'evaluator.withdrawal-reconciliation').length, 2);
    assert.deepEqual(value(await reopened.evaluateStorage(req)), result);
  } finally { await store.close(); }
});

test('current storage eligibility stops an actual Policy operation after withdrawal', { timeout: 30000 }, async () => {
  const host = await policyHost();
  const f = projectionFixture(host);
  const req = projectionRequest(f);
  const result = value(await f.runtime.evaluateStorage(req));
  const operation = { taskId: host.task.taskId, name: 'synthetic-read', target: 'public-fixture' };
  const base = createAllowListPolicyGate({ policyRevision: 1, grants: [operation] });
  const provider = createFixedFakeProvider();
  const gate = { async authorise(op) { const eligible = value(await f.runtime.readStorageCheckEligibility(req.executionId)); return eligible.eligible ? base.authorise(op) : { allowed: false, reason: eligible.reason }; } };
  const execute = () => host.policy.execute({ request: { taskId: host.task.taskId, invocationId: identity.newId('invocation') }, reservationId: identity.newId('reservation'), amount: { invocations: 1, inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null }, operation, gate, provider });
  assert.equal(value(await execute()).output, 'Public synthetic result');
  value(await f.runtime.withdraw({ evidenceId: result.evidenceIds[0], reason: 'Withdraw storage evidence', withdrawnAt: identity.now() }));
  assert.equal((await execute()).error.reason, 'Operation is not authorised');
  assert.equal(provider.invocationCount, 1);
});
