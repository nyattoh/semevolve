import assert from 'node:assert/strict';
import { createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import { createEvaluator } from '@semevolve/evaluator';

export const identity = hostIdentity;
export const conditions = {
  transmission: { kind: 'conditions-v1', checks: [{ path: ['certainty'], equals: 'candidate' }] },
  factuality: { kind: 'conditions-v1', checks: [{ path: ['cause'], equals: 'X' }] },
  authorisation: { kind: 'conditions-v1', checks: [{ path: ['allowed'], equals: true }] },
  task_outcome: { kind: 'conditions-v1', checks: [{ path: ['finished'], equals: true }] },
  storage: { kind: 'storage-v1', meaning: [{ path: ['certainty'], equals: 'candidate' }], retrieval: { path: ['ids'], expected: ['record-a'] } },
};
export function fixture(overrides = {}) {
  const store = overrides.store ?? createMemoryTaskStore();
  const run = { runId: 'public-run', taskId: 'public-task', languageVersionId: 'public-language', evaluatorVersion: 'synthetic-v1', criteriaDigest: identity.digest(conditions), testSetDigest: identity.digest('public-case-set'), scope: 'public-synthetic', checkerId: 'conditions-v1', expectedConditions: conditions, evaluatorId: 'evaluator', synthetic: true, ...overrides.run };
  const runtime = createEvaluator({ store, run, budget: { async start() { return { ok: true, value: { started: true } }; }, async settle() { return { ok: true, value: undefined }; } }, ...overrides });
  return { store, run, runtime };
}
export function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
export const input = () => ({ messageId: 'public-message', receiverId: 'peer-b', payload: { text: 'candidate' }, sharedContext: { current: 1 } });
export async function request(f, dimension = 'transmission', answer = { certainty: 'certain' }, evidence = []) {
  value(await f.runtime.captureInput(input()));
  value(await f.runtime.recordAnswer({ ...input(), answer }));
  const interpretation = value(await f.runtime.recordDisclosure(input()));
  const base = { taskId: f.run.taskId, targetMessageId: interpretation.messageId, languageVersionId: f.run.languageVersionId, dimension, interpretation, evidence, scope: f.run.scope };
  return { ...base, executionId: identity.newId('execution'), expectedConditions: f.run.expectedConditions[dimension], criteriaDigest: f.run.criteriaDigest, evaluatorVersion: f.run.evaluatorVersion, inputDigest: identity.digest(base) };
}
export function storageRequest(f, original, retrieved) {
  const base = { taskId: f.run.taskId, original, retrieved, expectedConditions: f.run.expectedConditions.storage, scope: f.run.scope };
  return { ...base, executionId: identity.newId('execution'), criteriaDigest: f.run.criteriaDigest, evaluatorVersion: f.run.evaluatorVersion, inputDigest: identity.digest(base) };
}
