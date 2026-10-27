import { createMemoryTaskStore, hostIdentity, type TaskRecord } from '@semevolve/core';
import { createPolicyRuntime, createAllowListPolicyGate, policyMutableCollections, type Budget, type PolicyGate } from '@semevolve/policy';
import { createFixedFakeProvider, type PeerRequest, type ProviderAdapter } from '@semevolve/provider-adapters';

export async function policyConsumer(task: TaskRecord, request: PeerRequest) {
  const store = createMemoryTaskStore({ mutableCollections: policyMutableCollections });
  const runtime = createPolicyRuntime({ store });
  const budget: Budget = runtime;
  const gate: PolicyGate = createAllowListPolicyGate({ policyRevision: 0,
    grants: [{ taskId: task.taskId, name: 'synthetic-read', target: 'public-fixture' }] });
  const provider: ProviderAdapter = createFixedFakeProvider();
  await runtime.registerTask(task);
  const result = await runtime.execute({ request, reservationId: hostIdentity.newId('reservation'),
    amount: { invocations: 1, inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null },
    operation: { taskId: task.taskId, name: 'synthetic-read', target: 'public-fixture' }, provider, gate });
  await budget.snapshot(task.taskId);
  return result;
}
