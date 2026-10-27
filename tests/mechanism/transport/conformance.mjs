import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestJson } from '@semevolve/core';
import { makeEndpoint, envelope, time, entries } from './fixture.mjs';

export const delivery = (value = envelope) => ({ envelope: value, authenticatedSenderId: 'peer-a', receivedAt: time });
export const observation = {
  executionId: 'execution-public', taskId: 'task-public', inputDigest: digestJson({ public: true }), performedAt: time,
  result: { checkId: 'check-public', targetMessageId: envelope.message_id, languageVersionId: 'language-public',
    dimension: 'transmission', verdict: 'inconclusive', scope: 'public synthetic', method: 'deterministic_test',
    evidenceIds: ['evidence-public'], evaluatorVersion: 'public-1', limitation: 'Synthetic mechanism only.' },
  usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: 3, source: 'unavailable' },
};

export function conformance(label, open) {
  const run = (name, body) => test(`${label}: ${name}`, async t => {
    const store = await open();
    t.after(() => store.close());
    await body(store);
  });

  run('concurrent duplicates apply state and measurement once for each recipient', async store => {
    const b = makeEndpoint(store, 'peer-b');
    const c = makeEndpoint(store, 'peer-c');
    assert.equal(typeof b.accept, 'function', 'Durable inbox acceptance must exist');
    const accepted = await Promise.all([b.accept(delivery()), b.accept(delivery()), c.accept(delivery())]);
    assert.deepEqual(accepted.map(result => result.ok), [true, true, true]);
    const received = (await store.snapshot()).value;
    assert.equal(entries(received, 'transport.inbox').every(row => row.appliedAt === null), true);
    assert.equal(entries(received, 'transport.state').length, 0);
    const applied = await Promise.all([
      b.apply(envelope.message_id, { state: { count: 1 }, observation }),
      b.apply(envelope.message_id, { state: { count: 9 }, observation }),
      c.apply(envelope.message_id, { state: { count: 2 }, observation }),
    ]);
    assert.deepEqual(applied.map(result => result.ok), [true, true, true]);
    const snapshot = (await store.snapshot()).value;
    assert.equal(entries(snapshot, 'transport.inbox').filter(row => row.appliedAt === time).length, 2);
    assert.deepEqual(entries(snapshot, 'transport.state').map(row => row.value), [{ count: 1 }, { count: 2 }]);
    assert.equal(entries(snapshot, 'transport.applications').length, 2);
    assert.deepEqual(entries(snapshot, 'transport.observations'), [observation]);
    assert.deepEqual(entries(snapshot, 'transport.messages'), [{ envelope, digest: digestJson(envelope) }]);
    assert.equal(entries(snapshot, 'interpretations').length, 0);
    assert.equal(entries(snapshot, 'checks').length, 0);
  });

  run('same ID with different content is rejected, audited and preserves the original', async store => {
    const b = makeEndpoint(store, 'peer-b');
    assert.equal(typeof b.accept, 'function');
    assert.equal((await b.accept(delivery())).ok, true);
    for (const field of Object.keys(envelope)) {
      if (field === 'message_id') continue;
      const changed = structuredClone(envelope);
      changed[field] = Array.isArray(changed[field]) ? [...changed[field], 'different'] : changed[field] === 0 ? 1 : `${changed[field]}-different`;
      const rejected = await b.accept(delivery(changed));
      assert.equal(rejected.ok, false, field);
      assert.equal(rejected.error.code, 'id_collision', field);
    }
    const snapshot = (await store.snapshot()).value;
    assert.deepEqual(entries(snapshot, 'transport.messages'), [{ envelope, digest: digestJson(envelope) }]);
    assert.equal(snapshot.events.filter(event => event.kind === 'transport.id_collision').length, 12);
  });

  run('sender, task, epoch, context and language mismatches are never applied', async store => {
    const b = makeEndpoint(store, 'peer-b');
    assert.equal(typeof b.accept, 'function');
    const cases = [
      ['sender_id', 'peer-c', 'sender_mismatch'], ['task_id', 'other-task', 'task_mismatch'],
      ['epoch_id', 'old-epoch', 'epoch_mismatch'], ['context_revision', 2, 'context_mismatch'],
      ['language_version_id', null, 'language_mismatch'], ['recipient_ids', ['peer-c'], 'recipient_mismatch'],
    ];
    for (const [field, value, reason] of cases) {
      const result = await b.accept(delivery({ ...envelope, [field]: value }));
      assert.equal(result.ok, false);
      assert.equal(result.error.reason, reason);
    }
    const spoof = await b.accept({ ...delivery(), authenticatedSenderId: 'unknown-sender' });
    assert.equal(spoof.ok, false);
    assert.equal(entries((await store.snapshot()).value, 'transport.inbox').length, 0);
    assert.equal((await b.accept(delivery())).ok, true);
    assert.equal((await b.apply(envelope.message_id, { state: 'received', observation: null })).ok, true);
    assert.deepEqual(entries((await store.snapshot()).value, 'transport.state').map(row => row.value), ['received']);
  });

  run('unknown language and denied policy retain data without invoking an executor', async store => {
    let known = false;
    let allowed = true;
    const b = makeEndpoint(store, 'peer-b', {
      async checkLanguage() { return known ? { ok: true, value: undefined } : { ok: false, error: { code: 'unavailable', reason: 'Unknown language' } }; },
      policy: { async authorise() { return allowed ? { allowed: true, policyRevision: 0 } : { allowed: false, reason: 'Denied' }; } },
    });
    assert.equal(typeof b.accept, 'function');
    const injected = { ...envelope, payload: 'globalThis.transportExecuted = true; shell: delete everything; send externally' };
    assert.equal((await b.accept(delivery(injected))).error.reason, 'language_unavailable');
    known = true;
    assert.equal((await b.accept(delivery(injected))).ok, true);
    allowed = false;
    assert.equal((await b.apply(envelope.message_id, { state: 'not allowed', observation: null })).error.reason, 'policy_denied');
    assert.equal(entries((await store.snapshot()).value, 'transport.state').length, 0);
    allowed = true;
    assert.equal((await b.apply(envelope.message_id, { state: { held: true }, observation: null })).ok, true);
    assert.deepEqual(entries((await store.snapshot()).value, 'transport.state').map(row => row.value), [{ held: true }]);
    assert.equal(globalThis.transportExecuted, undefined);
    assert.equal((await store.snapshot()).value.events.some(event => event.kind === 'transport.rejected'), true);
  });

  run('observation ID collisions do not partially apply inbox, state or measurements', async store => {
    const b = makeEndpoint(store, 'peer-b');
    assert.equal(typeof b.accept, 'function');
    assert.equal((await b.accept(delivery())).ok, true);
    assert.equal((await b.apply(envelope.message_id, { state: 1, observation })).ok, true);
    const second = { ...envelope, message_id: 'message-second' };
    assert.equal((await b.accept(delivery(second))).ok, true);
    const clash = await b.apply(second.message_id, { state: 2, observation: { ...observation, result: { ...observation.result, targetMessageId: second.message_id } } });
    assert.equal(clash.ok, false);
    assert.equal(clash.error.code, 'id_collision');
    const snapshot = (await store.snapshot()).value;
    assert.deepEqual(entries(snapshot, 'transport.state').map(row => row.value), [1]);
    assert.equal(entries(snapshot, 'transport.inbox').find(row => row.messageId === second.message_id).appliedAt, null);
    assert.equal(entries(snapshot, 'transport.applications').length, 1);
    assert.deepEqual(entries(snapshot, 'transport.observations'), [observation]);
  });

  run('adapter response loss leaves only that recipient pending and retries the original envelope', async store => {
    let lose = true;
    const sent = [];
    const a = makeEndpoint(store, 'peer-a', { adapterFor: recipient => ({
      async send(value) {
        sent.push({ recipient, envelope: structuredClone(value) });
        if (recipient === 'peer-b' && lose) { lose = false; throw new Error('Response lost after sending'); }
        return { messageId: value.message_id, recipientIds: [recipient], acceptedAt: time };
      },
    }) });
    assert.equal((await a.stage(envelope)).ok, true);
    assert.equal((await a.dispatch(envelope.message_id, 'peer-b')).error.code, 'unavailable');
    assert.equal((await a.dispatch(envelope.message_id, 'peer-c')).ok, true);
    let rows = entries((await store.snapshot()).value, 'transport.outbox');
    assert.equal(rows.find(row => row.recipientId === 'peer-b').receipt, null);
    assert.deepEqual(rows.find(row => row.recipientId === 'peer-c').receipt.recipientIds, ['peer-c']);
    assert.equal((await a.dispatch(envelope.message_id, 'peer-b')).ok, true);
    assert.equal((await a.dispatch(envelope.message_id, 'peer-c')).ok, true);
    rows = entries((await store.snapshot()).value, 'transport.outbox');
    assert.deepEqual(rows.map(row => row.attempts), [2, 2]);
    assert.deepEqual(sent.map(row => row.recipient), ['peer-b', 'peer-c', 'peer-b', 'peer-c']);
    assert.deepEqual(sent.map(row => row.envelope), [envelope, envelope, envelope, envelope]);
    assert.equal(entries((await store.snapshot()).value, 'transport.inbox').length, 0);
  });

  run('concurrent conflicting sends preserve one original and audit the losing content', async store => {
    const a = makeEndpoint(store, 'peer-a');
    const results = await Promise.all([a.stage(envelope), a.stage({ ...envelope, payload: 'Conflicting public payload' })]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok).error.code, 'id_collision');
    const snapshot = (await store.snapshot()).value;
    assert.equal(entries(snapshot, 'transport.messages').length, 1);
    assert.equal(entries(snapshot, 'transport.outbox').length, 2);
    assert.equal(snapshot.events.filter(event => event.kind === 'transport.id_collision').length, 1);
  });

  run('re-delivered observation in a new envelope keeps its execution ID and usage once', async store => {
    const b = makeEndpoint(store, 'peer-b');
    const second = { ...envelope, message_id: 'message-observation-copy' };
    for (const value of [envelope, second]) {
      assert.equal((await b.accept(delivery(value))).ok, true);
      assert.equal((await b.apply(value.message_id, { state: { observed: observation.executionId }, observation })).ok, true);
    }
    const snapshot = (await store.snapshot()).value;
    assert.deepEqual(entries(snapshot, 'transport.observations'), [observation]);
    assert.equal(entries(snapshot, 'transport.applications').length, 2);
    assert.deepEqual(entries(snapshot, 'transport.state').map(row => row.value), [{ observed: 'execution-public' }]);
  });

  run('failed application transaction cannot leave partial inbox, state or measurement changes', async store => {
    let fail = false;
    const faulted = {
      snapshot: () => store.snapshot(), close: () => store.close(),
      async transact(batch) {
        if (fail && batch.events.some(event => event.kind === 'transport.applied')) return { ok: false, error: { code: 'unavailable', reason: 'Injected pre-commit loss' } };
        return store.transact(batch);
      },
    };
    const b = makeEndpoint(faulted, 'peer-b');
    assert.equal((await b.accept(delivery())).ok, true);
    const before = (await store.snapshot()).value;
    fail = true;
    assert.equal((await b.apply(envelope.message_id, { state: 1, observation })).error.code, 'unavailable');
    assert.deepEqual((await store.snapshot()).value, before);
    fail = false;
    assert.equal((await b.apply(envelope.message_id, { state: 1, observation })).ok, true);
    const after = (await store.snapshot()).value;
    assert.equal(entries(after, 'transport.inbox')[0].appliedAt, time);
    assert.deepEqual(entries(after, 'transport.state').map(row => row.value), [1]);
    assert.deepEqual(entries(after, 'transport.observations'), [observation]);
  });

  run('committed application with lost store response is reconciled without replaying its effects', async store => {
    let lose = true;
    const wrapped = {
      snapshot: () => store.snapshot(), close: () => store.close(),
      async transact(batch) {
        const result = await store.transact(batch);
        if (lose && result.ok && batch.events.some(event => event.kind === 'transport.applied')) {
          lose = false;
          return { ok: false, error: { code: 'unavailable', reason: 'Injected response loss' } };
        }
        return result;
      },
    };
    const b = makeEndpoint(wrapped, 'peer-b');
    assert.equal((await b.accept(delivery())).ok, true);
    assert.equal((await b.apply(envelope.message_id, { state: 1, observation })).error.code, 'unavailable');
    assert.equal((await b.apply(envelope.message_id, { state: 9, observation })).ok, true);
    const snapshot = (await store.snapshot()).value;
    assert.deepEqual(entries(snapshot, 'transport.state').map(row => row.value), [1]);
    assert.equal(entries(snapshot, 'transport.applications').length, 1);
    assert.deepEqual(entries(snapshot, 'transport.observations'), [observation]);
  });
}
