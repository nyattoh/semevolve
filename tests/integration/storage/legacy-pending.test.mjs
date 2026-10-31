import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rows, take, reject } from '../../mechanism/storage/fixtures.mjs';
import { start, recoverDead } from './client.mjs';

for (const operation of ['switch', 'restore']) for (const delta of [false, true]) test(`B2 legacy file ${operation} survives kill and reopen with delta=${delta}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-storage-legacy-'));
  const a = await start(t, directory, { legacyOperation: operation });
  await a.call('checked'); if (operation === 'restore') take(await a.call('switch'));
  const head = take(await a.call('head'));
  await a.call('arm', { kind: `storage.${operation}.intent`, point: 'journal_committed' });
  void a.call(operation); const boundary = await a.boundary;
  assert.equal(boundary.kind, `storage.${operation}.intent`); assert.equal(boundary.pid, a.child.pid);
  t.diagnostic(JSON.stringify(boundary)); await a.kill(); recoverDead(t, directory, a.child.pid);
  const b = await start(t, directory, { seed: false });
  const before = await b.call('snapshot'); const old = rows(before, 'storage.migrations')[0];
  assert.equal(old.phase, `${operation}_pending`);
  const originalIntent = before.entries.find(e => e.key.id === `${old.intent}/intent`);
  assert.equal(Object.hasOwn(originalIntent.value, 'inspectionDigest'), false);
  assert.deepEqual(take(await b.call('reconcile')), old.migration);
  assert.deepEqual(await b.call('snapshot'), before); assert.deepEqual(take(await b.call('head')), head);
  if (delta) {
    take(await b.call('write'));
    if (operation === 'switch') { reject(await b.call('switch'), 'unavailable'); take(await b.call('catchUp')); }
  }
  take(await b.call(operation));
  const after = await b.call('snapshot'); const state = rows(after, 'storage.migrations')[0];
  assert.equal(state.phase, operation === 'switch' ? 'switched' : 'restored');
  assert.deepEqual(after.entries.find(e => e.key.id === `${old.intent}/intent`), originalIntent);
  assert.deepEqual(rows(after, 'host.tasks'), rows(before, 'host.tasks'));
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  for (const entry of before.entries.filter(e => e.key.collection === 'storage.originals' || e.key.collection === 'storage.operations')) assert.deepEqual(after.entries.find(e => e.key.collection === entry.key.collection && e.key.id === entry.key.id), entry);
  const receipts = rows(after, 'storage.operations').filter(r => r.kind === 'receipt' && r.operation === operation);
  assert.equal(receipts.length, 1);
  if (delta) {
    assert.notEqual(state.intent, old.intent);
    const terminal = rows(after, 'storage.operations').find(r => r.kind === 'not_applied' && r.executionId === old.intent);
    assert.ok(terminal); assert.equal(Object.hasOwn(terminal, 'pass'), false);
  } else assert.equal(state.intent, old.intent);
  const mappingId = operation === 'switch' ? 'M2' : 'M1';
  assert.deepEqual(take(await b.call('retrieve', { mappingId })).map(u => u.source.messageId).sort(), delta ? ['message-1', 'message-2'] : ['message-1']);
  t.diagnostic(JSON.stringify({ phase: 'legacy-resumed', pid: b.child.pid, oldIntent: old.intent, newIntent: state.intent, snapshotDigest: after.digest, head: take(await b.call('head')), receipts }));
  await b.close(); const c = await start(t, directory, { seed: false });
  assert.deepEqual(await c.call('snapshot'), after); assert.equal(take(await c.call('reconcile')).pendingOperation, null);
  await c.close();
});
