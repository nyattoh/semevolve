import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, hostIdentity } from '@semevolve/core';
import { createManagedSession, createTomboBridge } from '@semevolve/tombo-bridge';
import { commit, fixture, input, inspected, management, update, value } from './support/fixture.mjs';

test('a custom digest accepts its own inspection and update and rejects the default digest', { timeout: 30000 }, async () => {
  const digest = value => createHash('sha256').update(`configured:${canonicalJson(value)}`, 'utf8').digest('hex');
  const identity = { ...hostIdentity, digest };
  const f = fixture({ identity });
  const inspection = input();
  inspection.interpretation.inputDigest = identity.digest(inspection.interpretation.inputSnapshot);
  const accepted = value(await f.bridge.inspect(inspection));
  assert.equal(accepted.reference.sessionRef, 'public-session');
  const rejected = await f.bridge.inspect(input());
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'invalid_input');
  const payload = { id: 'custom-execution', source: { kind: 'tool', locator: 'public-synthetic-test' }, references: [], observations: [{ executionId: 'custom-execution', probeId: 'public-probe', outcome: 'unavailable', evidence: [], toolCalls: 1, elapsedMs: 1, costYen: null }] };
  f.session.receive = async updateRequest => {
    const receipt = { ...structuredClone(updateRequest.payload), payloadHash: identity.digest(updateRequest.payload), status: 'received_unassessed', appliedRevision: null };
    f.state.session.updates.push(receipt);
    f.state.session.pendingUpdates = [receipt];
    return structuredClone(f.state);
  };
  const received = await f.bridge.receive({ taskId: 'public-task', executionId: 'custom-execution', expected: accepted.reference, inputDigest: identity.digest(payload), payload });
  assert.deepEqual(value(received), { executionId: 'custom-execution' });
  const other = { ...payload, id: 'other-execution', observations: [{ ...payload.observations[0], executionId: 'other-execution' }] };
  const refused = await f.bridge.receive({ taskId: 'public-task', executionId: 'other-execution', expected: accepted.reference, inputDigest: hostIdentity.digest(other), payload: other });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error.code, 'invalid_input');
});

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

test('concurrent inspect returns the saved summary instead of colliding on retrievedAt', { timeout: 30000 }, async () => {
  let tick = 0;
  const identity = { ...hostIdentity, now: () => new Date(Date.UTC(2026, 9, 28, 0, 0, 0, tick++)).toISOString() };
  const f = fixture({ identity });
  let waiting = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pause = async () => {
    waiting += 1;
    if (waiting === 2) release();
    else await gate;
  };
  f.session.inspect = async () => { await pause(); return inspected(f.state); };
  f.session.status = async () => { await pause(); return structuredClone(f.state); };
  const bridge = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit, identity });
  const inspection = input();
  const [left, right] = await Promise.all([bridge.inspect(inspection), bridge.inspect(structuredClone(inspection))]);
  assert.equal(left.ok, true, JSON.stringify(left));
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.deepEqual(left.value, right.value);
  assert.equal(value(await f.store.snapshot()).entries.filter(entry => entry.key.collection === 'tombo.bindings').length, 1);
});

test('inspect creates the session on retry when the claim survived but activation never happened', { timeout: 30000 }, async () => {
  const f = fixture();
  const inspection = input();
  let activations = 0;
  f.session.inspect = async () => {
    activations += 1;
    if (activations === 1) throw new Error('crash before session creation');
    return inspected(f.state);
  };
  f.session.status = async () => null;
  const bridge = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit });
  const first = await bridge.inspect(inspection);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'unavailable');
  const second = await bridge.inspect(structuredClone(inspection));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.reference.sessionRef, 'public-session');
  assert.equal(activations, 2);
  assert.equal(value(await f.store.snapshot()).entries.filter(entry => entry.key.collection === 'tombo.bindings').length, 1);
});

test('inspect does not activate when status fails after a session may already exist', { timeout: 30000 }, async () => {
  const f = fixture();
  const inspection = input();
  let activations = 0;
  f.session.inspect = async () => { activations += 1; throw new Error('crash before session creation'); };
  f.session.status = async () => { throw new Error('temporary helper outage'); };
  const bridge = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit });
  const first = await bridge.inspect(inspection);
  assert.equal(first.ok, false);
  const second = await bridge.inspect(structuredClone(inspection));
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'unavailable');
  assert.match(second.error.reason, /temporary helper outage/);
  assert.equal(activations, 1);
  assert.equal(value(await f.store.snapshot()).entries.filter(entry => entry.key.collection === 'tombo.bindings').length, 0);
});

test('inspect does not record a partial activation as a completed inspection', { timeout: 30000 }, async () => {
  const f = fixture();
  const inspection = input();
  let activations = 0;
  let activated = false;
  const partial = management();
  partial.session.binding.sessionId = 'partial-session';
  partial.state.gaps = [{ id: 'partial-gap', importance: 'required', status: 'open' }];
  partial.understandingStatus.requiredGapIds = ['partial-gap'];
  f.session.inspect = async () => {
    activations += 1;
    if (activations === 1) {
      activated = true;
      throw new Error('crash after activate before inspect');
    }
    return inspected(f.state);
  };
  f.session.status = async () => activated ? structuredClone(partial) : null;
  const bridge = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit });
  const first = await bridge.inspect(inspection);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'unavailable');
  const second = await bridge.inspect(structuredClone(inspection));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.reference.sessionRef, 'public-session');
  assert.deepEqual(second.value.unresolvedGapRefs, ['public-gap']);
  assert.equal(activations, 2);
  const bindings = value(await f.store.snapshot()).entries.filter(entry => entry.key.collection === 'tombo.bindings');
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].value.sessionRef, 'public-session');
});

test('inspect binds an existing session instead of activating another one', { timeout: 30000 }, async () => {
  const f = fixture();
  const inspection = input();
  let bindings = 0;
  const store = {
    snapshot: () => f.store.snapshot(),
    async transact(batch) {
      if (batch.mutations.some(mutation => mutation.entry.key.collection === 'tombo.bindings') && bindings++ === 0) return { ok: false, error: { code: 'unavailable', reason: 'binding write failed' } };
      return f.store.transact(batch);
    },
    close: () => f.store.close(),
  };
  let activations = 0;
  f.session.inspect = async () => { activations += 1; return inspected(f.state); };
  const bridge = createTomboBridge({ store, session: f.session, sdkCommit: commit });
  const first = await bridge.inspect(inspection);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'unavailable');
  const second = await bridge.inspect(structuredClone(inspection));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(activations, 1);
  assert.equal(value(await f.store.snapshot()).entries.filter(entry => entry.key.collection === 'tombo.bindings').length, 1);
});

test('reconcile calls apply again when the claim survived but the SDK never applied the execution', { timeout: 30000 }, async () => {
  const f = fixture();
  const req = update(value(await f.bridge.inspect(input())).reference);
  value(await f.bridge.receive(req));
  const original = f.session.apply;
  let applies = 0;
  f.session.apply = async update => {
    applies += 1;
    if (applies === 1) throw new Error('helper failed before mutation');
    return original(update);
  };
  const first = value(await f.bridge.reconcile(req));
  assert.equal(first.kind, 'pending');
  assert.match(first.reason, /helper failed before mutation/);
  const second = value(await f.bridge.reconcile(req));
  assert.equal(second.kind, 'reconciled');
  assert.equal(applies, 2);
  assert.equal(f.state.state.appliedExecutions.length, 1);
  assert.equal(value(await f.bridge.reconcile(req)).kind, 'reconciled');
  assert.equal(applies, 2);
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'semevolve-e-boundary-')));
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
