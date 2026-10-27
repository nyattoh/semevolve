import type { Operation, PolicyGate } from './contracts/policy.js';
import { integer, nonempty } from './validation.js';

export function createAllowListPolicyGate(options: { readonly policyRevision: number; readonly grants: readonly Operation[] }): PolicyGate {
  if (!integer(options.policyRevision) || !Array.isArray(options.grants)
    || !options.grants.every(grant => [grant.taskId, grant.name, grant.target].every(nonempty))) throw new TypeError('Invalid policy grants');
  const grants = structuredClone(options.grants);
  const revision = options.policyRevision;
  return {
    async authorise(operation) {
      return grants.some(grant => grant.taskId === operation.taskId && grant.name === operation.name && grant.target === operation.target)
        ? { allowed: true, policyRevision: revision } : { allowed: false, reason: 'Operation is not in the host allow-list' };
    },
  };
}
