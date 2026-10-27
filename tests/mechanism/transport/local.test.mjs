import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as transport from '@semevolve/transport-adapters';
import { createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import { envelope, time, makeEndpoint, entries } from './fixture.mjs';

test('local adapter binds sender metadata and acknowledges only its recipient', async () => {
  assert.equal(typeof transport.createLocalTransportHub, 'function', 'The registered local transport must exist');
  const hub = transport.createLocalTransportHub(['peer-a', 'peer-b', 'peer-c'], { ...hostIdentity, now: () => time });
  const b = hub.connect('peer-a', 'peer-b');
  const c = hub.connect('peer-a', 'peer-c');
  assert.throws(() => hub.connect('unknown', 'peer-b'), /registered/u);
  await assert.rejects(b.send({ ...envelope, sender_id: 'peer-c' }), /sender/u);
  assert.deepEqual(await b.send(envelope), { messageId: envelope.message_id, recipientIds: ['peer-b'], acceptedAt: time });
  await c.send(envelope);
  await b.send(envelope);
  assert.equal((await b.receive(null)).deliveries.length, 2);
  await b.acknowledge(envelope.message_id);
  assert.equal((await b.receive(null)).deliveries.length, 0);
  assert.deepEqual((await c.receive(null)).deliveries, [{ envelope, authenticatedSenderId: 'peer-a', receivedAt: time }]);
  await c.acknowledge(envelope.message_id);
  assert.equal((await c.receive(null)).deliveries.length, 0);
});

for (const recipient of ['peer-b', 'peer-c']) {
  test(`lost acknowledgement for ${recipient} cannot repeat application or acknowledge the other recipient`, async t => {
    assert.equal(typeof transport.createLocalTransportHub, 'function');
    const store = createMemoryTaskStore({ mutableCollections: transport.transportMutableCollections });
    t.after(() => store.close());
    const hub = transport.createLocalTransportHub(['peer-a', 'peer-b', 'peer-c'], { ...hostIdentity, now: () => time });
    const a = makeEndpoint(store, 'peer-a', { adapterFor: id => hub.connect('peer-a', id) });
    let lost = true;
    const receiver = makeEndpoint(store, recipient, { adapterFor: id => {
      const adapter = hub.connect(recipient, id);
      return { ...adapter, async acknowledge(messageId) {
        if (lost) { lost = false; throw new Error('Acknowledgement lost'); }
        await adapter.acknowledge(messageId);
      } };
    } });
    assert.equal((await a.stage(envelope)).ok, true);
    for (const id of envelope.recipient_ids) assert.equal((await a.dispatch(envelope.message_id, id)).ok, true);
    assert.equal((await receiver.receive()).value[0].ok, true);
    assert.equal((await receiver.apply(envelope.message_id, { state: 1, observation: null })).ok, true);
    assert.equal((await receiver.acknowledge(envelope.message_id)).error.code, 'unavailable');
    assert.equal((await receiver.receive()).value[0].ok, true);
    assert.equal((await receiver.apply(envelope.message_id, { state: 2, observation: null })).ok, true);
    assert.equal((await receiver.acknowledge(envelope.message_id)).ok, true);
    assert.equal((await receiver.receive()).value.length, 0);
    const other = envelope.recipient_ids.find(id => id !== recipient);
    assert.equal((await hub.connect(other, other).receive(null)).deliveries.length, 1);
    const snapshot = (await store.snapshot()).value;
    assert.deepEqual(entries(snapshot, 'transport.state').map(row => row.value), [1]);
    assert.equal(entries(snapshot, 'transport.applications').length, 1);
    assert.equal(snapshot.events.filter(event => event.kind === 'transport.acknowledged').length, 1);
  });
}

test('acknowledging receipt before application cannot claim understanding or completion', async t => {
  const store = createMemoryTaskStore({ mutableCollections: transport.transportMutableCollections });
  t.after(() => store.close());
  const hub = transport.createLocalTransportHub(['peer-a', 'peer-b', 'peer-c'], { ...hostIdentity, now: () => time });
  await hub.connect('peer-a', 'peer-b').send(envelope);
  const b = makeEndpoint(store, 'peer-b', { adapterFor: recipient => hub.connect('peer-b', recipient) });
  assert.equal((await b.receive()).value[0].ok, true);
  assert.equal((await b.acknowledge(envelope.message_id)).ok, true);
  const snapshot = (await store.snapshot()).value;
  assert.equal(entries(snapshot, 'transport.inbox')[0].appliedAt, null);
  assert.equal(entries(snapshot, 'transport.applications').length, 0);
  assert.equal(entries(snapshot, 'interpretations').length, 0);
  assert.equal(entries(snapshot, 'checks').length, 0);
  assert.equal((await b.apply(envelope.message_id, { state: 'applied', observation: null })).ok, true);
  assert.deepEqual(entries((await store.snapshot()).value, 'transport.state').map(row => row.value), ['applied']);
});
