import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '@semevolve/core';

export const key = (id = 'one', collection = 'state') => ({ collection, id });
export const insert = (value, id = 'one', collection = 'state') => ({ kind: 'insert', entry: { key: key(id, collection), value } });
export const replace = (value, previous, id = 'one', collection = 'state') => ({ kind: 'replace', entry: { key: key(id, collection), value }, expectedDigest: core.digestJson(previous) });
export const event = (id = 'event-1', data = { outcome: 'pending' }) => ({ eventId: id, taskId: 'task-1', actor: 'host', kind: 'synthetic', occurredAt: '2026-01-01T00:00:00.000Z', data });
export const batch = (id = 'transaction-1', revision = 0, mutations = [insert({ remaining: 1 })], events = [event()]) => ({ transactionId: id, expectedRevision: revision, mutations, events });
export const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };

export function conformance(name, factory) {
  test(`${name}: commits mutations and events in one consistent snapshot`, async t => {
    const store = await factory(t);
    assert.deepEqual(unwrap(await store.transact(batch())), { revision: 1 });
    const snapshot = unwrap(await store.snapshot());
    const expected = { revision: 1, entries: [{ key: key(), value: { remaining: 1 } }], events: [event()] };
    assert.deepEqual(snapshot, { ...expected, digest: core.digestJson(expected) });
  });
  test(`${name}: repeats identical transactions and refuses changed batches`, async t => {
    const store = await factory(t);
    const original = await store.transact(batch());
    assert.deepEqual(await store.transact(batch()), original);
    assert.deepEqual(await store.transact(batch('transaction-1', 0, [insert({ remaining: 0 })])),
      { ok: false, error: { code: 'id_collision', id: 'transaction-1' } });
    assert.equal(unwrap(await store.snapshot()).revision, 1);
  });
  test(`${name}: concurrent clients with one revision have exactly one winner`, async t => {
    const store = await factory(t);
    const clientA = { transact: request => store.transact(request) };
    const clientB = { transact: request => store.transact(request) };
    const results = await Promise.all([
      clientA.transact(batch('a', 0, [insert('a')], [event('a')])),
      clientB.transact(batch('b', 0, [insert('b')], [event('b')])),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok).error, { code: 'revision_conflict', expected: 0, actual: 1 });
    const snapshot = unwrap(await store.snapshot());
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.events.length, 1);
  });
  test(`${name}: remaining-one reservation transactions allow one commit`, async t => {
    const store = await factory(t);
    unwrap(await store.transact(batch('seed', 0, [insert({ remaining: 1 })], [])));
    const reserve = id => batch(id, 1, [replace({ remaining: 0 }, { remaining: 1 }), insert({ outcome: 'pending' }, id, 'reservations')], [event(id)]);
    const results = await Promise.all([store.transact(reserve('a')), store.transact(reserve('b'))]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const snapshot = unwrap(await store.snapshot());
    assert.equal(snapshot.entries.filter(entry => entry.key.collection === 'reservations').length, 1);
    assert.deepEqual(snapshot.entries.find(entry => entry.key.collection === 'state').value, { remaining: 0 });
  });
  test(`${name}: digest CAS failure applies neither earlier mutations nor events`, async t => {
    const store = await factory(t);
    unwrap(await store.transact(batch()));
    const before = unwrap(await store.snapshot());
    const request = batch('bad', 1, [insert('must not remain', 'two'), replace({ remaining: 0 }, { remaining: 99 })], [event('new')]);
    const result = await store.transact(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_input');
    assert.deepEqual(unwrap(await store.snapshot()), before);
    unwrap(await store.transact(batch('advance', 1, [replace({ remaining: 2 }, { remaining: 1 })], [])));
    assert.deepEqual(await store.transact(request), result);
  });
  test(`${name}: insert and event ID duplicates are rejected atomically`, async t => {
    const store = await factory(t);
    unwrap(await store.transact(batch()));
    const before = unwrap(await store.snapshot());
    for (const request of [
      batch('duplicate-entry', 1, [insert({ remaining: 1 })], [event('new')]),
      batch('duplicate-event', 1, [insert('new', 'two')], [event()]),
      batch('within-batch', 1, [insert(1, 'two'), insert(2, 'two')], []),
      batch('within-events', 1, [], [event('two'), event('two')]),
    ]) {
      assert.equal((await store.transact(request)).error.code, 'id_collision');
      assert.deepEqual(unwrap(await store.snapshot()), before);
    }
  });
  test(`${name}: immutable collections cannot be replaced`, async t => {
    const store = await factory(t);
    unwrap(await store.transact(batch('original', 0, [insert('original', 'one', 'messages')], [])));
    assert.equal((await store.transact(batch('overwrite', 1, [replace('changed', 'original', 'one', 'messages')], []))).error.code, 'invalid_input');
    assert.equal(unwrap(await store.snapshot()).entries[0].value, 'original');
  });
  test(`${name}: original, correction, fail, unknown and pending remain distinct`, async t => {
    const store = await factory(t);
    const values = ['original', 'correction', 'fail', 'unknown_outcome', 'pending'];
    unwrap(await store.transact(batch('history', 0, values.map(value => insert({ kind: value, cost: null }, value, 'history')),
      values.map(value => event(value, { kind: value, cost: null })))));
    assert.deepEqual(unwrap(await store.snapshot()).events.map(item => item.data), values.map(kind => ({ kind, cost: null })));
    assert.equal(unwrap(await store.snapshot()).entries.length, 5);
  });
  test(`${name}: caller mutation cannot change committed input or returned snapshots`, async t => {
    const store = await factory(t);
    const input = batch();
    const promise = store.transact(input);
    input.mutations[0].entry.value.remaining = 999;
    unwrap(await promise);
    const snapshot = unwrap(await store.snapshot());
    snapshot.entries[0].value.remaining = 999;
    snapshot.events[0].data.outcome = 'completed';
    const actual = unwrap(await store.snapshot());
    assert.equal(actual.entries[0].value.remaining, 1);
    assert.equal(actual.events[0].data.outcome, 'pending');
  });
  test(`${name}: keys remain distinct without delimiter collisions`, async t => {
    const store = await factory(t);
    unwrap(await store.transact(batch('keys', 0, [insert('a', 'b:c', 'a'), insert('b', 'c', 'a:b'), insert('safe', '__proto__', 'constructor')], [])));
    assert.equal(unwrap(await store.snapshot()).entries.length, 3);
  });
  test(`${name}: malformed batches never mutate the store`, async t => {
    const store = await factory(t);
    for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 2 ** 53 }, { transactionId: '' },
      { mutations: [{ kind: 'delete', entry: { key: key(), value: 1 } }] }, { events: [{ ...event(), occurredAt: 'not UTC' }] },
      { mutations: [insert(undefined)] }, { events: [] , mutations: new Array(1) }]) {
      const result = await store.transact({ ...batch(), ...patch });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'invalid_input');
    }
    assert.equal(unwrap(await store.snapshot()).revision, 0);
  });
  test(`${name}: close is idempotent and prevents subsequent use`, async t => {
    const store = await factory(t);
    unwrap(await store.transact(batch()));
    await store.close(); await store.close();
    assert.equal((await store.transact(batch('two', 1))).error.code, 'unavailable');
    assert.equal((await store.snapshot()).error.code, 'unavailable');
  });
}
