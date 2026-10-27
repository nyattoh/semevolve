import assert from 'node:assert/strict';
import { openFileTaskStore } from '@semevolve/core';
import { createLocalTransportHub, transportMutableCollections } from '@semevolve/transport-adapters';
import { makeEndpoint, envelope, time } from '../../mechanism/transport/fixture.mjs';
import { observation } from '../../mechanism/transport/conformance.mjs';

const [directory, point, recipient] = process.argv.slice(2);
let armed = false;
async function stopAt(value) {
  if (value !== point) return;
  process.send({ point, recipient });
  await new Promise(() => {});
}
const store = await openFileTaskStore(directory, { mutableCollections: transportMutableCollections,
  async onBoundary(boundary) { if (armed) await stopAt(boundary); },
});
const hub = createLocalTransportHub(['peer-a', 'peer-b', 'peer-c']);
const a = makeEndpoint(store, 'peer-a', { adapterFor: id => ({
  async send(value) {
    const receiver = makeEndpoint(store, id, { adapterFor: to => hub.connect(id, to) });
    const adapter = hub.connect('peer-a', id);
    await adapter.send(value);
    assert.equal((await receiver.receive()).value[0].ok, true);
    if (id === recipient) await stopAt('after-send');
    armed = id === recipient;
    assert.equal((await receiver.apply(value.message_id, { state: { received: 1, peer: id }, observation })).ok, true);
    armed = false;
    if (id === recipient) await stopAt('after-apply');
    assert.equal((await receiver.acknowledge(value.message_id)).ok, true);
    if (id === recipient) await stopAt('after-ack');
    return { messageId: value.message_id, recipientIds: [id], acceptedAt: time };
  },
}) });
assert.equal((await a.stage(envelope)).ok, true);
await stopAt('after-stage');
const other = envelope.recipient_ids.find(id => id !== recipient);
assert.equal((await a.dispatch(envelope.message_id, other)).ok, true);
assert.equal((await a.dispatch(envelope.message_id, recipient)).ok, true);
throw new Error('Fault boundary was not reached');
