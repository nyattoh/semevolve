import { createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import { createPolicyRuntime, policyMutableCollections } from '@semevolve/policy';
import { value } from './fixture.mjs';

export async function policyHost({ maxInvocations = 10, maxNoProgressSteps = 3 } = {}) {
  const store = createMemoryTaskStore({ mutableCollections: policyMutableCollections });
  const clock = { now: hostIdentity.now() };
  const identity = { ...hostIdentity, now: () => clock.now };
  const policy = createPolicyRuntime({ store, identity });
  const task = { taskId: 'public-task', purpose: 'Synthetic evaluator consumer', successConditions: ['Separate mechanism evidence'], policyRef: 'public-policy', budget: { maxInvocations, maxElapsedMs: 60000, maxInputTokens: null, maxOutputTokens: null, maxReasoningTokens: null, maxCostYen: null, maxNoProgressSteps }, startedAt: clock.now, deadline: new Date(Date.parse(clock.now) + 60000).toISOString(), epochId: null, revision: 0, cancellationRequestedAt: null, stopReason: null };
  value(await policy.registerTask(task));
  const budget = {
    async start(binding) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const snapshot = value(await policy.snapshot(task.taskId));
        const result = await policy.reserveAndStart({ taskId: task.taskId, invocationId: binding.invocationId, reservationId: binding.reservationId, expectedRevision: snapshot.revision, amount: { invocations: 1, inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null } });
        if (result.ok) return { ok: true, value: { started: true } };
        if (result.error.code === 'revision_conflict') continue;
        return { ok: false, error: { code: 'unavailable', reason: `Policy ${result.error.code}: ${result.error.reason ?? JSON.stringify(result.error)}` } };
      }
      return { ok: false, error: { code: 'unavailable', reason: 'No reservation progress' } };
    },
    async settle({ reservationId, outcome }) { const result = await policy.settle(reservationId, outcome); return result.ok ? { ok: true, value: undefined } : result; },
  };
  return { store, identity, policy, task, clock, budget };
}
