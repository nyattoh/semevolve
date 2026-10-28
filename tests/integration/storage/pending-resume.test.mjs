import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { take, rows } from '../../mechanism/storage/fixtures.mjs';
import { start, recoverDead } from './client.mjs';

async function stopAt(t, client, action, kind, point = 'journal_committed') {
  await client.call('arm', { kind, point });
  void client.call(action);
  const boundary = await client.boundary;
  assert.equal(boundary.kind, kind); assert.equal(boundary.point, point);
  assert.equal(boundary.pid, client.child.pid);
  t.diagnostic(JSON.stringify(boundary));
  await client.kill();
}
function preserved(before, after) {
  for (const entry of before.entries.filter(e => ['storage.originals', 'host.tasks', 'storage.operations', 'storage.inspections'].includes(e.key.collection))) {
    assert.deepEqual(after.entries.find(e => e.key.collection === entry.key.collection && e.key.id === entry.key.id), entry);
  }
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
}

for (const operation of ['switch', 'restore']) for (const boundary of ['intent', 'resume-before-commit', 'resume-after-commit', 'supersede']) {
  test(`B2 file ${operation} resumes after kill at ${boundary}`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'semevolve-storage-pending-'));
    const a = await start(t, directory);
    await a.call('checked');
    if (operation === 'restore') take(await a.call('switch'));
    const initial = await a.call('snapshot'); const sourceHead = take(await a.call('head'));
    await stopAt(t, a, operation, `storage.${operation}.intent`);
    recoverDead(t, directory, a.child.pid);
    const b = await start(t, directory, { seed: false });
    const pending = await b.call('snapshot'); const state = rows(pending, 'storage.migrations')[0];
    assert.equal(state.phase, `${operation}_pending`);
    const intent = state.intent;
    assert.equal(take(await b.call('reconcile')).pendingOperation.executionId, intent);
    assert.deepEqual(await b.call('snapshot'), pending);
    assert.deepEqual(take(await b.call('head')), sourceHead);
    let finalClient = b;
    if (boundary === 'resume-before-commit' || boundary === 'resume-after-commit') {
      await stopAt(t, b, operation, `storage.${operation}.committed`, boundary === 'resume-before-commit' ? 'journal_before_append' : 'journal_committed');
      recoverDead(t, directory, b.child.pid);
      finalClient = await start(t, directory, { seed: false });
      const reopened = await finalClient.call('snapshot');
      const observed = take(await finalClient.call('reconcile'));
      assert.deepEqual(await finalClient.call('snapshot'), reopened);
      if (boundary === 'resume-before-commit') assert.equal(observed.pendingOperation.executionId, intent);
      else assert.equal(observed.pendingOperation, null);
    }
    if (boundary === 'supersede') {
      take(await b.call('write'));
      const nextAction = operation === 'switch' ? 'catchUp' : 'restore';
      await stopAt(t, b, nextAction, `storage.${operation === 'switch' ? 'catch_up' : 'restore'}.intent`);
      recoverDead(t, directory, b.child.pid);
      finalClient = await start(t, directory, { seed: false });
      const superseded = await finalClient.call('snapshot');
      const next = rows(superseded, 'storage.migrations')[0];
      const terminal = rows(superseded, 'storage.operations').find(r => r.kind === 'not_applied' && r.executionId === intent);
      assert.equal(terminal.successor, next.intent);
      assert.equal(Object.hasOwn(terminal, 'pass'), false);
      assert.deepEqual(take(await finalClient.call('head')), sourceHead);
      assert.notEqual(take(await finalClient.call('reconcile')).pendingOperation, null);
      assert.deepEqual(await finalClient.call('snapshot'), superseded);
      if (operation === 'switch') take(await finalClient.call('catchUp'));
    }
    if (boundary !== 'resume-after-commit') take(await finalClient.call(operation));
    const final = await finalClient.call('snapshot');
    preserved(initial, final); preserved(pending, final);
    const done = take(await finalClient.call('reconcile')); assert.equal(done.pendingOperation, null);
    assert.deepEqual(await finalClient.call('snapshot'), final);
    const receipts = rows(final, 'storage.operations').filter(r => r.kind === 'receipt' && r.operation === operation);
    assert.equal(receipts.length, 1);
    if (boundary !== 'supersede') assert.equal(receipts[0].executionId, intent);
    else assert.notEqual(receipts[0].executionId, intent);
    const mappingId = operation === 'switch' ? 'M2' : 'M1';
    assert.equal(take(await finalClient.call('head')).mappingId, mappingId);
    assert.deepEqual(take(await finalClient.call('retrieve', { mappingId })).map(u => u.source.messageId).sort(), boundary === 'supersede' ? ['message-1', 'message-2'] : ['message-1']);
    t.diagnostic(JSON.stringify({ phase: 'resumed', pid: finalClient.child.pid, oldIntent: intent, receipt: receipts[0], snapshotDigest: final.digest, head: take(await finalClient.call('head')) }));
    await finalClient.close();
    const c = await start(t, directory, { seed: false });
    assert.deepEqual(await c.call('snapshot'), final);
    assert.deepEqual(take(await c.call('reconcile')), done);
    await c.close();
  });
}
