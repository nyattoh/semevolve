import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, request, amount, usage } from './fixtures.mjs';

const operation = () => ({ taskId: 'task-public', name: 'synthetic-read', target: 'public-fixture' });
const execution = s => ({ request: request(), reservationId: 'reservation-public', amount: structuredClone(amount),
  operation: operation(), gate: s.gate, provider: s.provider });

test('P-F1 delayed result settles its original reservation despite caller mutation', async () => {
  const s = await setup({ provider: { scenario: 'delayed' } });
  const input = execution(s);
  const running = s.runtime.execute(input);
  await s.provider.waitForInvocation();
  const snapshot = await s.runtime.snapshot('task-public');
  assert.equal((await s.runtime.reserveAndStart({ taskId: 'task-public', invocationId: 'invocation-other',
    reservationId: 'reservation-other', amount, expectedRevision: snapshot.value.revision })).ok, true);
  input.reservationId = 'reservation-other';
  s.provider.complete('invocation-public');
  const completed = await running;
  assert.equal(completed.ok, true);
  assert.equal(completed.value.reservation.reservationId, 'reservation-public');
  assert.equal(completed.value.reservation.invocationId, 'invocation-public');
  const final = (await s.runtime.snapshot('task-public')).value;
  assert.equal(final.reservations.find(row => row.reservationId === 'reservation-public').outcome.kind, 'completed');
  assert.equal(final.reservations.find(row => row.reservationId === 'reservation-other').outcome.kind, 'pending');
  assert.equal(s.provider.invocationCount, 1);
});

for (const phase of ['capability', 'authorisation']) {
  test(`P-F1 snapshots execution inputs and methods before ${phase} await`, async () => {
    const s = await setup();
    let reached;
    let release;
    const entered = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let authorised;
    let invoked;
    let replacementCalls = 0;
    const provider = {
      marker: 'original',
      async inspectCapabilities() {
        assert.equal(this.marker, 'original');
        if (phase === 'capability') { reached(); await gate; }
        return s.provider.inspectCapabilities();
      },
      async invoke(value, signal) { invoked = structuredClone(value); return s.provider.invoke(value, signal); },
    };
    const policy = {
      async authorise(value) {
        authorised = structuredClone(value);
        if (phase === 'authorisation') { reached(); await gate; }
        return s.gate.authorise(value);
      },
    };
    const input = { ...execution(s), provider, gate: policy };
    const expected = structuredClone({ request: input.request, operation: input.operation, amount: input.amount });
    const running = s.runtime.execute(input);
    await entered;
    input.request.invocationId = 'invocation-other';
    input.request.envelope.payload = 'mutated';
    input.operation.target = 'forbidden';
    input.amount.inputTokens = 9999;
    input.reservationId = 'reservation-other';
    provider.invoke = async () => { replacementCalls++; throw Error('Must not replace the captured method'); };
    policy.authorise = async () => { replacementCalls++; return { allowed: false, reason: 'replacement' }; };
    input.provider = { inspectCapabilities: async () => { replacementCalls++; return {}; }, invoke: provider.invoke };
    input.gate = policy;
    release();
    const completed = await running;
    assert.equal(completed.ok, true);
    assert.equal(completed.value.reservation.reservationId, 'reservation-public');
    assert.deepEqual(completed.value.reservation.amount, expected.amount);
    assert.deepEqual(authorised, expected.operation);
    assert.deepEqual(invoked, expected.request);
    assert.equal(replacementCalls, 0);
    assert.equal(s.provider.invocationCount, 1);
    const starts = (await s.store.snapshot()).value.entries.filter(row => row.key.collection === 'policy.starts');
    assert.deepEqual(starts[0].value.binding, { request: expected.request, operation: expected.operation });
  });
}

for (const returnsOriginalId of [true, false]) {
  test(`P-F1 provider-owned request mutation cannot alter host identity, original result=${returnsOriginalId}`, async () => {
    const s = await setup();
    const provider = {
      inspectCapabilities: () => s.provider.inspectCapabilities(),
      async invoke(value) {
        value.invocationId = 'invocation-mutated';
        value.envelope.payload = 'mutated by provider';
        return { outcome: 'completed', invocationId: returnsOriginalId ? 'invocation-public' : value.invocationId, output: 'public result', usage };
      },
    };
    const result = await s.runtime.execute({ ...execution(s), provider });
    assert.equal(result.ok, true);
    assert.equal(result.value.reservation.invocationId, 'invocation-public');
    assert.equal(result.value.reservation.outcome.kind, returnsOriginalId ? 'completed' : 'unknown_outcome');
    if (!returnsOriginalId) {
      assert.equal(result.value.reservation.outcome.reason, 'invalid_provider_response');
      assert.equal(result.value.output, null);
    }
    const start = (await s.store.snapshot()).value.entries.find(row => row.key.collection === 'policy.starts').value;
    assert.equal(start.binding.request.invocationId, 'invocation-public');
    assert.equal(start.binding.request.envelope.payload, request().envelope.payload);
  });
}
