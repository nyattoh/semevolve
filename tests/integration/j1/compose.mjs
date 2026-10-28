import assert from 'node:assert/strict';
import { digestJson, hostIdentity, openFileTaskStore } from '@semevolve/core';
import { createLanguageRegistry, registryMutableCollections } from '@semevolve/language-registry';
import { createPolicyRuntime, createAllowListPolicyGate, policyMutableCollections } from '@semevolve/policy';
import { createFixedFakeProvider } from '@semevolve/provider-adapters';
import { createLocalTransportHub, createTransportEndpoint, transportMutableCollections } from '@semevolve/transport-adapters';

export const initialTime = '2026-10-27T00:00:00.000Z';
export const deadline = '2026-10-27T00:01:00.000Z';
export const taskId = 'j1-task';
export const scope = { scopeId: 'j1-scope', purpose: 'Public synthetic integration', taskRange: 'J1 synthetic task', participantIds: ['peer-a', 'peer-b'] };
export const fingerprints = scope.participantIds.map(peerId => ({ peerId, provider: 'fixed-fake', modelId: 'synthetic-v1', cliVersion: 'synthetic-cli-metadata', settingsDigest: digestJson({}), introductionDigest: digestJson('public introduction') }));
export const criteria = { scope, fingerprints, testSetDigest: digestJson('public-j1-checks'), evaluatorVersion: 'j1-fixed-1' };
export const usage = { inputTokens: 2, outputTokens: 3, reasoningTokens: 1, costYen: 0, elapsedMs: 10, source: 'provider' };
export const amount = { invocations: 1, inputTokens: 4, outputTokens: 5, reasoningTokens: 2, costYen: 0 };
export const mutableCollections = [...new Set([...registryMutableCollections, ...policyMutableCollections, ...transportMutableCollections])];
export const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
export const rows = (snapshot, collection) => snapshot.entries.filter(row => row.key.collection === collection).map(row => row.value);

export function language(version_id = 'j1-language') {
  const content = { parent_ids: [], scope, specification_text: 'Public synthetic relations with negation and conditions. No fixed SVO.', public_examples: [{ expression: 'condition => prohibition', explanation: 'Public example only', counterexample: false }], change_reason: 'Integration fixture', compatibility_claims: ['Synthetic self-report only'] };
  return { ...content, version_id, digest: digestJson(content) };
}

export function epoch(epochId = 'j1-epoch', versionId = 'j1-language', contextRevision = 0) {
  return { epochId, taskId, language: { mode: 'bound', languageVersionId: versionId }, contextRevision, openedAt: initialTime, sendsClosedAt: null };
}

export function envelope(changes = {}) {
  return { protocol_version: '0.1', message_id: 'j1-message', task_id: taskId, epoch_id: 'j1-epoch', sender_id: 'peer-a', recipient_ids: ['peer-b'], kind: 'utterance', language_version_id: 'j1-language', context_revision: 0, causation_ids: [], content_type: 'text/plain', payload: 'Public synthetic input', created_at: initialTime, ...changes };
}

export function observation(e = envelope(), executionId = 'j1-execution', output = 'Public synthetic result') {
  return { executionId, taskId, inputDigest: digestJson(e), performedAt: initialTime, result: { checkId: `check-${executionId}`, targetMessageId: e.message_id, languageVersionId: e.language_version_id, dimension: 'transmission', verdict: 'pass', scope: scope.scopeId, method: 'deterministic_test', evidenceIds: ['public-synthetic-evidence'], evaluatorVersion: criteria.evaluatorVersion, limitation: `Synthetic host observation only: ${output}` }, usage };
}

export async function openComposedHost(directory, options = {}) {
  const clock = { value: options.now ?? initialTime };
  const identity = { ...hostIdentity, now: () => clock.value };
  const store = await openFileTaskStore(directory, { mutableCollections, ...options.storeOptions });
  const proofs = new Map();
  const acquired = new Map(fingerprints.map(f => [f.peerId, { fingerprint: structuredClone(f), digest: language().digest }]));
  const transition = { held: [], previousSendsClosed: false };
  const registry = createLanguageRegistry({ store, identity, scopes: [criteria],
    inspection: { async readConformance(record) { return { ok: true, value: proofs.get(digestJson(record)) ?? null }; } },
    transitions: { async inspect(request, storeRevision) {
      const snapshot = take(await store.snapshot());
      const v = take(await registry.get(request.epoch.language.languageVersionId));
      const applied = new Set(rows(snapshot, 'transport.applications').map(a => a.messageId));
      const pendingMessageIds = rows(snapshot, 'transport.messages').filter(m => m.envelope.epoch_id === request.previousEpochId && !applied.has(m.envelope.message_id)).map(m => m.envelope.message_id);
      return { ok: true, value: { storeRevision, taskId, previousEpochId: request.previousEpochId, epochId: request.epoch.epochId, scopeId: scope.scopeId, previousSendsClosed: transition.previousSendsClosed, pendingMessageIds, heldMessageIds: [...transition.held], acquired: fingerprints.map(f => ({ fingerprint: f, versionId: v?.version_id ?? null, digest: v?.digest ?? null })) } };
    } } });
  const policy = createPolicyRuntime({ store, identity });
  const grants = ['transport.send', 'transport.receive', 'transport.apply'].map(name => ({ taskId, name, target: 'peer-b' }));
  grants.push({ taskId, name: 'synthetic-read', target: 'public-fixture' });
  const gate = createAllowListPolicyGate({ policyRevision: 1, grants: grants.filter(g => g.name !== options.omitGrant) });
  const provider = createFixedFakeProvider(options.provider ?? { usage });
  const hub = createLocalTransportHub(scope.participantIds, identity);
  const endpoints = scope.participantIds.map(peerId => createTransportEndpoint({ store, peerId, identity, policy: gate,
    adapterFor: recipientId => hub.connect(peerId, recipientId),
    async context(e, recipientId) {
      const bound = await registry.getEpoch(e.epoch_id);
      if (!bound.ok) return bound;
      if (!bound.value || bound.value.taskId !== taskId) return { ok: false, error: { code: 'transport_refused', reason: 'epoch_mismatch' } };
      const budget = await policy.snapshot(taskId);
      if (!budget.ok) return budget;
      return { ok: true, value: { taskId, recipientId, authenticatedSenderId: peerId, participantIds: scope.participantIds, epoch: bound.value, now: clock.value, deadline: budget.value.deadline, maxBytes: 65536 } };
    },
    async checkLanguage(e, recipientId) {
      const local = acquired.get(recipientId);
      const result = await registry.resolveLanguage({ epochId: e.epoch_id, languageVersionId: e.language_version_id, contextRevision: e.context_revision, fingerprint: local.fingerprint, digest: local.digest });
      return result.ok ? { ok: true, value: undefined } : result;
    } }));
  const [sender, receiver] = endpoints;
  const host = { store, identity, clock, registry, policy, provider, gate, hub, sender, receiver, acquired, transition,
    async status(versionId, status, checkIds = []) {
      return registry.appendStatus({ eventId: identity.newId('event'), versionId, scopeId: scope.scopeId, status, checkIds, reason: 'Public synthetic transition', occurredAt: clock.value });
    },
    async activate(v = language()) {
      take(await registry.register(v));
      take(await host.status(v.version_id, 'CANDIDATE'));
      take(await host.status(v.version_id, 'TRIAL'));
      const checkIds = [];
      for (const fingerprint of fingerprints) {
        const checkId = `conformance-${v.version_id}-${fingerprint.peerId}`;
        const record = { versionId: v.version_id, fingerprint, scopeId: scope.scopeId, testSetDigest: criteria.testSetDigest, evaluatorVersion: criteria.evaluatorVersion, checkIds: [checkId], verdict: 'pass', checkedAt: clock.value, expiresAt: '2026-10-28T00:00:00.000Z' };
        const check = observation(envelope({ language_version_id: v.version_id }), `execution-${checkId}`);
        check.result.checkId = checkId;
        proofs.set(digestJson(record), { record, independent: true, fixedBeforeRun: true, regressionVerdict: 'pass', checks: [check] });
        take(await registry.recordConformance(record));
        checkIds.push(checkId);
      }
      take(await host.status(v.version_id, 'ACTIVE', checkIds));
      return v;
    },
    async seed() {
      await host.activate();
      take(await registry.selectHead(scope.scopeId, 'j1-language', 0));
      take(await registry.nextEpoch({ taskId, previousEpochId: null, epoch: epoch(), expectedRevision: 0 }));
      take(await policy.registerTask({ taskId, purpose: 'Public J1 composition', successConditions: ['Synthetic mechanism only'], policyRef: 'j1-policy', budget: { maxInvocations: options.maxInvocations ?? 2, maxElapsedMs: 60000, maxInputTokens: 8, maxOutputTokens: 10, maxReasoningTokens: 4, maxCostYen: 0, maxNoProgressSteps: 2 }, startedAt: initialTime, deadline, epochId: 'j1-epoch', revision: 0, cancellationRequestedAt: null, stopReason: null }));
    },
    async executionInput(e = envelope(), id = 'j1-invocation', overrides = {}) {
      const snapshot = take(await store.snapshot());
      const stored = rows(snapshot, 'transport.messages').find(m => m.envelope.message_id === e.message_id);
      assert.ok(stored, 'Execution uses a persisted received message');
      assert.ok(rows(snapshot, 'transport.inbox').some(i => i.messageId === e.message_id), 'Rejected receive cannot execute');
      return { request: { taskId, invocationId: id, envelope: stored.envelope, permittedContext: { source: 'public fixture' } }, reservationId: `reservation-${id}`, amount, operation: { taskId, name: 'synthetic-read', target: 'public-fixture' }, gate, provider, ...overrides };
    },
    async execute(e = envelope(), id = 'j1-invocation', overrides = {}) {
      return policy.execute(await host.executionInput(e, id, overrides));
    },
    async deliver(e = envelope()) {
      take(await sender.stage(e));
      const receipt = take(await sender.dispatch(e.message_id, 'peer-b'));
      const inner = take(await receiver.receive());
      assert.equal(inner.length, 1);
      const inbox = take(inner[0]);
      return { receipt, inbox };
    },
    async deliverAndApply(e = envelope()) {
      const delivery = await host.deliver(e);
      const execution = take(await host.execute(e));
      if (execution.invocation === 'started') take(await receiver.apply(e.message_id, { state: { output: execution.output }, observation: observation(e) }));
      take(await receiver.acknowledge(e.message_id));
      return { ...delivery, execution };
    },
    snapshot: async () => take(await store.snapshot()),
    close: () => store.close(),
  };
  if (options.seed !== false) await host.seed();
  return host;
}
