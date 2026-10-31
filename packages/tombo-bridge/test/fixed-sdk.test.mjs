import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import { createManagedSession, createTomboBridge } from '@semevolve/tombo-bridge';
import { input, update, value } from './support/fixture.mjs';
import { sdkOptions } from './support/sdk-fixture.mjs';
import { fixture as evaluatorFixture, request as evaluatorRequest } from '../../evaluator/test/support/fixture.mjs';

test('AT08 actual fixed SDK needs_reflection is represented by the bridge', { timeout: 30000 }, async () => {
  const sdk = await sdkOptions();
  const bridge = createTomboBridge({ store: createMemoryTaskStore(), session: sdk.session, sdkCommit: sdk.commit });
  const result = await bridge.inspect(input());
  const actual = JSON.parse(await readFile(join(sdk.taskDirectory, '.session/state.json'), 'utf8'));
  assert.equal(actual.state.decision, 'needs_reflection');
  assert.equal(actual.understandingStatus.canReportCompletion, false);
  assert.equal(result.ok ? result.value.canReportCompletion : result.error.code, false);
});

test('actual SDK receives counterevidence, reconciles both hashes and preserves usage on replay', { timeout: 30000 }, async () => {
  const sdk = await sdkOptions();
  const store = createMemoryTaskStore();
  const bridge = createTomboBridge({ store, session: sdk.session, sdkCommit: sdk.commit });
  const req = update(value(await bridge.inspect(input())).reference);
  const body = JSON.stringify({ cause: 'Y' });
  const observation = req.payload.observations[0];
  observation.outcome = 'completed';
  observation.evidence = [{ id: 'public-counterevidence', kind: 'test', locator: 'public-synthetic-test', sourceGroup: 'public-synthetic-source', retrievedAt: new Date().toISOString(), version: 'public-v1', scope: 'public-synthetic', passage: body, contentHash: createHash('sha256').update(body).digest('hex'), validity: 'current' }];
  req.inputDigest = hostIdentity.digest(req.payload);
  value(await bridge.receive(req));
  const received = await sdk.session.status(req.taskId);
  assert.equal(received.session.updates[0].status, 'received_unassessed');
  assert.equal(received.understandingStatus.canReportCompletion, false);
  const reconciled = value(await bridge.reconcile(req));
  assert.equal(reconciled.kind, 'reconciled');
  const before = await sdk.session.status(req.taskId);
  assert.equal(before.apiCallsMade, 0);
  assert.equal(before.hostUsage.costYen, null);
  assert.equal(before.state.claims[0].status, 'contradicted');
  assert.equal(before.state.appliedExecutions[0].payloadHash, hostIdentity.digest(observation));
  assert.equal(before.session.updates[0].payloadHash, hostIdentity.digest(req.payload));
  assert.equal(before.session.updates[0].status, 'applied');
  assert.equal(before.state.usage.costYen, null);
  assert.equal(reconciled.summary.canReportCompletion, before.understandingStatus.canReportCompletion);
  assert.deepEqual(value(await bridge.reconcile(req)), reconciled);
  value(await bridge.receive(req));
  const after = await sdk.session.status(req.taskId);
  assert.equal(after.state.usage.modelCalls, before.state.usage.modelCalls);
  assert.equal(after.state.usage.toolCalls, before.state.usage.toolCalls);
  assert.equal(after.state.appliedExecutions.length, 1);
  const evaluator = evaluatorFixture({ async invalidateEvidence(request) {
    const actual = await sdk.session.invalidate([request.evidenceId], request.reason);
    return actual.state.evidence.find(e => e.id === request.evidenceId)?.validity === 'withdrawn'
      ? { ok: true, value: undefined } : { ok: false, error: { code: 'unavailable', reason: 'Actual SDK invalidation is pending' } };
  } });
  const ref = { evidenceId: 'public-counterevidence', source: 'public-synthetic-test', scope: 'public-synthetic', allowedReaders: ['evaluator'], content: { kind: 'retrieved', body, digest: observation.evidence[0].contentHash, retrievedAt: observation.evidence[0].retrievedAt } };
  const checked = value(await evaluator.runtime.evaluate(await evaluatorRequest(evaluator, 'transmission', { certainty: 'candidate' }, [ref])));
  assert.equal(checked.result.verdict, 'pass');
  value(await evaluator.runtime.withdraw({ evidenceId: ref.evidenceId, reason: 'Public synthetic withdrawal', withdrawnAt: hostIdentity.now() }));
  const eligibility = value(await evaluator.runtime.readCheckEligibility(checked.result.checkId));
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.recheckRequired, true);
  assert.equal(eligibility.tomboInvalidationPending, false);
  const withdrawn = await sdk.session.status(req.taskId);
  assert.equal(withdrawn.state.evidence[0].validity, 'withdrawn');
  assert.equal(withdrawn.understandingStatus.canReportCompletion, false);
  assert.equal(withdrawn.state.claims[0].assessments[0].verdict, 'refutes');
});

test('a strict SDK money cap remains present and blocked rather than being removed', { timeout: 30000 }, async () => {
  const sdk = await sdkOptions();
  const options = { ...sdk.options, task: { ...sdk.options.task, budget: { ...sdk.options.task.budget, maxCostYen: 0 } } };
  const { mkdtemp } = await import('node:fs/promises');
  options.taskDirectory = await mkdtemp(join(options.allowedTaskRoot, 'semevolve-e-sdk-cap-'));
  const session = await createManagedSession(options);
  await assert.rejects(session.inspect(input()), /budget_accounting_unavailable/);
  assert.equal(options.task.budget.maxCostYen, 0);
  const marker = JSON.parse(await readFile(join(options.taskDirectory, '.bridge-binding.json'), 'utf8'));
  assert.equal(marker.task.budget.maxCostYen, 0);
});

test('an existing SDK session lock remains untouched and reconciliation stays unknown', { timeout: 30000 }, async () => {
  const sdk = await sdkOptions();
  const bridge = createTomboBridge({ store: createMemoryTaskStore(), session: sdk.session, sdkCommit: sdk.commit });
  const req = update(value(await bridge.inspect(input())).reference);
  value(await bridge.receive(req));
  const lock = join(sdk.taskDirectory, '.session/tombo-session.jsonl.lock');
  const marker = 'PUBLIC-SYNTHETIC-EXISTING-LOCK';
  await writeFile(lock, marker, { flag: 'wx' });
  const result = value(await bridge.reconcile(req));
  assert.equal(result.kind, 'pending');
  assert.match(result.reason, /session lock|owns the session/);
  assert.equal(await readFile(lock, 'utf8'), marker);
});
