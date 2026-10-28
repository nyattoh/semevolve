import assert from 'node:assert/strict';
import { createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import { createTomboBridge } from '@semevolve/tombo-bridge';

export const commit = '585a1c711d55fdcc4b380343ceba2b3534165d5b';
export const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
export function input() { return { taskId: 'public-task', contextRevision: 1, transmissionContract: { certainty: 'candidate' }, interpretation: { messageId: 'public-message', receiverId: 'peer-b', inputSnapshot: { text: 'candidate' }, inputDigest: hostIdentity.digest({ text: 'candidate' }), answer: { certainty: 'candidate' }, recordedAt: hostIdentity.now(), expectedConditionsDisclosedAt: null }, proposedAction: { kind: 'read' }, evidence: [], reflectionRequired: true }; }
export function update(reference) {
  const payload = { id: 'public-execution', source: { kind: 'tool', locator: 'public-synthetic-test' }, references: [], observations: [{ executionId: 'public-execution', probeId: 'public-probe', outcome: 'unavailable', evidence: [], toolCalls: 1, elapsedMs: 1, costYen: null }] };
  return { taskId: 'public-task', executionId: 'public-execution', expected: reference, inputDigest: hostIdentity.digest(payload), payload };
}
export function management() {
  return { mode: 'activated-session', session: { binding: { sessionId: 'public-session', taskId: 'public-task' }, updates: [], pendingUpdates: [], pendingOperation: null, accountingUncertain: false }, state: { taskId: 'public-task', revision: 1, task: { reflectionRequired: true }, gaps: [{ id: 'public-gap', importance: 'required', status: 'open' }], appliedExecutions: [], pendingAssessmentExecutionIds: [], stopReason: null, usage: { modelCalls: 1, costYen: null } }, understandingStatus: { requiredGapIds: ['public-gap'], reflectionStatus: 'missing', canReportCompletion: false }, sessionStopReason: null };
}
export function fixture(options = {}) {
  const state = management();
  const calls = { receive: 0, apply: 0 };
  const session = {
    async inspect() { return structuredClone(state); }, async status() { return structuredClone(state); },
    async receive(req) {
      calls.receive++;
      const receipt = { ...structuredClone(req.payload), payloadHash: hostIdentity.digest(req.payload), status: 'received_unassessed', appliedRevision: null };
      if (!state.session.updates.some(r => r.id === receipt.id)) state.session.updates.push(receipt);
      state.session.pendingUpdates = state.session.updates.filter(r => r.status !== 'applied');
      return structuredClone(state);
    },
    async apply(req) {
      calls.apply++;
      state.state.revision++;
      const observation = req.payload.observations[0];
      state.state.appliedExecutions.push({ executionId: req.executionId, payloadHash: hostIdentity.digest(observation), probeId: observation.probeId, outcome: observation.outcome });
      state.session.updates[0].status = 'applied'; state.session.updates[0].appliedRevision = state.state.revision;
      state.session.pendingUpdates = [];
      return structuredClone(state);
    },
  };
  const store = options.store ?? createMemoryTaskStore();
  return { state, calls, session, store, bridge: createTomboBridge({ store, session, sdkCommit: commit, ...options }) };
}
