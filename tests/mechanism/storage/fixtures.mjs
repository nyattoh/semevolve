import assert from 'node:assert/strict';
import { createMemoryTaskStore, digestJson, hostIdentity } from '@semevolve/core';
import { createLanguageRegistry, registryMutableCollections } from '@semevolve/language-registry';
import { createAllowListPolicyGate } from '@semevolve/policy';
import { createStoragePlanner, storageMutableCollections } from '@semevolve/storage-planner';

export const now = '2026-10-28T00:00:00.000Z';
export const taskId = 'storage-task';
export const scope = 'storage-scope';
export const take = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
export const reject = (r, code = 'invalid_input') => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.error.code, code); };
export const rows = (s, c) => s.entries.filter(e => e.key.collection === c).map(e => e.value);
export const rule = (id = 'R1', adapterId = 'clauses') => ({ ruleVersionId: id, parentIds: [], definition: { shape: 'clause_sequence' }, adapterId });
export const structure = (id = 'S1') => ({ storageVersionId: id, parentIds: [], definition: { shape: 'public-synthetic' } });
export const mapping = (id = 'M1', languageVersionId = 'L1', ruleVersionId = 'R1', storageVersionId = 'S1') => ({ mappingId: id, versions: { languageVersionId, ruleVersionId, storageVersionId }, decompositionSpecification: 'Host registered finite adapter', retrievalSpecification: 'Public query', scope, conformanceRefs: [] });
export const clausePayload = { kind: 'clause_sequence', literal: 'AはBを変更しない。Cなら検査する。原因は不明。😀\r\n検査は成功した。', clauses: [
  { id: 'negative', text: '変更しない', negation: true, condition: 'C', uncertainty: 'unknown', time: 'before', reference: 'B' },
  { id: 'claim', text: '検査は成功した', claim: 'success' },
] };
export const graphPayload = { kind: 'directed_graph', literal: '候補Aと候補B。AからBへの関係は未確定。', nodes: ['A', 'B'], edges: [{ id: 'edge', from: 'A', to: 'B', candidates: ['A', 'B'], uncertainty: 'unknown', condition: 'C', negation: false, time: 'before', reference: 'B' }] };
export function original(id = 'message-1', payload = clausePayload, language = 'L1') {
  const envelope = { protocol_version: '0.1', message_id: id, task_id: taskId, epoch_id: 'epoch-1', sender_id: 'peer-a', recipient_ids: ['peer-b'], kind: 'utterance', language_version_id: language, context_revision: 0, causation_ids: [], content_type: 'application/json', payload: typeof payload === 'string' ? payload : JSON.stringify(payload), created_at: now };
  return { message: { envelope, digest: digestJson(envelope) }, payloadDigest: digestJson(envelope.payload), receivedAt: now, eventRefs: [], interpretationRefs: [], checkRefs: [] };
}
export async function fixture({ store, adapters = [], evaluator, seed = true, plan = {}, referenceChanges = {}, policy } = {}) {
  store ??= createMemoryTaskStore({ mutableCollections: [...registryMutableCollections, ...storageMutableCollections] });
  const clock = { value: now };
  const identity = { ...hostIdentity, now: () => clock.value };
  const registry = createLanguageRegistry({ store, identity, scopes: [{ scope: { scopeId: scope, purpose: 'Synthetic storage', taskRange: 'Synthetic', participantIds: ['peer-a', 'peer-b'] }, fingerprints: ['peer-a', 'peer-b'].map(peerId => ({ peerId, provider: 'synthetic', modelId: null, cliVersion: null, settingsDigest: digestJson({}), introductionDigest: digestJson({}) })), testSetDigest: digestJson('public'), evaluatorVersion: 'synthetic-double-v1' }], inspection: { async readConformance() { return { ok: true, value: null }; } }, transitions: { async inspect() { return { ok: false, error: { code: 'unavailable', reason: 'Not used' } }; } } });
  const context = { taskId, messageId: 'message-1', languageVersionId: 'L1', scope };
  const references = {
    async readOriginal(s, id) { return { ok: true, value: rows(s, 'host.originals').find(o => o.message.envelope.message_id === id) ?? null }; },
    async readTask(s) { return { ok: true, value: rows(s, 'host.tasks')[0] ?? null }; },
    async readCheck(s, id) { return { ok: true, value: rows(s, 'host.checks').find(c => c.execution.result.checkId === id) ?? null }; },
    async readInterpretation(s, id) { return { ok: true, value: rows(s, 'host.interpretations').find(c => c.id === id) ?? null }; },
    async readGrant(s, ref) { return { ok: true, value: rows(s, 'host.grants').find(g => g.ref === ref) ?? null }; },
    ...referenceChanges,
  };
  const grants = ['copy', 'switch', 'restore'].map(name => ({ taskId, name: `storage.${name}`, target: `storage:${digestJson([taskId, scope])}`, ref: `grant-${name}`, policyRevision: 1, expiresAt: '2026-10-29T00:00:00.000Z', revokedAt: null }));
  const budget = { maxInvocations: 100, maxElapsedMs: 60000, maxInputTokens: null, maxOutputTokens: null, maxReasoningTokens: null, maxCostYen: null, maxNoProgressSteps: 10 };
  const comparison = { originalIds: ['message-1'], queries: [{ all: true }], expectedConditions: { kind: 'public-synthetic-oracle' }, criteriaDigest: digestJson('storage-criteria-v1'), evaluatorVersion: 'synthetic-double-v1', budgetRef: 'synthetic-budget', budget, environmentRef: 'public-fixture', cacheCondition: 'cold', measurement: { kind: 'fixture', now: () => 0 }, ...plan };
  const options = { store, identity, taskId, scope, registry, references, adapters, evaluator: evaluator ?? { async evaluate() { return { ok: false, error: { code: 'unavailable', reason: 'No factuality double configured' } }; }, async evaluateStorage() { return { ok: false, error: { code: 'unavailable', reason: 'No storage double configured' } }; }, async withdraw() { return { ok: true, value: undefined }; } }, policy: policy ?? createAllowListPolicyGate({ policyRevision: 1, grants }), comparison, copyAuthorisationRef: 'grant-copy' };
  const runtime = createStoragePlanner(options);
  const append = async (collection, id, value, events = []) => take(await store.transact({ transactionId: identity.newId('transaction'), expectedRevision: take(await store.snapshot()).revision, mutations: [{ kind: 'insert', entry: { key: { collection, id }, value } }], events }));
  const registerLanguage = async (id = 'L1') => {
    const content = { parent_ids: [], scope: { scopeId: scope, purpose: 'Synthetic storage', taskRange: 'Synthetic', participantIds: ['peer-a', 'peer-b'] }, specification_text: 'Public synthetic clauses or directed graph', public_examples: [], change_reason: 'Public fixture', compatibility_claims: [] };
    take(await registry.register({ ...content, version_id: id, digest: digestJson(content) }));
  };
  if (seed) {
    await append('host.tasks', taskId, { taskId, purpose: 'Synthetic storage', successConditions: ['preserve distinctions'], policyRef: 'synthetic-policy', budget, startedAt: now, deadline: '2026-10-29T00:00:00.000Z', epochId: 'epoch-1', revision: 0, cancellationRequestedAt: null, stopReason: null });
    for (const g of grants) await append('host.grants', g.ref, g);
    await registerLanguage();
    await append('host.originals', 'message-1', original());
  }
  return { runtime, store, options, clock, context, append, registerLanguage, async snapshot() { return take(await store.snapshot()); }, async versions(m = mapping(), adapterId = 'clauses') { take(await runtime.registerRule(rule(m.versions.ruleVersionId, adapterId))); take(await runtime.registerStructure(structure(m.versions.storageVersionId))); take(await runtime.registerMapping(m)); }, async certify(m = mapping()) { const checks = take(await runtime.inspectMapping(m)); take(await runtime.recordConformance(m, checks.map(c => c.checkId))); return checks; } };
}
