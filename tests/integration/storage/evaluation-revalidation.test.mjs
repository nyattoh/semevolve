import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFileTaskStore } from '@semevolve/core';
import { rows, take, reject } from '../../mechanism/storage/fixtures.mjs';
import { start, recoverDead } from './client.mjs';

const entrypoint = new URL('./evaluation-process.mjs', import.meta.url);
const launch = (t, directory, options = {}) => start(t, directory, options, entrypoint);
for (const [kind, point, committed, corrupt] of [
  ['canonical', 'journal_committed', false, false],
  ['storage.inspected', 'journal_before_append', false, false],
  ['storage.inspected', 'journal_partial', false, true],
  ['storage.inspected', 'tail_before_switch', false, true],
  ['storage.inspected', 'tail_after_switch', true, false],
  ['storage.inspected', 'journal_committed', true, false],
]) test(`L-rem recording evaluation kill ${kind}/${point}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-recording-evaluation-'));
  const a = await launch(t, directory); const before = await a.call('snapshot');
  await a.call('arm', { kind, point }); void a.call('inspect');
  const boundary = await a.boundary; assert.equal(boundary.kind, kind); assert.equal(boundary.point, point); t.diagnostic(JSON.stringify(boundary));
  await a.kill(); recoverDead(t, directory, a.child.pid);
  if (corrupt) { await assert.rejects(openFileTaskStore(directory, { mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'] }), /journal|tail|record|JSON|parse/i); return; }
  const b = await launch(t, directory, { seed: false }); const reopened = await b.call('snapshot');
  assert.equal(rows(reopened, 'synthetic.canonical-storage').length, 1);
  assert.equal(rows(reopened, 'storage.inspections').length, committed ? 1 : 0);
  assert.deepEqual(rows(reopened, 'host.tasks'), rows(before, 'host.tasks'));
  assert.equal(rows(reopened, 'storage.conformance').length, 0);
  await b.call('certify'); take(await b.call('store')); assert.deepEqual(take(await b.call('retrieve')).map(u => u.source.messageId), ['message-1']);
  const valid = await b.call('snapshot'); await b.call('withdraw');
  reject(await b.call('retrieve'), 'unavailable'); reject(await b.call('store'), 'unavailable');
  const withdrawn = await b.call('snapshot'); assert.deepEqual(rows(withdrawn, 'storage.inspections'), rows(valid, 'storage.inspections'));
  t.diagnostic(JSON.stringify({ phase: 'reopened', pid: b.child.pid, digest: withdrawn.digest, canonicalCount: rows(withdrawn, 'synthetic.canonical-storage').length }));
  await b.close(); const c = await launch(t, directory, { seed: false }); assert.deepEqual(await c.call('snapshot'), withdrawn); reject(await c.call('retrieve'), 'unavailable'); await c.close();
});

test('L-rem file comparison refuses changed input and retains canonical result without adoption', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-changed-evaluation-')); const a = await launch(t, directory);
  await a.call('change-during-check'); reject(await a.call('compare'), 'unavailable'); const before = await a.call('snapshot');
  assert.equal(rows(before, 'storage.comparisons').length, 0); assert.equal(rows(before, 'storage.inspections').length, 0); assert.equal(rows(before, 'synthetic.canonical-storage').length, 2);
  await a.close(); const b = await launch(t, directory, { seed: false }); assert.deepEqual(await b.call('snapshot'), before); await b.close();
});

test('L-rem file copy catch-up switch restore accept canonical recording and retain new originals', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-recording-migration-')); const a = await launch(t, directory);
  const result = take(await a.call('migration')); assert.equal(result.restoration.verified, true); assert.equal(take(await a.call('head')).mappingId, 'M1');
  assert.deepEqual(take(await a.call('retrieve')).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
  const before = await a.call('snapshot'); await a.close(); const b = await launch(t, directory, { seed: false });
  assert.deepEqual(await b.call('snapshot'), before); assert.deepEqual(take(await b.call('retrieve')).map(u => u.source.messageId).sort(), ['message-1', 'message-2']); await b.close();
});
