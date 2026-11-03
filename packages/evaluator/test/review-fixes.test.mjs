import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistryInspectionAdapter } from '@semevolve/evaluator';
import { fixture, identity, input, request, value } from './support/fixture.mjs';
import { policyHost } from './support/policy.mjs';

const fingerprint = (modelId) => ({ peerId: 'peer-b', provider: 'synthetic', modelId, cliVersion: 'cli-1', settingsDigest: identity.digest({ temperature: 0 }), introductionDigest: identity.digest('public-intro') });

test('conformance does not certify a different implementation that shares only the peer id', async () => {
  const f = fixture();
  const inspected = fingerprint('fixed-a');
  const execution = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [], { ...input(), fingerprint: inspected })));
  const inspection = createRegistryInspectionAdapter({ evaluator: f.runtime, testSetDigest: f.run.testSetDigest });
  const record = (implementation) => ({ versionId: f.run.languageVersionId, fingerprint: implementation, scopeId: f.run.scope, testSetDigest: f.run.testSetDigest, evaluatorVersion: f.run.evaluatorVersion, checkIds: [execution.result.checkId], verdict: 'pass', checkedAt: identity.now() });
  assert.notEqual(value(await inspection.readConformance(record(inspected))), null);
  assert.equal(value(await inspection.readConformance(record(fingerprint('fixed-b')))), null);
});

test('evaluate rejects an answer that skipped condition disclosure', async () => {
  const f = fixture();
  value(await f.runtime.captureInput(input()));
  const interpretation = value(await f.runtime.recordAnswer({ ...input(), answer: { certainty: 'candidate' } }));
  assert.equal(interpretation.expectedConditionsDisclosedAt, null);
  const base = { taskId: f.run.taskId, targetMessageId: interpretation.messageId, languageVersionId: f.run.languageVersionId, dimension: 'transmission', interpretation, evidence: [], scope: f.run.scope };
  const result = await f.runtime.evaluate({ ...base, executionId: identity.newId('execution'), expectedConditions: f.run.expectedConditions.transmission, criteriaDigest: f.run.criteriaDigest, evaluatorVersion: f.run.evaluatorVersion, inputDigest: identity.digest(base) });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, 'invalid_input');
  assert.equal(value(await f.store.snapshot()).entries.filter(entry => entry.key.collection === 'evaluator.executions').length, 0);
});

test('a caller evidence id in the observation namespace does not stick the execution', async () => {
  const f = fixture();
  const disclosed = await request(f, 'transmission', { certainty: 'candidate' });
  const evidence = { evidenceId: `observation-${disclosed.executionId}`, source: 'public-fixture', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'reference_only' } };
  const base = { taskId: disclosed.taskId, targetMessageId: disclosed.targetMessageId, languageVersionId: disclosed.languageVersionId, dimension: disclosed.dimension, interpretation: disclosed.interpretation, evidence: [evidence], scope: disclosed.scope };
  const reserved = { ...base, executionId: disclosed.executionId, expectedConditions: disclosed.expectedConditions, criteriaDigest: disclosed.criteriaDigest, evaluatorVersion: disclosed.evaluatorVersion, inputDigest: identity.digest(base) };
  const blocked = await f.runtime.evaluate(reserved);
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.error.code, 'invalid_input');
  const snapshot = value(await f.store.snapshot());
  assert.equal(snapshot.entries.filter(entry => entry.key.collection === 'evaluator.requests').length, 0);
  assert.equal(snapshot.entries.filter(entry => entry.key.collection === 'evaluator.executions').length, 0);
  const ordinary = { ...evidence, evidenceId: 'public-source' };
  const retryBase = { ...base, evidence: [ordinary] };
  const retried = value(await f.runtime.evaluate({ ...reserved, evidence: [ordinary], inputDigest: identity.digest(retryBase) }));
  assert.equal(retried.executionId, disclosed.executionId);
  assert.equal(retried.result.verdict, 'pass');
});

test('failed completion settlement closes the reservation as an unknown outcome', async () => {
  const host = await policyHost({ maxInvocations: 1 });
  const budget = {
    start: binding => host.budget.start(binding),
    async settle(settlement) {
      if (settlement.outcome.kind === 'completed') return { ok: false, error: { code: 'unavailable', reason: 'settlement failed' } };
      return host.budget.settle(settlement);
    },
  };
  const f = fixture({ store: host.store, identity: host.identity, budget });
  const req = await request(f, 'transmission', { certainty: 'candidate' });
  const result = await f.runtime.evaluate(req);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, 'unavailable');
  const accounting = value(await host.policy.snapshot(host.task.taskId));
  assert.equal(accounting.reservations.length, 1);
  assert.equal(accounting.reservations[0].outcome.kind, 'unknown_outcome');
  const snapshot = value(await host.store.snapshot());
  assert.equal(snapshot.entries.filter(entry => entry.key.collection === 'evaluator.executions').length, 0);
  assert.equal(snapshot.events.some(event => event.kind === 'evaluator.unknown_outcome' && event.data.executionId === req.executionId), true);
  assert.equal((await f.runtime.evaluate(req)).error.code, 'unavailable');
});
