import { digestJson } from '@semevolve/core';
import { now } from './fixtures.mjs';

export function evaluationDouble(change = r => r) {
  const requests = [];
  return { requests,
    async evaluateStorage(request) {
      requests.push(structuredClone(request));
      const expected = request.expectedConditions;
      const originalIds = request.original.originals.map(o => o.message.envelope.message_id);
      const literals = request.retrieved.literals;
      const units = request.retrieved.units;
      const query = request.retrieved.query;
      const known = originalIds.every(id => Object.hasOwn(expected.payloads ?? {}, id));
      const literalRestoration = !known ? 'inconclusive' : originalIds.every(id => literals[id] === JSON.stringify(expected.payloads[id])) ? 'pass' : 'fail';
      const meaningPreservation = !known ? 'inconclusive' : units.every(u => {
        const target = expected.payloads[u.source.messageId];
        return target && digestJson(u.representation.meaning) === digestJson(target);
      }) && originalIds.every(id => units.some(u => u.source.messageId === id)) ? 'pass' : 'fail';
      const wanted = query.messageId ? [query.messageId].filter(id => originalIds.includes(id)) : originalIds;
      const retrievalCorrectness = digestJson([...new Set(units.map(u => u.source.messageId))].sort()) === digestJson([...wanted].sort()) ? 'pass' : 'fail';
      return { ok: true, value: change({ executionId: request.executionId, inputDigest: request.inputDigest, evaluatorVersion: request.evaluatorVersion, criteriaDigest: request.criteriaDigest, scope: request.scope, literalRestoration, meaningPreservation, retrievalCorrectness, evidenceIds: ['public-storage-oracle'], limitation: 'synthetic_double; public oracle; no OS isolation or real Evaluator integration' }) };
    },
    async evaluate(r) {
      return { ok: true, value: { executionId: r.executionId, taskId: r.taskId, inputDigest: r.inputDigest, performedAt: now, result: { checkId: 'factual-check', targetMessageId: r.targetMessageId, languageVersionId: r.languageVersionId, dimension: r.dimension, verdict: r.dimension === 'factuality' ? 'fail' : 'pass', scope: r.scope, method: 'deterministic_test', evidenceIds: ['synthetic-failed-event'], evaluatorVersion: r.evaluatorVersion, limitation: 'synthetic_double' }, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: 0, source: 'unavailable' } } };
    },
    async withdraw() { return { ok: true, value: undefined }; },
  };
}
