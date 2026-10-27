import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as transport from '@semevolve/transport-adapters';
import { createMemoryTaskStore } from '@semevolve/core';

test('send commits the original message and every recipient outbox before calling an adapter', async () => {
  assert.equal(typeof transport.createTransportEndpoint, 'function', 'The durable transport endpoint must exist');
  const store = createMemoryTaskStore({ mutableCollections: transport.transportMutableCollections });
  const { makeEndpoint, envelope, entries } = await import('./fixture.mjs');
  let sends = 0;
  const endpoint = makeEndpoint(store, 'peer-a', {
    adapterFor: recipient => ({
      async send(value) {
        sends++;
        const snapshot = await store.snapshot();
        assert.deepEqual(entries(snapshot.value, 'transport.messages')[0].envelope, envelope);
        assert.deepEqual(entries(snapshot.value, 'transport.outbox').map(row => row.recipientId).sort(), ['peer-b', 'peer-c']);
        return { messageId: value.message_id, recipientIds: [recipient], acceptedAt: envelope.created_at };
      },
      async receive() { return { deliveries: [], cursor: null }; },
      async acknowledge() {},
    }),
  });
  assert.equal((await endpoint.stage(envelope)).ok, true);
  assert.equal(sends, 0);
  assert.equal((await endpoint.dispatch(envelope.message_id, 'peer-b')).ok, true);
  assert.equal(sends, 1);
  assert.equal((await store.snapshot()).value.events.some(event => event.kind === 'transport.staged'), true);
  await store.close();
});

test('a refused staging transaction cannot call the adapter or retain a partial send', async () => {
  const store = createMemoryTaskStore({ mutableCollections: transport.transportMutableCollections });
  const { makeEndpoint, envelope, entries } = await import('./fixture.mjs');
  let fail = true;
  let sends = 0;
  const wrapped = {
    snapshot: () => store.snapshot(),
    async transact(batch) { return fail ? { ok: false, error: { code: 'unavailable', reason: 'Injected write failure' } } : store.transact(batch); },
  };
  const endpoint = makeEndpoint(wrapped, 'peer-a', { adapterFor: recipient => ({ async send(value) {
    sends++;
    return { messageId: value.message_id, recipientIds: [recipient], acceptedAt: envelope.created_at };
  } }) });
  assert.equal((await endpoint.stage(envelope)).error.code, 'unavailable');
  assert.equal((await endpoint.dispatch(envelope.message_id, 'peer-b')).error.reason, 'missing_message');
  assert.equal(sends, 0);
  assert.equal(entries((await store.snapshot()).value, 'transport.messages').length, 0);
  fail = false;
  assert.equal((await endpoint.stage(envelope)).ok, true);
  assert.equal((await endpoint.dispatch(envelope.message_id, 'peer-b')).ok, true);
  assert.equal(sends, 1);
  await store.close();
});

test('a receipt for a different recipient leaves the outbox pending', async () => {
  const store = createMemoryTaskStore({ mutableCollections: transport.transportMutableCollections });
  const { makeEndpoint, envelope, entries } = await import('./fixture.mjs');
  let correct = false;
  const endpoint = makeEndpoint(store, 'peer-a', { adapterFor: recipient => ({ async send(value) {
    return { messageId: value.message_id, recipientIds: [correct ? recipient : 'peer-c'], acceptedAt: envelope.created_at };
  } }) });
  assert.equal((await endpoint.stage(envelope)).ok, true);
  assert.equal((await endpoint.dispatch(envelope.message_id, 'peer-b')).error.reason, 'invalid_receipt');
  assert.equal(entries((await store.snapshot()).value, 'transport.outbox').every(row => row.receipt === null), true);
  correct = true;
  assert.equal((await endpoint.dispatch(envelope.message_id, 'peer-b')).ok, true);
  assert.deepEqual(entries((await store.snapshot()).value, 'transport.outbox')[0].receipt.recipientIds, ['peer-b']);
  await store.close();
});
