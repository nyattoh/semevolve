import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fixture, identity, request, storageRequest, value } from './support/fixture.mjs';

test('AT05 stores transmission failure for candidate changed to certain', { timeout: 30000 }, async () => {
  const f = fixture();
  const req = await request(f);
  const result = await f.runtime.evaluate(req);
  assert.equal(result.ok ? result.value.result.verdict : result.error.code, 'fail');
  const check = value(result);
  assert.equal(check.result.dimension, 'transmission');
  assert.equal(check.result.method, 'deterministic_test');
  assert.equal(check.usage.costYen, null);
  assert.match(check.executionId, /execution/);
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.executions').length, 1);
});

test('AT28 storage restoration, meaning and retrieval remain independent', { timeout: 30000 }, async () => {
  const f = fixture();
  const original = { certainty: 'candidate', claim: 'X', ids: ['record-a'], prose: 'long original' };
  const literal = value(await f.runtime.evaluateStorage(storageRequest(f, original, original)));
  assert.deepEqual([literal.literalRestoration, literal.meaningPreservation, literal.retrievalCorrectness], ['pass', 'pass', 'pass']);
  const changed = value(await f.runtime.evaluateStorage(storageRequest(f, original, { ...original, prose: 'short' })));
  assert.deepEqual([changed.literalRestoration, changed.meaningPreservation, changed.retrievalCorrectness], ['fail', 'pass', 'pass']);
  const missing = value(await f.runtime.evaluateStorage(storageRequest(f, original, { ...original, ids: ['unrelated'] })));
  assert.deepEqual([missing.literalRestoration, missing.meaningPreservation, missing.retrievalCorrectness], ['fail', 'pass', 'fail']);
  const faithfullyWrongRetrieval = { ...original, ids: ['unrelated'] };
  const separate = value(await f.runtime.evaluateStorage(storageRequest(f, faithfullyWrongRetrieval, faithfullyWrongRetrieval)));
  assert.deepEqual([separate.literalRestoration, separate.meaningPreservation, separate.retrievalCorrectness], ['pass', 'pass', 'fail']);
});

export function evidence(kind = 'retrieved') {
  const body = JSON.stringify({ cause: 'Y' });
  return { evidenceId: 'public-counterevidence', source: 'public-synthetic-observation', scope: 'public-synthetic', allowedReaders: ['evaluator'], content: kind === 'retrieved' ? { kind, body, digest: createHash('sha256').update(body).digest('hex'), retrievedAt: identity.now() } : kind === 'unavailable' ? { kind, reason: 'Source removed' } : { kind } };
}

test('AT06 factual counterevidence survives agreement and withdrawal retains the original result', { timeout: 30000 }, async () => {
  const f = fixture();
  const req = await request(f, 'factuality', { certainty: 'candidate', cause: 'X', agreedBy: ['a', 'b'] }, [evidence()]);
  const execution = value(await f.runtime.evaluate(req));
  assert.equal(execution.result.verdict, 'fail');
  assert.equal(execution.result.dimension, 'factuality');
  assert.ok(execution.result.evidenceIds.includes('public-counterevidence'));
  value(await f.runtime.withdraw({ evidenceId: 'public-counterevidence', reason: 'Synthetic retraction', withdrawnAt: identity.now() }));
  const original = value(await f.runtime.evaluate(req));
  assert.deepEqual(original, execution);
  const state = value(await f.store.snapshot());
  assert.equal(state.entries.filter(e => e.key.collection === 'evaluator.withdrawals').length, 1);
  assert.equal(state.entries.filter(e => e.key.collection === 'evaluator.evidence').length, 2);
});

for (const kind of ['reference_only', 'unavailable']) test(`AT07 ${kind} is inconclusive`, { timeout: 30000 }, async () => {
  const f = fixture();
  const result = value(await f.runtime.evaluate(await request(f, 'factuality', { cause: 'X' }, [evidence(kind)])));
  assert.equal(result.result.verdict, 'inconclusive');
  assert.match(result.result.limitation, /unavailable|reference_only/);
});

test('four dimensions do not promote transmission into factuality, permission or completion', { timeout: 30000 }, async () => {
  const f = fixture({ observe: { async authorisation() { return { allowed: false }; }, async taskOutcome() { return null; } } });
  const req = await request(f, 'transmission', { certainty: 'candidate', cause: 'X' });
  const make = (dimension, evidence = []) => {
    const base = { taskId: req.taskId, targetMessageId: req.targetMessageId, languageVersionId: req.languageVersionId, dimension, interpretation: req.interpretation, evidence, scope: req.scope };
    return { ...req, ...base, expectedConditions: f.run.expectedConditions[dimension], executionId: identity.newId('execution'), inputDigest: identity.digest(base) };
  };
  const results = [];
  for (const dimension of ['transmission', 'factuality', 'authorisation', 'task_outcome']) {
    const result = value(await f.runtime.evaluate(make(dimension, dimension === 'factuality' ? [evidence()] : [])));
    results.push([result.result.dimension, result.result.verdict]);
  }
  assert.deepEqual(results, [['transmission', 'pass'], ['factuality', 'fail'], ['authorisation', 'fail'], ['task_outcome', 'inconclusive']]);
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.executions').length, 4);
});

test('AT09 pass withdrawal removes eligibility, retains history and needs a fresh execution', { timeout: 30000 }, async () => {
  let invalidations = 0;
  const f = fixture({ async invalidateEvidence() { invalidations++; return { ok: true, value: undefined }; } });
  const source = evidence();
  const req = await request(f, 'transmission', { certainty: 'candidate' }, [source]);
  const passed = value(await f.runtime.evaluate(req));
  assert.equal(value(await f.runtime.readCheckEligibility(passed.result.checkId)).eligible, true);
  const withdrawal = { evidenceId: source.evidenceId, reason: 'Retracted', withdrawnAt: identity.now() };
  value(await f.runtime.withdraw(withdrawal));
  value(await f.runtime.withdraw(withdrawal));
  assert.equal(invalidations, 1);
  const eligibility = value(await f.runtime.readCheckEligibility(passed.result.checkId));
  assert.deepEqual([eligibility.eligible, eligibility.recheckRequired, eligibility.tomboInvalidationPending], [false, true, false]);
  assert.equal(eligibility.request.criteriaDigest, f.run.criteriaDigest);
  assert.deepEqual(value(await f.runtime.evaluate(req)), passed);
  const next = value(await f.runtime.evaluate({ ...req, executionId: identity.newId('execution') }));
  assert.notEqual(next.result.checkId, passed.result.checkId);
});

test('AT24 changed criteria or evaluator invalidates the comparison and preserves the old request', { timeout: 30000 }, async () => {
  for (const property of ['criteriaDigest', 'evaluatorVersion']) {
    const f = fixture();
    const req = await request(f, 'transmission', { certainty: 'candidate' });
    const execution = value(await f.runtime.evaluate(req));
    const changed = { ...req, executionId: identity.newId('execution'), [property]: property === 'criteriaDigest' ? identity.digest('changed') : 'changed' };
    assert.equal((await f.runtime.evaluate(changed)).error.code, 'invalid_input');
    const eligibility = value(await f.runtime.readCheckEligibility(execution.result.checkId));
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.recheckRequired, true);
    assert.deepEqual(eligibility.request, req);
    assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.run-invalidations').length, 1);
  }
});

test('source scope, missing body, wrong hashes and unknown condition formats fail closed', { timeout: 30000 }, async () => {
  for (const change of [e => ({ ...e, scope: 'another-scope' }), e => ({ ...e, content: { kind: 'retrieved', body: '', digest: createHash('sha256').update('').digest('hex'), retrievedAt: identity.now() } }), e => ({ ...e, content: { ...e.content, digest: 'a'.repeat(64) } })]) {
    const f = fixture();
    const result = value(await f.runtime.evaluate(await request(f, 'factuality', { cause: 'X' }, [change(evidence())])));
    assert.equal(result.result.verdict, 'inconclusive');
    assert.equal(typeof result.result.limitation, 'string');
  }
  const f = fixture();
  const req = await request(f);
  assert.equal((await f.runtime.evaluate({ ...req, expectedConditions: { kind: 'execute', script: 'bad' } })).error.code, 'invalid_input');
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.executions').length, 0);
});
