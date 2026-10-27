import assert from 'node:assert/strict';
import { join } from 'node:path';
import { digestJson, hostIdentity, openFileTaskStore } from '@semevolve/core';
import { createLocalTransportHub, transportMutableCollections } from '@semevolve/transport-adapters';
import { makeEndpoint, envelope, entries, time } from '../../mechanism/transport/fixture.mjs';
import { observation } from '../../mechanism/transport/conformance.mjs';

const [phase, directory] = process.argv.slice(2);
const peers = ['peer-a', 'peer-b', 'peer-c'];
const stores = new Map(await Promise.all(peers.map(async peer => [peer,
  await openFileTaskStore(join(directory, peer), { mutableCollections: transportMutableCollections })])));
const hub = createLocalTransportHub(peers, { ...hostIdentity, now: () => time });
let calls = 0;
const sender = makeEndpoint(stores.get('peer-a'), 'peer-a', { adapterFor: recipient => {
  const adapter = hub.connect('peer-a', recipient);
  return { ...adapter, async send(value) { calls++; assert.deepEqual(value, envelope); return adapter.send(value); } };
} });
const snapshot = async peer => (await stores.get(peer).snapshot()).value;

if (phase === 'send') {
  assert.equal((await sender.stage(envelope)).ok, true);
  for (const peer of envelope.recipient_ids) assert.equal((await sender.dispatch(envelope.message_id, peer)).ok, true);
  assert.equal(calls, 2);
  assert.equal(entries(await snapshot('peer-a'), 'transport.outbox').filter(row => row.receipt !== null).length, 2);
  for (const peer of envelope.recipient_ids) {
    assert.equal(entries(await snapshot(peer), 'transport.inbox').length, 0);
    assert.equal(entries(await snapshot(peer), 'transport.applications').length, 0);
  }
  process.exit(71);
}

const receipts = entries(await snapshot('peer-a'), 'transport.outbox').map(row => row.receipt);
for (const peer of envelope.recipient_ids) assert.equal((await sender.dispatch(envelope.message_id, peer)).ok, true);
assert.equal(calls, 2, 'Stored receipts must not suppress retransmission before a durable receiver inbox exists');
assert.deepEqual(entries(await snapshot('peer-a'), 'transport.outbox').map(row => row.attempts), [2, 2]);
assert.deepEqual(entries(await snapshot('peer-a'), 'transport.outbox').map(row => row.receipt), receipts);
assert.deepEqual(entries(await snapshot('peer-a'), 'transport.messages'), [{ envelope, digest: digestJson(envelope) }]);
const received = [];
for (const peer of envelope.recipient_ids) {
  const adapter = hub.connect(peer, peer);
  assert.equal((await adapter.receive(null)).deliveries.length, 1);
  let loseAck = true;
  const receiver = makeEndpoint(stores.get(peer), peer, { adapterFor: () => ({ ...adapter,
    async acknowledge(id) { if (loseAck) { loseAck = false; throw Error('synthetic lost acknowledgement'); } return adapter.acknowledge(id); },
  }) });
  assert.equal((await receiver.receive()).value[0].ok, true);
  assert.equal(entries(await snapshot(peer), 'transport.inbox')[0].appliedAt, null);
  assert.equal(entries(await snapshot(peer), 'transport.applications').length, 0);
  const application = { state: { received: 1, peer }, observation };
  assert.equal((await receiver.apply(envelope.message_id, application)).ok, true);
  assert.equal((await receiver.acknowledge(envelope.message_id)).ok, false);
  assert.equal((await receiver.receive()).value[0].ok, true);
  assert.equal((await receiver.apply(envelope.message_id, { state: { received: 999 }, observation })).ok, true);
  assert.equal((await receiver.acknowledge(envelope.message_id)).ok, true);
  assert.equal((await adapter.receive(null)).deliveries.length, 0);
  assert.equal((await sender.dispatch(envelope.message_id, peer)).ok, true);
  assert.equal((await receiver.receive()).value[0].ok, true);
  assert.equal((await receiver.apply(envelope.message_id, application)).ok, true);
  assert.equal((await receiver.acknowledge(envelope.message_id)).ok, true);
  const value = await snapshot(peer);
  assert.equal(entries(value, 'transport.inbox').length, 1);
  assert.equal(entries(value, 'transport.applications').length, 1);
  assert.deepEqual(entries(value, 'transport.observations'), [observation]);
  assert.deepEqual(entries(value, 'transport.state').map(row => row.value), [application.state]);
  assert.equal(value.events.filter(event => event.kind === 'transport.applied').length, 1);
  received.push({ peer, snapshot: value });
}
assert.equal(calls, 4);
for (const store of stores.values()) await store.close();
for (const { peer, snapshot: expected } of received) {
  const reopened = await openFileTaskStore(join(directory, peer), { mutableCollections: transportMutableCollections });
  assert.deepEqual((await reopened.snapshot()).value, expected);
  await reopened.close();
}
console.log(JSON.stringify({ calls, recipients: received.map(row => row.peer), applicationsPerRecipient: 1 }));
