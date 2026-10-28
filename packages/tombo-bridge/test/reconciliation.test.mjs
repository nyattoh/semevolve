import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { hostIdentity } from '@semevolve/core';
import { createManagedSession, createTomboBridge } from '@semevolve/tombo-bridge';
import { commit, fixture, input, update, value } from './support/fixture.mjs';

test('AT10 receives one observation, reconciles actual execution proof and replays the exact summary', { timeout: 30000 }, async () => {
  const f = fixture();
  const inspected = await f.bridge.inspect(input());
  assert.equal(inspected.ok ? inspected.value.reference.sessionRef : inspected.error.code, 'public-session');
  const req = update(value(inspected).reference);
  assert.deepEqual(value(await f.bridge.receive(req)), { executionId: req.executionId });
  assert.equal(f.state.session.pendingUpdates.length, 1);
  const reconciled = value(await f.bridge.reconcile(req));
  assert.equal(reconciled.kind, 'reconciled');
  assert.equal(reconciled.summary.canReportCompletion, false);
  assert.deepEqual(reconciled.summary.unresolvedGapRefs, ['public-gap']);
  const reopened = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit });
  assert.deepEqual(value(await reopened.receive(req)), { executionId: req.executionId });
  assert.deepEqual(value(await reopened.reconcile(req)), reconciled);
  assert.deepEqual(f.calls, { receive: 1, apply: 1 });
  const changed = structuredClone(req); changed.payload.observations[0].elapsedMs = 3; changed.inputDigest = hostIdentity.digest(changed.payload);
  assert.equal((await reopened.receive(changed)).error.code, 'id_collision');
});

for (const fault of ['receipt-only', 'wrong-session', 'wrong-hash', 'pending-assessment', 'accounting-uncertain', 'discarded']) test(`AT20 ${fault} remains pending`, { timeout: 30000 }, async () => {
  const f = fixture();
  const req = update(value(await f.bridge.inspect(input())).reference);
  value(await f.bridge.receive(req));
  f.session.apply = async () => {
    f.state.state.revision += 5;
    if (fault === 'wrong-session') f.state.session.binding.sessionId = 'other-session';
    if (fault === 'wrong-hash') f.state.state.appliedExecutions = [{ executionId: req.executionId, payloadHash: 'a'.repeat(64) }];
    if (fault === 'pending-assessment') f.state.state.pendingAssessmentExecutionIds = [req.executionId];
    if (fault === 'accounting-uncertain') f.state.session.accountingUncertain = true;
    if (fault === 'discarded') { f.state.session.updates[0].status = 'discarded_unassessed'; f.state.session.updates[0].appliedRevision = null; }
    return structuredClone(f.state);
  };
  const result = value(await f.bridge.reconcile(req));
  assert.equal(result.kind, 'pending');
  assert.equal(typeof result.reason, 'string');
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'tombo.reconciliation-results').length, 0);
});

test('SDK completion true with an optional gap is preserved without issuing permission', { timeout: 30000 }, async () => {
  const f = fixture();
  f.state.state.gaps[0].importance = 'optional';
  f.state.understandingStatus.canReportCompletion = true;
  const summary = value(await f.bridge.inspect(input()));
  assert.equal(summary.canReportCompletion, true);
  assert.deepEqual(summary.unresolvedGapRefs, ['public-gap']);
  assert.equal(Object.hasOwn(summary, 'authorised'), false);
});

test('concurrent reconciliation claims SDK application once and preserves an unknown outcome', { timeout: 30000 }, async () => {
  const f = fixture({ maxAttempts: 64 });
  const req = update(value(await f.bridge.inspect(input())).reference);
  value(await f.bridge.receive(req));
  const another = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit, maxAttempts: 64 });
  const results = await Promise.all([f.bridge.reconcile(req), another.reconcile(req)]);
  assert.equal(results.every(r => r.ok), true);
  assert.equal(results.some(r => r.value.kind === 'reconciled'), true);
  assert.equal(f.calls.apply, 1);
  const saved = value(await f.bridge.reconcile(req));
  assert.equal(saved.kind, 'reconciled');
  assert.equal(f.state.state.appliedExecutions.length, 1);
});

test('caller mutation cannot change the pending request committed before delivery', { timeout: 30000 }, async () => {
  const f = fixture();
  const req = update(value(await f.bridge.inspect(input())).reference);
  const original = structuredClone(req);
  const pending = f.bridge.receive(req);
  req.executionId = 'forged'; req.payload.observations[0].toolCalls = 99;
  assert.deepEqual(value(await pending), { executionId: original.executionId });
  assert.equal(f.state.session.updates[0].observations[0].toolCalls, 1);
  assert.equal(value(await f.store.snapshot()).entries.filter(e => e.key.collection === 'tombo.pending').length, 1);
});

for (const variant of ['equal', 'trailing-separator', 'dot-equivalent', 'runtime-parent', 'task-parent', 'allowed-equal', 'outside', 'sibling-control']) test(`E-B3 dedicated session boundary ${variant}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'semevolve-e-boundary-'));
  let runtime = join(root, 'runtime'), directory = join(root, 'task'), allowed = root;
  if (variant === 'equal') directory = runtime;
  if (variant === 'trailing-separator') directory = runtime + sep;
  if (variant === 'dot-equivalent') directory = runtime + sep + '.';
  if (variant === 'runtime-parent') directory = join(runtime, 'task');
  if (variant === 'task-parent') runtime = join(directory, 'runtime');
  if (variant === 'allowed-equal') directory = allowed;
  if (variant === 'outside') allowed = join(root, 'allowed');
  for (const path of [runtime, directory, allowed]) await mkdir(path, { recursive: true });
  const runtimeBefore = await readdir(runtime);
  const taskBefore = await readdir(directory);
  await assert.rejects(createManagedSession({ runtimeRoot: runtime, taskDirectory: directory, allowedTaskRoot: allowed, task: {}, taskClock: {}, readerId: 'evaluator', evidenceMetadata: [], propose: () => ({}) }), error => {
    if (variant === 'sibling-control') {
      assert.equal(error.code, 'ENOENT');
      assert.ok(error.path.endsWith('LICENSE'));
    } else assert.equal(error.message, 'Managed sessions require a separate dedicated temporary task directory');
    return true;
  });
  assert.deepEqual(await readdir(runtime), runtimeBefore);
  assert.deepEqual(await readdir(directory), taskBefore);
});
