import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { inspectFileStoreOwner, recoverFileStoreOwner } from '@semevolve/core';
import { task, initialTime, usage } from '../../mechanism/policy/fixtures.mjs';

async function launch(t, directory) {
  const child = fork(new URL('./process.mjs', import.meta.url), [directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const calls = new Map();
  const events = new Map();
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', message => {
    if (message.event) { events.get(message.event)?.(message); events.set(message.event, message); }
    else {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) call?.reject(new Error(message.error)); else call?.resolve(message.result);
    }
  });
  child.on('exit', (code, signal) => {
    for (const call of calls.values()) call.resolve({ stopped: true, code, signal });
    calls.clear();
    if (!events.has('ready')) events.get('ready')?.({ failed: true, stderr });
  });
  const event = name => new Promise(resolve => {
    const value = events.get(name);
    if (value && typeof value !== 'function') resolve(value); else events.set(name, resolve);
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const ready = await event('ready');
  assert.equal(ready.failed, undefined, stderr);
  return { child, event, rpc(action, input) {
    return new Promise((resolve, reject) => { const id = ++nextId; calls.set(id, { resolve, reject }); child.send({ id, action, input }); });
  }, async kill() { const exited = once(child, 'exit'); child.kill(); await exited; } };
}

async function directory() { return mkdtemp(join(tmpdir(), 'semevolve-policy-')); }
function recover(path) { const owner = inspectFileStoreOwner(path); recoverFileStoreOwner(path, owner.token); }

test('AT-12 real process restart retains start, deadline, usage and stop reason', { timeout: 15000 }, async t => {
  const path = await directory();
  const first = await launch(t, path);
  assert.equal((await first.rpc('register')).ok, true);
  assert.equal((await first.rpc('run')).ok, true);
  assert.equal((await first.rpc('cancel')).ok, true);
  const before = await first.rpc('snapshot');
  await first.rpc('close');
  const next = await launch(t, path);
  await next.rpc('time', { now: '2026-01-01T00:01:01.000Z' });
  const resumed = await next.rpc('resume');
  assert.equal(resumed.value.task.startedAt, initialTime);
  assert.equal(resumed.value.task.deadline, task().deadline);
  assert.equal(resumed.value.task.stopReason, 'cancelled');
  const after = await next.rpc('snapshot');
  assert.deepEqual(after.value.usage, before.value.usage);
  assert.deepEqual(after.value.reservations, before.value.reservations);
  assert.equal((await next.rpc('run', { invocationId: 'invocation-next', reservationId: 'reservation-next' })).ok, false);
  assert.equal(await next.rpc('count'), 0);
});

test('reservation committed before response loss stays pending after process kill and cannot invoke again', { timeout: 15000 }, async t => {
  const path = await directory();
  const first = await launch(t, path);
  const base = task();
  assert.equal((await first.rpc('register', { budget: { ...base.budget, maxInvocations: 1 } })).ok, true);
  await first.rpc('arm', { boundary: 'journal_committed' });
  const operation = first.rpc('run');
  await first.event('boundary');
  await first.kill();
  await operation;
  recover(path);
  const next = await launch(t, path);
  const saved = await next.rpc('snapshot');
  assert.equal(saved.value.reservations.length, 1);
  assert.equal(saved.value.reservations[0].outcome.kind, 'pending');
  assert.equal(saved.value.usage.costYen.kind, 'partial');
  assert.equal((await next.rpc('run')).value.invocation, 'replayed');
  assert.equal((await next.rpc('run', { invocationId: 'invocation-next', reservationId: 'reservation-next' })).ok, false);
  assert.equal(await next.rpc('count'), 0);
});

test('timeout accounting survives kill; a later observation settles once without re-execution', { timeout: 15000 }, async t => {
  const path = await directory();
  const first = await launch(t, path);
  await first.rpc('register');
  await first.rpc('provider', { scenario: 'timeout' });
  assert.equal((await first.rpc('run')).value.reservation.outcome.kind, 'unknown_outcome');
  assert.equal(await first.rpc('count'), 1);
  await first.kill();
  recover(path);
  const next = await launch(t, path);
  const outcome = { kind: 'completed', usage };
  assert.equal((await next.rpc('settle', { outcome })).ok, true);
  const before = await next.rpc('snapshot');
  assert.equal((await next.rpc('settle', { outcome })).ok, true);
  assert.deepEqual(await next.rpc('snapshot'), before);
  assert.equal(before.value.usage.costYen.kind, 'complete');
  assert.equal(before.value.usage.invocations, 1);
  assert.equal(await next.rpc('count'), 0);
});

test('file writer serves simultaneous execute calls with one actual fake invocation', { timeout: 15000 }, async t => {
  const path = await directory();
  const process = await launch(t, path);
  const base = task();
  await process.rpc('register', { budget: { ...base.budget, maxInvocations: 1 } });
  const results = await Promise.all([process.rpc('run'), process.rpc('run', { invocationId: 'invocation-rival', reservationId: 'reservation-rival' })]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(await process.rpc('count'), 1);
  assert.equal((await process.rpc('snapshot')).value.reservations.length, 1);
});
