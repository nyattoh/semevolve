import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileTaskStore } from '@semevolve/core';
import { take, rows } from '../../mechanism/storage/fixtures.mjs';
import { assertTerminal, preserve } from '../../mechanism/storage/supersession-fixtures.mjs';
import { start, recoverDead } from './client.mjs';

const cases = [
  ['storage.catch_up.intent', 'journal_before_append', 'old'],
  ['storage.catch_up.intent', 'journal_partial', 'corrupt'],
  ['storage.catch_up.intent', 'tail_before_switch', 'corrupt'],
  ['storage.catch_up.intent', 'tail_after_switch', 'new'],
  ['storage.catch_up.intent', 'journal_committed', 'new'],
  ['storage.catch_up.checked', 'journal_before_append', 'new'],
  ['storage.catch_up.checked', 'journal_committed', 'done'],
];
for (const operation of ['copy', 'catch_up']) for (const legacy of [false, true]) for (const [kind, point, expected] of cases) test(`F2 file ${operation} legacy=${legacy} replacement kill ${kind}/${point}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-projection-replace-'));
  const a = await start(t, directory, legacy ? { legacyOperation: operation } : {});
  if (operation === 'catch_up') take(await a.call('prepare'));
  await a.call('arm', { kind: `storage.${operation}.intent`, point: 'journal_committed' }); void a.call(operation === 'copy' ? 'prepare' : 'catchUp');
  const first = await a.boundary; assert.equal(first.kind, `storage.${operation}.intent`); t.diagnostic(JSON.stringify(first)); await a.kill(); recoverDead(t, directory, a.child.pid);
  const b = await start(t, directory, { seed: false }); const before = await b.call('snapshot'); const old = rows(before, 'storage.migrations')[0];
  assert.equal(old.phase, `${operation}_pending`); take(await b.call('reconcile')); assert.deepEqual(await b.call('snapshot'), before);
  await b.call('arm', { kind, point }); void b.call('catchUp');
  const reached = await b.boundary; assert.equal(reached.kind, kind); assert.equal(reached.point, point); t.diagnostic(JSON.stringify(reached)); await b.kill(); recoverDead(t, directory, b.child.pid);
  if (expected === 'corrupt') { await assert.rejects(openFileTaskStore(directory, { mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'] }), /journal|tail|record|JSON|parse/i); return; }
  const c = await start(t, directory, { seed: false }); const reopened = await c.call('snapshot'); const state = rows(reopened, 'storage.migrations')[0];
  preserve(before, reopened); take(await c.call('reconcile')); assert.deepEqual(await c.call('snapshot'), reopened);
  if (expected === 'old') { assert.equal(state.intent, old.intent); assert.equal(rows(reopened, 'storage.operations').filter(r => r.kind === 'not_applied' && r.executionId === old.intent).length, 0); }
  else { assertTerminal(reopened, old, state.intent); assert.equal(state.phase, expected === 'done' ? 'checked' : 'catch_up_pending'); }
  if (expected !== 'done') take(await c.call('catchUp'));
  take(await c.call('switch')); const final = await c.call('snapshot');
  assert.equal(rows(final, 'storage.operations').filter(r => r.kind === 'not_applied' && r.executionId === old.intent).length, 1);
  assert.equal(rows(final, 'storage.operations').some(r => r.kind === 'receipt' && r.executionId === old.intent), false);
  assert.deepEqual(take(await c.call('retrieve', { mappingId: 'M2' })).map(u => u.source.messageId), ['message-1']);
  t.diagnostic(JSON.stringify({ phase: 'reopened', oldIntent: old.intent, snapshotDigest: final.digest, head: take(await c.call('head')) }));
  await c.close(); const d = await start(t, directory, { seed: false }); assert.deepEqual(await d.call('snapshot'), final); await d.close();
});
