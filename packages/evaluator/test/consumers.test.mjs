import assert from 'node:assert/strict';
import test from 'node:test';
import { createAllowListPolicyGate } from '@semevolve/policy';
import { createFixedFakeProvider } from '@semevolve/provider-adapters';
import { createLanguageRegistry } from '@semevolve/language-registry';
import { createRegistryInspectionAdapter } from '@semevolve/evaluator';
import { fixture, identity, request, value } from './support/fixture.mjs';
import { policyHost } from './support/policy.mjs';

test('AT05 real Policy executes the passing control and refuses transmission failure', { timeout: 30000 }, async () => {
  for (const certainty of ['candidate', 'certain']) {
    const host = await policyHost();
    const f = fixture(host);
    const execution = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty })));
    const operation = { taskId: host.task.taskId, name: 'synthetic-read', target: 'public-fixture' };
    const base = createAllowListPolicyGate({ policyRevision: 1, grants: [operation] });
    const provider = createFixedFakeProvider();
    const gate = { async authorise(op) { const eligible = value(await f.runtime.readCheckEligibility(execution.result.checkId)); return eligible.eligible ? base.authorise(op) : { allowed: false, reason: eligible.reason }; } };
    const result = await host.policy.execute({ request: { taskId: host.task.taskId, invocationId: identity.newId('invocation') }, reservationId: identity.newId('reservation'), amount: { invocations: 1, inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null }, operation, gate, provider });
    if (certainty === 'candidate') { assert.equal(value(result).output, 'Public synthetic result'); assert.equal(provider.invocationCount, 1); }
    else { assert.equal(result.ok, false); assert.equal(result.error.code, 'unavailable'); assert.equal(result.error.reason, 'Operation is not authorised'); assert.equal(provider.invocationCount, 0); }
    const accounting = value(await host.policy.snapshot(host.task.taskId));
    assert.deepEqual(accounting.reservations.map(r => r.outcome.kind), certainty === 'candidate' ? ['unknown_outcome', 'unknown_outcome'] : ['unknown_outcome']);
    assert.equal(accounting.reservations[0].outcome.reason, 'usage_not_fully_observed');
    assert.equal(accounting.usage.costYen.kind, 'partial');
    assert.equal(accounting.reservations[0].outcome.usage.costYen, null);
  }
});

test('AT09 real Registry accepts a check then refuses new conformance after evidence withdrawal', { timeout: 30000 }, async () => {
  const f = fixture();
  const evidence = { evidenceId: 'public-source', source: 'public-fixture', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'reference_only' } };
  const execution = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [evidence])));
  const fingerprint = { peerId: 'peer-b', provider: 'synthetic', modelId: 'fixed', cliVersion: null, settingsDigest: identity.digest({}), introductionDigest: identity.digest('public') };
  const scope = { scopeId: f.run.scope, purpose: 'Synthetic registry consumer', taskRange: 'public-task', participantIds: ['peer-b'] };
  const testSetDigest = identity.digest('public-case-set');
  const inspection = createRegistryInspectionAdapter({ evaluator: f.runtime, testSetDigest });
  const registry = createLanguageRegistry({ store: f.store, scopes: [{ scope, fingerprints: [fingerprint], testSetDigest, evaluatorVersion: f.run.evaluatorVersion }], inspection, transitions: { async inspect() { return { ok: false, error: { code: 'unavailable', reason: 'Not part of E consumer' } }; } } });
  const content = { parent_ids: [], scope, specification_text: 'Synthetic conditional notation', public_examples: [{ expression: 'candidate', explanation: 'Public example', counterexample: false }], change_reason: 'Public consumer', compatibility_claims: [] };
  value(await registry.register({ ...content, version_id: f.run.languageVersionId, digest: identity.digest(content) }));
  for (const status of ['CANDIDATE', 'TRIAL']) value(await registry.appendStatus({ eventId: identity.newId('event'), versionId: f.run.languageVersionId, scopeId: f.run.scope, status, checkIds: [], reason: 'Synthetic transition', occurredAt: identity.now() }));
  const record = { versionId: f.run.languageVersionId, fingerprint, scopeId: f.run.scope, testSetDigest, evaluatorVersion: f.run.evaluatorVersion, checkIds: [execution.result.checkId], verdict: 'pass', checkedAt: identity.now(), expiresAt: null };
  value(await registry.recordConformance(record));
  value(await f.runtime.withdraw({ evidenceId: evidence.evidenceId, reason: 'Synthetic withdrawal', withdrawnAt: identity.now() }));
  assert.equal(value(await inspection.readConformance(record)), null);
  const next = { ...record, checkedAt: new Date(Date.parse(record.checkedAt) + 1).toISOString() };
  const refused = await registry.recordConformance(next);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'invalid_input');
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.withdrawals').length, 1);
});

for (const reason of ['cancelled', 'expired', 'exhausted', 'no_progress']) test(`real Policy ${reason} blocks a new evaluator start`, { timeout: 30000 }, async () => {
  const host = await policyHost({ maxInvocations: reason === 'exhausted' ? 0 : 2 });
  if (reason === 'cancelled') value(await host.policy.cancel(host.task.taskId));
  if (reason === 'expired') host.clock.now = host.task.deadline;
  if (reason === 'no_progress') for (let i = 0; i < 3; i++) value(await host.policy.noteProgress(host.task.taskId, false));
  const f = fixture(host);
  const result = await f.runtime.evaluate(await request(f));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.reason, new RegExp(reason));
  assert.equal(value(await host.policy.snapshot(host.task.taskId)).reservations.length, 0);
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.executions').length, 0);
});

test('actual Policy reservation race allows one of two new evaluator executions', { timeout: 30000 }, async () => {
  const host = await policyHost({ maxInvocations: 1 });
  const f = fixture(host);
  const req = await request(f, 'transmission', { certainty: 'candidate' });
  const results = await Promise.all([f.runtime.evaluate(req), f.runtime.evaluate({ ...req, executionId: identity.newId('execution') })]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok).length, 1);
  const budget = value(await host.policy.snapshot(host.task.taskId));
  assert.equal(budget.reservations.length, 1);
  assert.equal(budget.usage.costYen.kind, 'partial');
});
