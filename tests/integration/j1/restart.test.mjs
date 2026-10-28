import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { inspectFileStoreOwner, recoverFileStoreOwner } from '@semevolve/core';
import { rows, take, taskId, initialTime, deadline } from './compose.mjs';

async function start(t, directory, options) {
  const child = fork(new URL('./process.mjs', import.meta.url), [directory, JSON.stringify(options)], { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 30000 });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', () => {});
  let ready;
  let boundary;
  const prepared = new Promise(resolve => { ready = resolve; });
  const atBoundary = new Promise(resolve => { boundary = resolve; });
  const exited = once(child, 'exit');
  child.on('message', message => {
    if (message.event === 'ready') ready(message);
    else if (message.event === 'boundary') boundary(message);
    else if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    }
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const event = await Promise.race([prepared, exited.then(([code, signal]) => { throw new Error(`Child startup failed: ${code}/${signal}: ${stderr}`); })]);
  assert.equal(event.pid, child.pid);
  t.diagnostic(JSON.stringify({ phase: 'ready', pid: child.pid, node: process.version, platform: process.platform }));
  const call = (action, input = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.send({ id, action, input });
  });
  return { child, call, atBoundary,
    async close() { assert.equal(await call('close'), true); const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null); t.diagnostic(JSON.stringify({ phase: 'closed', pid: child.pid, code, signal })); },
    async kill() { child.kill('SIGKILL'); const [code, signal] = await exited; t.diagnostic(JSON.stringify({ phase: 'killed', pid: child.pid, code, signal })); return { code, signal }; },
  };
}

const directory = () => mkdtemp(join(tmpdir(), 'semevolve-j1-process-'));
const sameCollections = (actual, expected, collections) => { for (const collection of collections) assert.deepEqual(rows(actual, collection), rows(expected, collection), collection); };

test('J1 restart redelivers a receipt-only message into a fresh process and preserves every domain', { timeout: 30000 }, async t => {
  const dir = await directory();
  const a = await start(t, dir, {});
  take(await a.call('stage'));
  const receipt = take(await a.call('dispatch'));
  const seeded = await a.call('snapshot');
  assert.deepEqual(rows(seeded, 'transport.inbox'), []);
  assert.deepEqual(rows(seeded, 'transport.applications'), []);
  assert.deepEqual(rows(seeded, 'transport.outbox')[0].receipt, receipt);
  t.diagnostic(JSON.stringify({ phase: 'receipt-only', pid: a.child.pid, digest: seeded.digest }));
  await a.close();
  const b = await start(t, dir, { seed: false, now: '2026-10-27T00:00:01.000Z' });
  assert.notEqual(a.child.pid, b.child.pid);
  assert.deepEqual(take(await b.call('receive')), []);
  const delivered = await b.call('deliverAndApply');
  assert.deepEqual(delivered.receipt, receipt);
  assert.equal(delivered.inbox.appliedAt, null);
  assert.equal(delivered.execution.invocation, 'started');
  assert.equal(delivered.execution.output, 'Public synthetic result');
  const applied = await b.call('snapshot');
  assert.equal(rows(applied, 'transport.outbox')[0].attempts, 2);
  assert.equal(rows(applied, 'transport.applications').length, 1);
  assert.equal(rows(applied, 'policy.starts').length, 1);
  assert.deepEqual(rows(applied, 'transport.state')[0].value, { output: 'Public synthetic result' });
  assert.equal(await b.call('count'), 1);
  t.diagnostic(JSON.stringify({ phase: 'applied', pid: b.child.pid, digest: applied.digest }));
  await b.close();
  const c = await start(t, dir, { seed: false, now: '2026-10-27T00:00:02.000Z' });
  const restored = await c.call('snapshot');
  assert.deepEqual(restored, applied);
  await c.call('deliverAndApply');
  const replay = take(await c.call('execute'));
  assert.equal(replay.invocation, 'replayed');
  assert.equal(replay.output, null);
  const final = await c.call('snapshot');
  sameCollections(final, applied, ['registry.versions', 'registry.status', 'registry.heads', 'registry.epochs', 'registry.task-epochs', 'policy.tasks', 'policy.starts', 'policy.reservations', 'policy.settlements', 'transport.messages', 'transport.inbox', 'transport.applications', 'transport.observations', 'transport.state']);
  assert.equal(final.events.filter(e => e.kind === 'transport.applied').length, 1);
  assert.equal(await c.call('count'), 0);
  assert.deepEqual(take(await c.call('receive')), []);
  t.diagnostic(JSON.stringify({ phase: 'replayed', pid: c.child.pid, digest: final.digest }));
  await c.close();
});

test('J1 reservation commit survives process kill with dead-owner recovery and no second invocation', { timeout: 30000 }, async t => {
  const dir = await directory();
  const a = await start(t, dir, { maxInvocations: 1 });
  await a.call('deliver');
  const before = await a.call('budget');
  await a.call('armReservation');
  void a.call('execute');
  const reached = await a.atBoundary;
  assert.equal(reached.point, 'journal_committed');
  assert.equal(reached.pid, a.child.pid);
  const owner = inspectFileStoreOwner(dir);
  assert.deepEqual(owner, reached.owner);
  assert.equal(owner.pid, a.child.pid);
  await a.kill();
  assert.deepEqual(inspectFileStoreOwner(dir), owner);
  recoverFileStoreOwner(dir, owner.token);
  const b = await start(t, dir, { seed: false, now: '2026-10-27T00:00:01.000Z' });
  const restored = await b.call('budget');
  assert.equal(restored.startedAt, before.startedAt);
  assert.equal(restored.deadline, before.deadline);
  assert.equal(restored.reservations.length, 1);
  assert.deepEqual(restored.reservations[0].outcome, { kind: 'pending' });
  assert.deepEqual(restored.usage.inputTokens, { kind: 'partial', knownSubtotal: 0, missingInvocationIds: ['j1-invocation'] });
  assert.equal(take(await b.call('execute')).invocation, 'replayed');
  assert.deepEqual(await b.call('execute', { invocationId: 'new-after-kill' }), { ok: false, error: { code: 'budget_refused', reason: 'exhausted' } });
  assert.equal(await b.call('count'), 0);
  const snapshot = await b.call('snapshot');
  assert.equal(rows(snapshot, 'policy.starts').length, 1);
  t.diagnostic(JSON.stringify({ phase: 'recovered-pending', pid: b.child.pid, digest: snapshot.digest, previousPid: owner.pid }));
  await b.close();
});

for (const [provider, reason] of [[{}, 'usage_not_fully_observed'], [{ scenario: 'timeout' }, 'timeout'], [{ scenario: 'response_lost' }, 'provider_response_lost']]) {
  test(`J1 unknown restart retains ${reason} without returning the reserved budget`, { timeout: 30000 }, async t => {
    const dir = await directory();
    const a = await start(t, dir, { maxInvocations: 1, provider });
    await a.call('deliver');
    const executed = take(await a.call('execute'));
    assert.equal(executed.reservation.outcome.kind, 'unknown_outcome');
    assert.equal(executed.reservation.outcome.reason, reason);
    const before = await a.call('budget');
    await a.close();
    const b = await start(t, dir, { seed: false });
    assert.deepEqual(await b.call('budget'), before);
    const replay = take(await b.call('execute'));
    assert.equal(replay.invocation, 'replayed');
    assert.equal(replay.output, null);
    assert.deepEqual(await b.call('execute', { invocationId: 'new-after-unknown' }), { ok: false, error: { code: 'budget_refused', reason: 'exhausted' } });
    assert.equal(await b.call('count'), 0);
    assert.deepEqual((await b.call('budget')).reservations, before.reservations);
    await b.close();
  });
}

for (const reason of ['expired', 'cancelled']) {
  test(`J1 resume in another process retains ${reason} and closed epoch refusal`, { timeout: 30000 }, async t => {
    const dir = await directory();
    const a = await start(t, dir, {});
    await a.call('deliverAndApply');
    take(await a.call('stage', { message_id: 'old-pending' }));
    take(await a.call('epoch', { held: ['old-pending'] }));
    if (reason === 'cancelled') take(await a.call('cancel'));
    const before = await a.call('budget');
    await a.close();
    const b = await start(t, dir, { seed: false, now: reason === 'expired' ? deadline : initialTime });
    const resumed = take(await b.call('resume'));
    assert.equal(resumed.task.stopReason, reason);
    assert.equal(resumed.task.startedAt, initialTime);
    assert.equal(resumed.task.deadline, deadline);
    assert.deepEqual((await b.call('budget')).usage, before.usage);
    assert.deepEqual(await b.call('dispatch', { messageId: 'old-pending' }), { ok: false, error: { code: 'transport_refused', reason: 'epoch_mismatch' } });
    assert.deepEqual(await b.call('execute', { invocationId: 'new-after-resume' }), { ok: false, error: { code: 'budget_refused', reason } });
    if (reason === 'cancelled') {
      const next = { message_id: 'new-epoch-message', epoch_id: 'j1-epoch-2', context_revision: 1 };
      await b.call('deliver', next);
      assert.deepEqual(await b.call('execute', { envelope: next, invocationId: 'new-epoch-invocation' }), { ok: false, error: { code: 'budget_refused', reason: 'cancelled' } });
    }
    assert.equal(await b.call('count'), 0);
    const snapshot = await b.call('snapshot');
    assert.equal(rows(snapshot, 'transport.messages').some(m => m.envelope.message_id === 'old-pending'), true);
    assert.equal(rows(snapshot, 'transport.inbox').some(m => m.messageId === 'old-pending'), false);
    t.diagnostic(JSON.stringify({ phase: 'resumed', reason, pid: b.child.pid, digest: snapshot.digest }));
    await b.close();
  });
}
