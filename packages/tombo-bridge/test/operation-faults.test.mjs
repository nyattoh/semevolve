import assert from 'node:assert/strict';
import test from 'node:test';
import { operationSteps } from '@semevolve/core';
import { createTomboBridge } from '@semevolve/tombo-bridge';
import { commit, fixture, input, update, value } from './support/fixture.mjs';

function crashOnce(step, name) {
  let pending = true;
  return async (at, operation) => {
    if (pending && at === step && operation === name) {
      pending = false;
      throw new Error(`crash after ${name} ${step}`);
    }
  };
}
const rows = async (store, collection) => value(await store.snapshot()).entries.filter(entry => entry.key.collection === collection);
const crash = async (result, step, name) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.reason, new RegExp(`crash after ${name} ${step}`));
};

for (const step of operationSteps) test(`tombo.inspect recovers after a crash at ${step}`, { timeout: 30000 }, async () => {
  let activations = 0;
  const f = fixture({ fault: crashOnce(step, 'tombo.inspect') });
  f.session.inspect = async () => { activations += 1; return structuredClone(f.state); };
  const inspection = input();
  await crash(await f.bridge.inspect(inspection), step, 'tombo.inspect');
  assert.equal(activations, step === 'effect' ? 1 : 0);
  assert.equal((await rows(f.store, 'tombo.inspect-claims')).length, step === 'prepared' ? 0 : 1);
  assert.equal((await rows(f.store, 'tombo.inspect-proofs')).length, 0);
  assert.equal((await rows(f.store, 'tombo.bindings')).length, 0);
  const recovered = value(await f.bridge.inspect(structuredClone(inspection)));
  assert.equal(recovered.reference.sessionRef, 'public-session');
  assert.deepEqual(recovered.unresolvedGapRefs, ['public-gap']);
  assert.equal(activations, step === 'effect' ? 2 : 1);
  assert.equal((await rows(f.store, 'tombo.bindings')).length, 1);
  assert.equal((await rows(f.store, 'tombo.inspect-proofs')).length, 1);
  assert.equal(value(await f.bridge.inspect(structuredClone(inspection))).reference.sessionRef, 'public-session');
  assert.equal(activations, step === 'effect' ? 2 : 1);
});

for (const step of operationSteps) test(`tombo.pending recovers after a crash at ${step}`, { timeout: 30000 }, async () => {
  const boundaries = [];
  const f = fixture({ fault: crashOnce(step, 'tombo.pending'), boundary: async point => { boundaries.push(point); } });
  const req = update(value(await f.bridge.inspect(input())).reference);
  await crash(await f.bridge.receive(req), step, 'tombo.pending');
  assert.equal(f.calls.receive, 0);
  assert.deepEqual(boundaries, step === 'effect' ? ['pending_committed'] : []);
  assert.equal((await rows(f.store, 'tombo.pending')).length, step === 'prepared' ? 0 : 1);
  assert.deepEqual(value(await f.bridge.receive(structuredClone(req))), { executionId: req.executionId });
  assert.equal(f.calls.receive, 1);
  assert.deepEqual(boundaries, step === 'intent' ? [] : ['pending_committed']);
  assert.equal((await rows(f.store, 'tombo.pending')).length, 1);
  value(await f.bridge.receive(structuredClone(req)));
  assert.equal(f.calls.receive, 1);
  assert.deepEqual(boundaries, step === 'intent' ? [] : ['pending_committed']);
});

test('tombo.receive re-enters only its effect because the pending row is the intent', { timeout: 30000 }, async () => {
  const seen = [];
  const f = fixture({ fault: async (step, name) => { if (name === 'tombo.receive') seen.push(step); } });
  const req = update(value(await f.bridge.inspect(input())).reference);
  assert.deepEqual(value(await f.bridge.receive(req)), { executionId: req.executionId });
  assert.deepEqual(seen, ['effect']);
});

test('tombo.receive recovers after a crash at effect without receiving twice', { timeout: 30000 }, async () => {
  const f = fixture({ fault: crashOnce('effect', 'tombo.receive') });
  const req = update(value(await f.bridge.inspect(input())).reference);
  await crash(await f.bridge.receive(req), 'effect', 'tombo.receive');
  assert.equal(f.calls.receive, 1);
  assert.equal(f.state.session.updates.some(receipt => receipt.id === req.executionId), true);
  assert.deepEqual(value(await f.bridge.receive(structuredClone(req))), { executionId: req.executionId });
  assert.equal(f.calls.receive, 1);
  value(await f.bridge.receive(structuredClone(req)));
  assert.equal(f.calls.receive, 1);
});

for (const step of operationSteps) test(`tombo.apply recovers after a crash at ${step}`, { timeout: 30000 }, async () => {
  const f = fixture({ fault: crashOnce(step, 'tombo.apply') });
  const req = update(value(await f.bridge.inspect(input())).reference);
  value(await f.bridge.receive(req));
  await crash(await f.bridge.reconcile(req), step, 'tombo.apply');
  assert.equal(f.calls.apply, step === 'effect' ? 1 : 0);
  assert.equal((await rows(f.store, 'tombo.apply-claims')).length, step === 'prepared' ? 0 : 1);
  assert.equal((await rows(f.store, 'tombo.reconciliation-results')).length, 0);
  assert.equal((await rows(f.store, 'tombo.reconciliation-events')).length, 0);
  const recovered = value(await f.bridge.reconcile(structuredClone(req)));
  assert.equal(recovered.kind, 'reconciled');
  assert.equal(recovered.executionId, req.executionId);
  assert.equal(f.calls.apply, 1);
  assert.equal(f.state.state.appliedExecutions.length, 1);
  assert.equal((await rows(f.store, 'tombo.reconciliation-results')).length, 1);
  assert.equal(value(await f.bridge.reconcile(structuredClone(req))).kind, 'reconciled');
  assert.equal(f.calls.apply, 1);
});

test('a fault aimed at another operation does not change receive or apply', { timeout: 30000 }, async () => {
  const f = fixture({ fault: crashOnce('intent', 'tombo.inspect') });
  const bridge = createTomboBridge({ store: f.store, session: f.session, sdkCommit: commit });
  const req = update(value(await bridge.inspect(input())).reference);
  value(await f.bridge.receive(req));
  assert.equal(value(await f.bridge.reconcile(req)).kind, 'reconciled');
  assert.deepEqual(f.calls, { receive: 1, apply: 1 });
});
