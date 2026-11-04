import { digestJson } from '@semevolve/core';
import { conditions, fixture, identity } from './fixture.mjs';

export const payloads = {
  'public-message': { kind: 'clause_sequence', literal: '候補。変更しない。😀\r\n条件付き。', clauses: [
    { id: 'negative', negation: true, condition: 'C', uncertainty: 'unknown', time: 'before', reference: 'B' },
    { id: 'claim', claim: 'success', alternatives: ['first', 'second'] },
  ] },
  'graph-message': { kind: 'directed_graph', literal: 'AからBは未確定。', nodes: ['A', 'B'], edges: [
    { id: 'edge', from: 'A', to: 'B', negation: false, condition: 'C', uncertainty: 'candidate', time: 'after', reference: 'A', candidates: ['A', 'B'] },
  ] },
};
export const projectionProfile = {
  kind: 'storage-projection-v1', payloads,
  queries: [{ query: { all: true }, messageIds: ['public-message', 'graph-message'] },
    { query: { messageId: 'public-message' }, messageIds: ['public-message'] },
    { query: { messageId: 'graph-message' }, messageIds: ['graph-message'] },
    { query: { messageId: 'absent' }, messageIds: [] }],
};
export function projectionFixture(overrides = {}) {
  const expectedConditions = { ...conditions, storage: structuredClone(projectionProfile) };
  const run = { ...fixture().run, runId: 'projection-run', expectedConditions, criteriaDigest: digestJson(expectedConditions), ...overrides.run };
  return fixture({ ...overrides, run });
}
export function projectionRequest(f, query = { all: true }) {
  const versions = { languageVersionId: f.run.languageVersionId, ruleVersionId: 'public-rule', storageVersionId: 'public-storage' };
  const originals = Object.entries(payloads).map(([id, payload]) => {
    const envelope = { protocol_version: '0.1', message_id: id, task_id: f.run.taskId, epoch_id: 'public-epoch', sender_id: 'peer-a', recipient_ids: ['peer-b'], kind: 'utterance', language_version_id: f.run.languageVersionId, context_revision: 0, causation_ids: [], content_type: 'application/json', payload: JSON.stringify(payload), created_at: identity.now() };
    return { message: { envelope, digest: digestJson(envelope) }, payloadDigest: digestJson(envelope.payload), receivedAt: identity.now(), eventRefs: ['public-event'], interpretationRefs: [], checkRefs: [] };
  });
  const units = originals.filter(o => query.all === true || o.message.envelope.message_id === query.messageId).map(o => ({
    unitId: `${o.message.envelope.message_id}/public-mapping`, source: { messageId: o.message.envelope.message_id, digest: o.payloadDigest, location: { kind: 'range', start: 0, end: o.message.envelope.payload.length, unit: 'utf16_code_unit' } },
    versions: structuredClone(versions), representation: { meaning: structuredClone(payloads[o.message.envelope.message_id]), literalPayload: o.message.envelope.payload },
    eventRefs: [...o.eventRefs], interpretationRefs: [], checkRefs: [], ambiguities: [], createdAt: identity.now(),
  }));
  return rehash({ taskId: f.run.taskId, executionId: identity.newId('execution'), original: { originals, versions, mappingDigest: digestJson({ mapping: 'public-mapping', versions }) },
    retrieved: { literals: Object.fromEntries(originals.map(o => [o.message.envelope.message_id, o.message.envelope.payload])), units, query },
    expectedConditions: f.run.expectedConditions.storage, criteriaDigest: f.run.criteriaDigest, evaluatorVersion: f.run.evaluatorVersion, scope: f.run.scope });
}
export function rehash(request) {
  const { original, retrieved, expectedConditions, criteriaDigest, evaluatorVersion, scope } = request;
  return { ...request, inputDigest: digestJson({ original, retrieved, expectedConditions, criteriaDigest, evaluatorVersion, scope }) };
}
export const verdicts = result => [result.literalRestoration, result.meaningPreservation, result.retrievalCorrectness];
