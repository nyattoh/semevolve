import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryTaskStore } from '@semevolve/core';
import { transportMutableCollections } from '@semevolve/transport-adapters';
import { frozenPortDoubles } from './dist/ports.js';
import { makeEndpoint, envelope, time, entries } from './fixture.mjs';
import { delivery } from './conformance.mjs';

test('frozen Registry and Policy port doubles gate receipt and application independently', async t => {
  const store = createMemoryTaskStore({ mutableCollections: transportMutableCollections });
  t.after(() => store.close());
  const context = { taskId: envelope.task_id, recipientId: 'peer-b', authenticatedSenderId: 'peer-a',
    participantIds: ['peer-a', 'peer-b', 'peer-c'], now: time, deadline: '2026-10-28T10:00:00.000Z', maxBytes: 65536,
    epoch: { epochId: envelope.epoch_id, taskId: envelope.task_id, language: { mode: 'bound', languageVersionId: envelope.language_version_id },
      contextRevision: 0, openedAt: time, sendsClosedAt: null } };
  const { controls, policy, checkLanguage } = frozenPortDoubles(context);
  const b = makeEndpoint(store, 'peer-b', { policy, checkLanguage, async context() { return { ok: true, value: context }; } });
  controls.known = false;
  assert.equal((await b.accept(delivery())).error.reason, 'language_unavailable');
  controls.known = true;
  controls.conforming = false;
  assert.equal((await b.accept(delivery())).error.reason, 'language_unavailable');
  controls.conforming = true;
  assert.equal((await b.accept(delivery())).ok, true);
  controls.allowed = false;
  assert.equal((await b.apply(envelope.message_id, { state: 'forbidden', observation: null })).error.reason, 'policy_denied');
  controls.allowed = true;
  context.epoch.sendsClosedAt = time;
  assert.equal((await b.apply(envelope.message_id, { state: 'old epoch', observation: null })).error.reason, 'epoch_mismatch');
  assert.equal(entries((await store.snapshot()).value, 'transport.state').length, 0);
  context.epoch.sendsClosedAt = null;
  assert.equal((await b.apply(envelope.message_id, { state: 'current', observation: null })).ok, true);
  assert.deepEqual(entries((await store.snapshot()).value, 'transport.state').map(row => row.value), ['current']);
});
