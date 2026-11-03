import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestJson, openFileTaskStore } from '@semevolve/core';
import { createEvaluator, createRegistryInspectionAdapter } from '@semevolve/evaluator';
import { fixture, identity, input, request, value } from './support/fixture.mjs';
import { projectionFixture, projectionRequest, rehash, verdicts } from './support/storage-projection.mjs';

const budget = { async start() { return { ok: true, value: { started: true } }; }, async settle() { return { ok: true, value: undefined }; } };
const fingerprint = modelId => ({ peerId: 'peer-b', provider: 'synthetic', modelId, cliVersion: 'cli-1', settingsDigest: identity.digest({ temperature: 0 }), introductionDigest: identity.digest('public-intro') });

test('reopening a run with another test set cannot reuse the saved check', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-completion-'));
  const store = await openFileTaskStore(directory);
  const f = fixture({ store, budget });
  const inspected = fingerprint('fixed-a');
  const execution = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [], { ...input(), fingerprint: inspected })));
  const saved = value(await store.snapshot()).entries.find(entry => entry.key.collection === 'evaluator.executions');
  assert.equal(saved.value.identity.testSetDigest, f.run.testSetDigest);
  assert.deepEqual(saved.value.identity.fingerprint, inspected);
  assert.deepEqual(saved.value.steps, ['judged', 'settled']);
  await store.close();
  const reopened = await openFileTaskStore(directory);
  const same = createEvaluator({ store: reopened, run: f.run, budget });
  const eligible = value(await same.readCheckEligibility(execution.result.checkId));
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.testSetDigest, f.run.testSetDigest);
  const changedRun = { ...f.run, testSetDigest: identity.digest('replacement-case-set') };
  const changed = createEvaluator({ store: reopened, run: changedRun, budget });
  const eligibility = await changed.readCheckEligibility(execution.result.checkId);
  assert.equal(eligibility.ok, false, JSON.stringify(eligibility));
  assert.equal(eligibility.error.code, 'unavailable');
  const inspection = createRegistryInspectionAdapter({ evaluator: changed, testSetDigest: changedRun.testSetDigest });
  const record = { versionId: changedRun.languageVersionId, fingerprint: inspected, scopeId: changedRun.scope, testSetDigest: changedRun.testSetDigest, evaluatorVersion: changedRun.evaluatorVersion, checkIds: [execution.result.checkId], verdict: 'pass', checkedAt: identity.now() };
  const conformance = await inspection.readConformance(record);
  assert.equal(conformance.ok, false, JSON.stringify(conformance));
  assert.equal(conformance.error.code, 'unavailable');
  await reopened.close();
});

test('a projection corpus that omits one fixed payload fails every verdict', { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f, { all: true });
  req.original.originals = req.original.originals.filter(original => original.message.envelope.message_id === 'public-message');
  const result = value(await f.runtime.evaluateStorage(rehash(req)));
  assert.deepEqual(verdicts(result), ['fail', 'fail', 'fail']);
  assert.equal(value(await f.runtime.readStorageCheckEligibility(req.executionId)).eligible, false);
});

test('a saved check from another evaluator cannot be reused', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-evaluator-identity-'));
  const store = await openFileTaskStore(directory);
  const f = fixture({ store, budget });
  const execution = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [], input())));
  const saved = value(await store.snapshot()).entries.find(entry => entry.key.collection === 'evaluator.executions');
  assert.equal(saved.value.identity.evaluatorId, f.run.evaluatorId);
  assert.equal(saved.value.identity.checkerId, f.run.checkerId);
  assert.equal(saved.value.identity.testSetDigest, f.run.testSetDigest);
  assert.equal(saved.value.identity.executionId, execution.executionId);
  await store.close();
  const reopened = await openFileTaskStore(directory);
  const same = createEvaluator({ store: reopened, run: f.run, budget });
  assert.equal(value(await same.readCheckEligibility(execution.result.checkId)).eligible, true);
  const changedRun = { ...f.run, evaluatorId: 'other-evaluator' };
  const changed = createEvaluator({ store: reopened, run: changedRun, budget });
  const eligibility = await changed.readCheckEligibility(execution.result.checkId);
  assert.equal(eligibility.ok, false, JSON.stringify(eligibility));
  assert.equal(eligibility.error.code, 'unavailable');
  const inspection = createRegistryInspectionAdapter({ evaluator: changed, testSetDigest: f.run.testSetDigest });
  const record = { versionId: f.run.languageVersionId, fingerprint: fingerprint('fixed-a'), scopeId: f.run.scope, testSetDigest: f.run.testSetDigest, evaluatorVersion: f.run.evaluatorVersion, checkIds: [execution.result.checkId], verdict: 'pass', checkedAt: identity.now() };
  const conformance = await inspection.readConformance(record);
  assert.equal(conformance.ok, false, JSON.stringify(conformance));
  assert.equal(conformance.error.code, 'unavailable');
  await reopened.close();
});

test('a projection corpus with an id outside the fixed payload manifest fails every verdict', { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f, { all: true });
  const source = req.original.originals[0];
  const envelope = { ...source.message.envelope, message_id: 'extra-message' };
  req.original.originals.push({ ...source, message: { envelope, digest: digestJson(envelope) }, payloadDigest: digestJson(envelope.payload) });
  const result = value(await f.runtime.evaluateStorage(rehash(req)));
  assert.deepEqual(verdicts(result), ['fail', 'fail', 'fail']);
  assert.equal(value(await f.runtime.readStorageCheckEligibility(req.executionId)).eligible, false);
});

test('an unexpected literal id fails restoration and eligibility', { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f, { all: true });
  req.retrieved.literals['extra-message'] = 'unexpected';
  const result = value(await f.runtime.evaluateStorage(rehash(req)));
  assert.deepEqual(verdicts(result), ['fail', 'pass', 'pass']);
  assert.equal(value(await f.runtime.readStorageCheckEligibility(req.executionId)).eligible, false);
});

test('a missing literal id fails restoration and eligibility', { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f, { all: true });
  delete req.retrieved.literals['public-message'];
  const result = value(await f.runtime.evaluateStorage(rehash(req)));
  assert.deepEqual(verdicts(result), ['fail', 'pass', 'pass']);
  assert.equal(value(await f.runtime.readStorageCheckEligibility(req.executionId)).eligible, false);
});

test('a duplicate projection message id fails every verdict', { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f, { all: true });
  req.original.originals.push(structuredClone(req.original.originals[0]));
  const result = value(await f.runtime.evaluateStorage(rehash(req)));
  assert.deepEqual(verdicts(result), ['fail', 'fail', 'fail']);
  assert.equal(value(await f.runtime.readStorageCheckEligibility(req.executionId)).eligible, false);
});
