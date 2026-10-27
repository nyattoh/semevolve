import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@semevolve/core';
import { batch, event, insert, replace, unwrap } from '../../support/persistence-conformance.mjs';
import { concurrentClients, workspace, writer } from '../../support/persistence-harness.mjs';

const options = { mutableCollections: ['state'] };

test('two real client processes contend for one revision through a real writer', { timeout: 20000 }, async t => {
  const directory = await workspace(t);
  const server = await writer(t, directory);
  assert.equal(server.ready.type, 'ready');
  const { pids, results } = await concurrentClients(t, server, [batch('a', 0, [insert('a')], [event('a')]), batch('b', 0, [insert('b')], [event('b')])]);
  assert.equal(new Set([...pids, server.ready.pid, process.pid]).size, 4);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.find(result => !result.ok).error, { code: 'revision_conflict', expected: 0, actual: 1 });
  assert.equal(unwrap(await server.request('snapshot')).events.length, 1);
  assert.equal(await server.request('close'), 'closed');
  await server.exit;
});

test('two real client processes cannot both reserve the last unit, a store CAS test only', { timeout: 20000 }, async t => {
  const directory = await workspace(t);
  const server = await writer(t, directory);
  unwrap(await server.request('transact', batch('seed', 0, [insert({ remaining: 1 })], [])));
  const reserve = id => batch(id, 1, [replace({ remaining: 0 }, { remaining: 1 }), insert({ outcome: 'pending', cost: null }, id, 'reservations')], [event(id)]);
  const { results } = await concurrentClients(t, server, [reserve('a'), reserve('b')]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(unwrap(await server.request('snapshot')).entries.filter(entry => entry.key.collection === 'reservations').length, 1);
  await server.request('close'); await server.exit;
});

for (const point of ['journal_before_append', 'journal_partial', 'journal_committed']) {
  test(`kill and restart at ${point} preserves the commit boundary`, { timeout: 20000 }, async t => {
    const directory = await workspace(t);
    const server = await writer(t, directory, point);
    const pending = server.request('transact', batch()).catch(error => ({ lost: error.message }));
    assert.equal((await server.receive(message => message.type === 'boundary')).point, point);
    await server.kill(); await pending;
    const before = await readFile(join(directory, 'journal.jsonl'));
    core.recoverFileStoreOwner(directory, server.ready.owner.token);
    if (point === 'journal_partial') {
      const refused = await writer(t, directory);
      assert.equal(refused.ready.type, 'open_failed');
      assert.match(refused.ready.failure, /Incomplete journal/u);
      await refused.exit;
      assert.deepEqual(await readFile(join(directory, 'journal.jsonl')), before);
      return;
    }
    const recovered = await writer(t, directory);
    assert.equal(recovered.ready.type, 'ready');
    const snapshot = unwrap(await recovered.request('snapshot'));
    assert.equal(snapshot.revision, point === 'journal_committed' ? 1 : 0);
    assert.deepEqual(await recovered.request('transact', batch()), { ok: true, value: { revision: 1 } });
    assert.equal(unwrap(await recovered.request('snapshot')).events.length, 1);
    assert.equal((await recovered.request('transact', batch('transaction-1', 0, [insert('different')]))).error.code, 'id_collision');
    await recovered.request('close'); await recovered.exit;
  });
}

for (const point of ['snapshot_before_switch', 'snapshot_after_switch']) {
  test(`kill and restart ${point} retains a consistent snapshot and journal suffix`, { timeout: 20000 }, async t => {
    const directory = await workspace(t);
    const seed = await core.openFileTaskStore(directory, options);
    unwrap(await seed.transact(batch()));
    unwrap(await seed.checkpoint());
    await seed.close();
    const server = await writer(t, directory, point);
    unwrap(await server.request('transact', batch('two', 1, [insert({ outcome: 'unknown_outcome', cost: null }, 'two')], [event('two')])));
    const pending = server.request('checkpoint').catch(error => ({ lost: error.message }));
    await server.receive(message => message.type === 'boundary');
    await server.kill(); await pending;
    core.recoverFileStoreOwner(directory, server.ready.owner.token);
    const recovered = await writer(t, directory);
    assert.equal(recovered.ready.type, 'ready');
    const snapshot = unwrap(await recovered.request('snapshot'));
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.events.length, 2);
    assert.deepEqual(snapshot.entries.find(entry => entry.key.id === 'two').value, { outcome: 'unknown_outcome', cost: null });
    assert.deepEqual(await recovered.request('transact', batch()), { ok: true, value: { revision: 1 } });
    if (point === 'snapshot_before_switch') assert.ok((await readdir(directory)).some(name => name.endsWith('.tmp')));
    await recovered.request('close'); await recovered.exit;
  });
}

test('live owner is never stolen and a second writer process is rejected', { timeout: 20000 }, async t => {
  const directory = await workspace(t);
  const first = await writer(t, directory);
  const second = await writer(t, directory);
  assert.equal(second.ready.type, 'open_failed');
  assert.equal((await second.exit)[0], 2);
  assert.throws(() => core.recoverFileStoreOwner(directory, first.ready.owner.token), /alive/u);
  assert.equal(core.inspectFileStoreOwner(directory).token, first.ready.owner.token);
  unwrap(await first.request('transact', batch()));
  await first.request('close'); await first.exit;
});

test('clean process termination and restart retain committed and refused transaction results', { timeout: 20000 }, async t => {
  const directory = await workspace(t);
  const first = await writer(t, directory);
  unwrap(await first.request('transact', batch()));
  const refused = batch('refused', 0, [], []);
  const originalFailure = await first.request('transact', refused);
  await first.request('close'); await first.exit;
  const second = await writer(t, directory);
  assert.deepEqual(await second.request('transact', refused), originalFailure);
  assert.deepEqual(await second.request('transact', batch()), { ok: true, value: { revision: 1 } });
  assert.equal(unwrap(await second.request('snapshot')).revision, 1);
  await second.request('close'); await second.exit;
});

test('restart preserves task times, stopped state, missing costs and pending work without renewal', { timeout: 20000 }, async t => {
  const directory = await workspace(t);
  const first = await writer(t, directory);
  const task = { startedAt: '2026-01-01T00:00:00.000Z', deadline: '2026-01-01T00:01:00.000Z',
    stopReason: 'expired', usedInvocations: 1, costYen: null, pendingOperation: { executionId: 'execution-1', outcome: 'unknown_outcome' } };
  unwrap(await first.request('transact', batch('expired-task', 0, [insert(task, 'task-1', 'tasks')], [event('expired')])));
  await first.kill();
  core.recoverFileStoreOwner(directory, first.ready.owner.token);
  const second = await writer(t, directory);
  assert.deepEqual(unwrap(await second.request('snapshot')).entries[0].value, task);
  await second.request('close'); await second.exit;
});

test('consistent backup restores original history, correction and idempotency in a new process', { timeout: 20000 }, async t => {
  const directory = await workspace(t);
  const backupRoot = await workspace(t);
  const backup = join(backupRoot, 'backup');
  const server = await writer(t, directory);
  unwrap(await server.request('transact', batch()));
  unwrap(await server.request('transact', batch('correction', 1, [replace({ remaining: 0, outcome: 'fail', cost: null }, { remaining: 1 })], [event('correction', { corrects: 'event-1', outcome: 'fail' })])));
  const expected = unwrap(await server.request('backup', backup));
  unwrap(await server.request('transact', batch('later', 2, [insert('later', 'later')], [])));
  await server.request('close'); await server.exit;
  const restored = await writer(t, backup);
  assert.deepEqual(unwrap(await restored.request('snapshot')), expected);
  assert.deepEqual(await restored.request('transact', batch()), { ok: true, value: { revision: 1 } });
  const journal = await readFile(join(backup, 'journal.jsonl'), 'utf8');
  assert.match(journal, /"remaining":1/u);
  assert.match(journal, /"outcome":"fail"/u);
  await restored.request('close'); await restored.exit;
});

for (const corruption of ['journal bytes', 'journal partial tail', 'snapshot digest', 'snapshot null']) {
  test(`corruption ${corruption} stops recovery without truncating files`, async t => {
    const directory = await workspace(t);
    const store = await core.openFileTaskStore(directory, options);
    unwrap(await store.transact(batch())); unwrap(await store.checkpoint()); await store.close();
    const file = join(directory, corruption.startsWith('journal') ? 'journal.jsonl' : 'snapshot.json');
    const original = await readFile(file, 'utf8');
    const damaged = corruption === 'journal bytes' ? original.replace('remaining', 'different')
      : corruption === 'journal partial tail' ? original + '{"partial":'
      : corruption === 'snapshot null' ? 'null' : original.replace(/"digest":"[0-9a-f]/u, '"digest":"x');
    await writeFile(file, damaged);
    const attempt = await core.openFileTaskStore(directory, options).then(async opened => { await opened.close(); return 'opened'; }, () => 'refused');
    assert.equal(attempt, 'refused');
    assert.equal(await readFile(file, 'utf8'), damaged);
  });
}
