import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileTaskStore } from '@semevolve/core';
import { rows, take } from '../../mechanism/storage/fixtures.mjs';
import { assertTerminal, preserve } from '../../mechanism/storage/supersession-fixtures.mjs';
import { start, recoverDead } from './client.mjs';

const cases = [
  ['storage.switch.intent', 'journal_before_append', 'old'],
  ['storage.switch.intent', 'journal_partial', 'corrupt'],
  ['storage.switch.intent', 'tail_before_switch', 'corrupt'],
  ['storage.switch.intent', 'tail_after_switch', 'new'],
  ['storage.switch.intent', 'journal_committed', 'new'],
  ['storage.switch.committed', 'journal_before_append', 'new'],
  ['storage.switch.committed', 'journal_committed', 'done'],
];
for (const legacy of [false, true]) for (const [kind, point, expected] of cases) test(`F1 file legacy=${legacy} renewal kill ${kind}/${point}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-authority-'));
  const a = await start(t, directory, legacy ? { legacyOperation: 'switch' } : {}); await a.call('checked');
  await a.call('arm', { kind: 'storage.switch.intent', point: 'journal_committed' }); void a.call('switch');
  const first = await a.boundary; t.diagnostic(JSON.stringify(first)); await a.kill(); recoverDead(t, directory, a.child.pid);
  const b = await start(t, directory, { seed: false }); const before = await b.call('snapshot'); const old = rows(before, 'storage.migrations')[0];
  assert.deepEqual(take(await b.call('reconcile')), old.migration); assert.deepEqual(await b.call('snapshot'), before);
  await b.call('authority'); await b.call('arm', { kind, point }); void b.call('switch');
  const reached = await b.boundary; assert.equal(reached.kind, kind); assert.equal(reached.point, point); t.diagnostic(JSON.stringify(reached));
  await b.kill(); recoverDead(t, directory, b.child.pid);
  if (expected === 'corrupt') { await assert.rejects(openFileTaskStore(directory, { mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'] }), /journal|tail|record|JSON|parse/i); return; }
  const c = await start(t, directory, { seed: false }); const reopened = await c.call('snapshot'); const state = rows(reopened, 'storage.migrations')[0];
  preserve(before, reopened); take(await c.call('reconcile')); assert.deepEqual(await c.call('snapshot'), reopened);
  if (expected === 'old') { assert.equal(state.intent, old.intent); assert.equal(rows(reopened, 'storage.operations').filter(r => r.kind === 'not_applied').length, 0); }
  else { assertTerminal(reopened, old, state.intent); assert.equal(state.phase, expected === 'done' ? 'switched' : 'switch_pending'); }
  if (expected !== 'done') { assert.equal(take(await c.call('head')).mappingId, 'M1'); take(await c.call('switch')); }
  const final = await c.call('snapshot'); const done = rows(final, 'storage.migrations')[0]; assertTerminal(final, old, done.intent);
  assert.deepEqual(take(await c.call('retrieve', { mappingId: 'M2' })).map(u => u.source.messageId), ['message-1']);
  t.diagnostic(JSON.stringify({ phase: 'reopened', oldIntent: old.intent, newIntent: done.intent, snapshotDigest: final.digest, head: take(await c.call('head')) }));
  await c.close(); const d = await start(t, directory, { seed: false }); assert.deepEqual(await d.call('snapshot'), final); await d.close();
});
