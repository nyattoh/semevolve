import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@semevolve/core';
import { batch, insert, unwrap } from '../../support/persistence-conformance.mjs';
import { cleanup, workspace } from '../../support/persistence-harness.mjs';

test('bounded writer queue refuses excess requests without committing them', { timeout: 10000 }, async t => {
  const directory = await workspace(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = await core.openFileTaskStore(directory, { maxPending: 1, onBoundary: async point => {
    if (point === 'journal_before_append') await gate;
  } });
  cleanup(t, () => store.close());
  const admitted = store.transact(batch());
  const excess = await store.transact(batch('excess', 1, [insert('no', 'two')], []));
  assert.equal(excess.error.code, 'unavailable');
  assert.match(excess.error.reason, /not admitted/u);
  release();
  unwrap(await admitted);
  assert.equal(unwrap(await store.snapshot()).entries.length, 1);
});

test('I/O boundary failure retains unknown outcome until reopen and reconciliation', async t => {
  const directory = await workspace(t);
  const store = await core.openFileTaskStore(directory, { onBoundary: async point => {
    if (point === 'journal_committed') throw Error('synthetic lost response');
  } });
  cleanup(t, () => store.close());
  const first = await store.transact(batch());
  assert.equal(first.error.code, 'unavailable');
  assert.equal((await store.snapshot()).error.code, 'unavailable');
  assert.equal((await store.transact(batch('second', 1))).error.code, 'unavailable');
  await store.close();
  const recovered = await core.openFileTaskStore(directory);
  cleanup(t, () => recovered.close());
  assert.deepEqual(await recovered.transact(batch()), { ok: true, value: { revision: 1 } });
  assert.equal(unwrap(await recovered.snapshot()).events[0].data.outcome, 'pending');
});

test('F3 tail switch failure remains unknown and refuses an inconsistent reopen', async t => {
  const directory = await workspace(t);
  const store = await core.openFileTaskStore(directory, { onBoundary: async point => {
    if (point === 'tail_before_switch') throw Error('synthetic tail switch failure');
  } });
  cleanup(t, () => store.close());
  assert.equal((await store.transact(batch())).error.code, 'unavailable');
  assert.equal((await store.snapshot()).error.code, 'unavailable');
  assert.equal((await store.transact(batch('later', 1))).error.code, 'unavailable');
  await store.close();
  const before = await readFile(join(directory, 'journal.jsonl'), 'utf8');
  await assert.rejects(core.openFileTaskStore(directory), /tail/u);
  assert.equal(await readFile(join(directory, 'journal.jsonl'), 'utf8'), before);
});

test('reopening cannot silently change the immutable collection policy', async t => {
  const directory = await workspace(t);
  const store = await core.openFileTaskStore(directory);
  unwrap(await store.transact(batch())); await store.close();
  await assert.rejects(core.openFileTaskStore(directory, { mutableCollections: ['state'] }), /policy mismatch/u);
  const same = await core.openFileTaskStore(directory);
  cleanup(t, () => same.close());
  assert.equal(unwrap(await same.snapshot()).revision, 1);
});

test('unknown owner metadata and wrong recovery tokens preserve the lock', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'writer.lock'), 'partial');
  assert.throws(() => core.recoverFileStoreOwner(directory, 'synthetic-token'));
  assert.equal(await readFile(join(directory, 'writer.lock'), 'utf8'), 'partial');
  await assert.rejects(core.openFileTaskStore(directory), /EEXIST/u);
  const liveDirectory = await workspace(t);
  const live = await core.openFileTaskStore(liveDirectory);
  cleanup(t, () => live.close());
  const before = await readFile(join(liveDirectory, 'writer.lock'), 'utf8');
  assert.throws(() => core.recoverFileStoreOwner(liveDirectory, 'wrong-token'), /changed/u);
  assert.equal(await readFile(join(liveDirectory, 'writer.lock'), 'utf8'), before);
});

test('loss of the journal before any checkpoint cannot silently create an empty store', async t => {
  const directory = await workspace(t);
  const store = await core.openFileTaskStore(directory);
  unwrap(await store.transact(batch()));
  await store.close();
  await unlink(join(directory, 'journal.jsonl'));
  const result = await core.openFileTaskStore(directory).then(async reopened => { await reopened.close(); return 'reset'; }, () => 'refused');
  assert.equal(result, 'refused');
});
