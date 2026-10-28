import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFileTaskStore, inspectFileStoreOwner, recoverFileStoreOwner } from '@semevolve/core';
import { rows, take } from '../../mechanism/storage/fixtures.mjs';
import { start, recoverDead } from './client.mjs';

const collections = ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'];
const cases = [
  { name: 'copy intent', kind: 'storage.copy.intent', point: 'journal_committed', action: 'prepare', phase: 'copy_pending' },
  { name: 'before copy batch', kind: 'storage.copy.checked', point: 'journal_before_append', action: 'prepare', phase: 'copy_pending' },
  { name: 'after copy batch', kind: 'storage.copy.checked', point: 'journal_committed', action: 'prepare', phase: 'shadow_ready' },
  { name: 'catch-up intent', setup: 'prepare', kind: 'storage.catch_up.intent', point: 'journal_committed', action: 'catchUp', phase: 'catch_up_pending' },
  { name: 'catch-up delta', setup: 'prepare', kind: 'storage.catch_up.checked', point: 'journal_committed', action: 'catchUp', phase: 'checked' },
  { name: 'switch intent', setup: 'checked', kind: 'storage.switch.intent', point: 'journal_committed', action: 'switch', phase: 'switch_pending' },
  { name: 'partial switch journal', setup: 'checked', kind: 'storage.switch.committed', point: 'journal_partial', action: 'switch', corrupt: true },
  { name: 'switch before tail', setup: 'checked', kind: 'storage.switch.committed', point: 'tail_before_switch', action: 'switch', corrupt: true },
  { name: 'switch after tail', setup: 'checked', kind: 'storage.switch.committed', point: 'tail_after_switch', action: 'switch', phase: 'switched' },
  { name: 'switch after commit before response', setup: 'checked', kind: 'storage.switch.committed', point: 'journal_committed', action: 'switch', phase: 'switched' },
  { name: 'restore intent', setup: 'switched', kind: 'storage.restore.intent', point: 'journal_committed', action: 'restore', phase: 'restore_pending' },
  { name: 'restore head before response', setup: 'switched', kind: 'storage.restore.committed', point: 'journal_committed', action: 'restore', phase: 'restored' },
];

for (const c of cases) test(`L5 durable process kill at ${c.name}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-storage-kill-'));
  const a = await start(t, directory);
  if (c.setup === 'prepare') take(await a.call('prepare'));
  if (c.setup === 'checked' || c.setup === 'switched') await a.call('checked');
  if (c.setup === 'switched') { take(await a.call('switch')); take(await a.call('write')); }
  const before = await a.call('snapshot'); const oldHead = take(await a.call('head'));
  await a.call('arm', { kind: c.kind, point: c.point });
  void a.call(c.action);
  const boundary = await a.boundary;
  assert.equal(boundary.kind, c.kind); assert.equal(boundary.point, c.point); assert.equal(boundary.pid, a.child.pid);
  t.diagnostic(JSON.stringify(boundary));
  assert.throws(() => recoverFileStoreOwner(directory, boundary.owner.token), /live|alive|running|owner/iu);
  await a.kill(); recoverDead(t, directory, a.child.pid);
  if (c.corrupt) {
    await assert.rejects(openFileTaskStore(directory, { mutableCollections: collections }), /journal|tail|JSON|record|parse/iu);
    t.diagnostic(JSON.stringify({ phase: 'open-refused', point: c.point, snapshotDigestBefore: before.digest }));
    return;
  }
  const b = await start(t, directory, { seed: false });
  const snapshot = await b.call('snapshot'); const state = rows(snapshot, 'storage.migrations')[0];
  assert.equal(state.phase, c.phase);
  const reconciled = take(await b.call('reconcile'));
  const receipts = rows(snapshot, 'storage.operations').filter(o => o.kind === 'receipt');
  if (c.phase.endsWith('_pending')) {
    assert.notEqual(reconciled.pendingOperation, null, 'L5_PENDING_NOT_SUCCESS');
    assert.deepEqual(take(await b.call('head')), oldHead);
    assert.equal(receipts.some(r => r.executionId === reconciled.pendingOperation.executionId), false);
  } else {
    assert.equal(reconciled.pendingOperation, null);
    assert.ok(receipts.some(r => r.executionId === state.intent));
    if (c.phase === 'switched') { assert.equal(take(await b.call('head')).mappingId, 'M2'); assert.equal(reconciled.switchedAtRevision, snapshot.revision); }
    else if (c.phase === 'restored') {
      assert.equal(take(await b.call('head')).mappingId, 'M1'); assert.equal(reconciled.restoration.verified, true);
      assert.deepEqual(take(await b.call('retrieve')).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
    } else assert.deepEqual(take(await b.call('head')), oldHead);
  }
  assert.deepEqual(rows(snapshot, 'host.tasks'), rows(before, 'host.tasks'));
  assert.deepEqual(rows(snapshot, 'storage.originals'), rows(before, 'storage.originals'));
  t.diagnostic(JSON.stringify({ phase: 'reopened', pid: b.child.pid, snapshotDigest: snapshot.digest, head: take(await b.call('head')), receiptCount: receipts.length }));
  await b.close();
  assert.throws(() => inspectFileStoreOwner(directory), { code: 'ENOENT' });
});

test('L5 durable restore retains both generations and all receipts on another reopen', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-storage-restore-'));
  const a = await start(t, directory); await a.call('checked'); take(await a.call('switch')); take(await a.call('write')); take(await a.call('restore'));
  const final = await a.call('snapshot'); await a.close();
  const b = await start(t, directory, { seed: false }); assert.deepEqual(await b.call('snapshot'), final);
  assert.deepEqual(take(await b.call('retrieve')).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
  assert.equal(rows(final, 'storage.operations').filter(o => o.kind === 'receipt' && ['switch', 'restore'].includes(o.operation)).length, 2);
  await b.close();
});
