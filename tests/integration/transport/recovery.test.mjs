import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestJson, inspectFileStoreOwner, openFileTaskStore, recoverFileStoreOwner } from '@semevolve/core';
import { transportMutableCollections } from '@semevolve/transport-adapters';
import { makeEndpoint, envelope, time, entries } from '../../mechanism/transport/fixture.mjs';
import { delivery, observation } from '../../mechanism/transport/conformance.mjs';

async function crash(directory, point, recipient) {
  const child = fork(new URL('./process-fixture.mjs', import.meta.url), [directory, point, recipient], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let reached = false;
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Boundary timeout: ${errors}`)); }, 10000);
    child.once('error', reject);
    child.on('message', message => {
      if (message.point === point && message.recipient === recipient) { reached = true; child.kill('SIGKILL'); }
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      if (reached) resolve();
      else reject(new Error(`Exited before boundary: ${errors}`));
    });
  });
  const owner = inspectFileStoreOwner(directory);
  assert.equal(owner.pid, child.pid);
  recoverFileStoreOwner(directory, owner.token);
}

for (const recipient of ['peer-b', 'peer-c']) {
  for (const point of ['after-stage', 'after-send', 'after-apply', 'after-ack', 'journal_before_append', 'journal_committed']) {
    test(`${recipient}: process kill at ${point} retains originals and applies each recipient once`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'semevolve-transport-recovery-'));
      await crash(directory, point, recipient);
      let store = await openFileTaskStore(directory, { mutableCollections: transportMutableCollections });
      t.after(() => store.close());
      const before = (await store.snapshot()).value;
      assert.deepEqual(entries(before, 'transport.messages'), [{ envelope, digest: digestJson(envelope) }]);
      assert.equal(entries(before, 'transport.outbox').length, 2);
      const target = entries(before, 'transport.outbox').find(row => row.recipientId === recipient);
      assert.equal(target.receipt, null);
      assert.equal(target.attempts, point === 'after-stage' ? 0 : 1);
      const appliedBefore = ['after-apply', 'after-ack', 'journal_committed'].includes(point);
      assert.equal(entries(before, 'transport.applications').length, point === 'after-stage' ? 0 : appliedBefore ? 2 : 1);
      const sent = [];
      const sender = makeEndpoint(store, 'peer-a', { adapterFor: id => ({ async send(value) {
        sent.push(id);
        assert.deepEqual(value, envelope);
        const receiver = makeEndpoint(store, id);
        assert.equal((await receiver.accept(delivery(value))).ok, true);
        assert.equal((await receiver.apply(value.message_id, { state: { received: 1, peer: id }, observation })).ok, true);
        assert.equal((await receiver.accept(delivery(value))).ok, true);
        assert.equal((await receiver.apply(value.message_id, { state: { received: 9 }, observation })).ok, true);
        return { messageId: value.message_id, recipientIds: [id], acceptedAt: time };
      } }) });
      assert.equal((await sender.stage(envelope)).ok, true);
      for (const id of envelope.recipient_ids) assert.equal((await sender.dispatch(envelope.message_id, id)).ok, true);
      assert.deepEqual(sent.sort(), ['peer-b', 'peer-c']);
      const after = (await store.snapshot()).value;
      assert.deepEqual(entries(after, 'transport.outbox').map(row => row.attempts), point === 'after-stage' ? [1, 1] : [2, 2]);
      assert.equal(entries(after, 'transport.applications').length, 2);
      assert.deepEqual(entries(after, 'transport.observations'), [observation]);
      assert.deepEqual(entries(after, 'transport.state').map(row => row.value), [{ received: 1, peer: 'peer-b' }, { received: 1, peer: 'peer-c' }]);
      assert.equal(entries(after, 'transport.inbox').every(row => row.appliedAt === time), true);
      assert.equal(after.events.filter(event => event.kind === 'transport.applied').length, 2);
      await store.close();
      store = await openFileTaskStore(directory, { mutableCollections: transportMutableCollections });
      assert.deepEqual((await store.snapshot()).value, after);
    });
  }

  test(`${recipient}: journal ahead of tail at apply remains fail-closed on reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'semevolve-transport-tail-'));
    await crash(directory, 'tail_before_switch', recipient);
    await assert.rejects(openFileTaskStore(directory, { mutableCollections: transportMutableCollections }), /tail mismatch/u);
  });
}
