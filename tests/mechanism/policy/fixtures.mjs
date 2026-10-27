import assert from 'node:assert/strict';
import { createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import * as policy from '@semevolve/policy';
import * as providers from '@semevolve/provider-adapters';

export const initialTime = '2026-01-01T00:00:00.000Z';
export const usage = { inputTokens: 2, outputTokens: 3, reasoningTokens: 1, costYen: 0, elapsedMs: 10, source: 'provider' };
export const amount = { invocations: 1, inputTokens: 4, outputTokens: 5, reasoningTokens: 2, costYen: 0 };

export function task(overrides = {}) {
  return { taskId: 'task-public', purpose: 'Public synthetic policy test', successConditions: ['mechanism only'],
    policyRef: 'policy-public', budget: { maxInvocations: 2, maxElapsedMs: 60000, maxInputTokens: 8,
      maxOutputTokens: 10, maxReasoningTokens: 4, maxCostYen: 0, maxNoProgressSteps: 2 },
    startedAt: initialTime, deadline: '2026-01-01T00:01:00.000Z', epochId: null, revision: 0,
    cancellationRequestedAt: null, stopReason: null, ...overrides };
}

export function request(id = 'invocation-public', payload = 'Public synthetic input') {
  return { invocationId: id, taskId: 'task-public', permittedContext: { source: 'public fixture' },
    envelope: { protocol_version: '0.1', message_id: `message-${id}`, task_id: 'task-public', epoch_id: 'epoch-public',
      sender_id: 'peer-a', recipient_ids: ['peer-b'], kind: 'utterance', language_version_id: null,
      context_revision: 0, causation_ids: [], content_type: 'text/plain', payload, created_at: initialTime } };
}

export function factories() {
  assert.equal(typeof policy.createPolicyRuntime, 'function', 'Policy runtime must enforce persisted reservations before invocation');
  assert.equal(typeof policy.createAllowListPolicyGate, 'function', 'Policy gate must enforce host operations');
  assert.equal(typeof providers.createFixedFakeProvider, 'function', 'A deterministic fake must expose actual invocation counts');
  return { ...policy, ...providers };
}

export async function setup(options = {}) {
  const api = factories();
  let current = initialTime;
  const identity = { ...hostIdentity, now: () => current };
  const store = options.store ?? createMemoryTaskStore({ mutableCollections: api.policyMutableCollections });
  const runtime = api.createPolicyRuntime({ store, identity });
  assert.equal((await runtime.registerTask(options.task ?? task())).ok, true);
  const gate = api.createAllowListPolicyGate({ policyRevision: 1,
    grants: [{ taskId: 'task-public', name: 'synthetic-read', target: 'public-fixture' }] });
  const provider = api.createFixedFakeProvider({ scenario: 'success', usage, ...options.provider });
  const run = (overrides = {}) => runtime.execute({ request: request(), reservationId: 'reservation-public',
    amount, operation: { taskId: 'task-public', name: 'synthetic-read', target: 'public-fixture' },
    gate, provider, ...overrides });
  return { api, identity, runtime, store, gate, provider, run, setTime: value => { current = value; } };
}
