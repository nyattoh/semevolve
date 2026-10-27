import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTaskStore } from '@semevolve/core';
import { transportMutableCollections } from '@semevolve/transport-adapters';
import { makeEndpoint, envelope, entries, time } from './fixture.mjs';

test('T-F1 retry failures retain the original receipt without claiming retransmission success', async () => {
  const store = createMemoryTaskStore({ mutableCollections: transportMutableCollections });
  let calls = 0;
  const first = { messageId: envelope.message_id, acceptedAt: time, recipientIds: ['peer-b'] };
  const sender = makeEndpoint(store, 'peer-a', { adapterFor: () => ({ async send() {
    calls++;
    if (calls === 2) throw Error('synthetic transport failure');
    if (calls === 3) return { ...first, recipientIds: ['peer-c'] };
    return first;
  } }) });
  assert.equal((await sender.stage(envelope)).ok, true);
  assert.equal((await sender.dispatch(envelope.message_id, 'peer-b')).ok, true);
  const failed = await sender.dispatch(envelope.message_id, 'peer-b');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unavailable');
  const invalid = await sender.dispatch(envelope.message_id, 'peer-b');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.reason, 'invalid_receipt');
  assert.equal((await sender.dispatch(envelope.message_id, 'peer-b')).ok, true);
  const snapshot = (await store.snapshot()).value;
  const outbox = entries(snapshot, 'transport.outbox').find(row => row.recipientId === 'peer-b');
  assert.equal(outbox.attempts, 4);
  assert.deepEqual(outbox.receipt, first);
  assert.equal(entries(snapshot, 'transport.inbox').length, 0);
  assert.equal(calls, 4);
});
