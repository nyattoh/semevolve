import { canonicalJson, digestJson, isUtcTimestamp } from '@semevolve/core';
import type { JsonObject, JsonValue, Verdict } from '@semevolve/core';
import type { StorageCheckRequest } from './contracts/evaluation.js';
import * as v from './validation.js';

export interface ProjectionConditions {
  readonly kind: 'storage-projection-v1';
  readonly payloads: Readonly<Record<string, JsonValue>>;
  readonly queries: readonly { readonly query: JsonValue; readonly messageIds: readonly string[] }[];
}

export function projectionConditions(x: unknown): x is ProjectionConditions {
  return v.record(x) && Object.keys(x).length === 3 && x.kind === 'storage-projection-v1'
    && v.record(x.payloads) && Object.keys(x.payloads).length > 0
    && Object.entries(x.payloads).every(([id, payload]) => v.text(id) && v.record(payload)
      && (payload.kind === 'clause_sequence' && Array.isArray(payload.clauses)
        || payload.kind === 'directed_graph' && Array.isArray(payload.nodes) && Array.isArray(payload.edges)))
    && Array.isArray(x.queries) && x.queries.length > 0
    && x.queries.every(q => v.record(q) && Object.keys(q).length === 2 && v.json(q.query) && v.strings(q.messageIds)
      && q.messageIds.every(id => v.record(x.payloads) && Object.hasOwn(x.payloads, id)))
    && new Set(x.queries.map(q => v.record(q) ? canonicalJson(q.query!) : '')).size === x.queries.length;
}

export interface ProjectionOriginal {
  readonly messageId: string;
  readonly languageVersionId: string;
  readonly payload: string;
  readonly payloadDigest: string;
  readonly eventRefs: readonly string[];
  readonly interpretationRefs: readonly string[];
  readonly checkRefs: readonly string[];
}
type Originals = { readonly kind: 'valid'; readonly originals: readonly ProjectionOriginal[]; readonly versions: JsonObject }
  | { readonly kind: 'missing' | 'corrupt' };

export function projectionOriginals(request: StorageCheckRequest): Originals {
  const input = request.original;
  if (input === null || v.record(input) && !Object.hasOwn(input, 'originals')) return { kind: 'missing' };
  if (!v.record(input) || !Array.isArray(input.originals) || !v.record(input.versions) || !v.digest(input.mappingDigest)
    || ![input.versions.languageVersionId, input.versions.ruleVersionId, input.versions.storageVersionId].every(v.text)) return { kind: 'corrupt' };
  const originals: ProjectionOriginal[] = [];
  for (const row of input.originals) {
    if (!v.record(row) || !v.record(row.message) || !v.record(row.message.envelope)) return { kind: 'corrupt' };
    const envelope = row.message.envelope;
    if (!v.text(envelope.message_id) || !v.text(envelope.language_version_id) || envelope.task_id !== request.taskId
      || envelope.language_version_id !== input.versions.languageVersionId || typeof envelope.payload !== 'string'
      || row.message.digest !== digestJson(envelope) || row.payloadDigest !== digestJson(envelope.payload)
      || !isUtcTimestamp(row.receivedAt) || !v.strings(row.eventRefs) || !v.strings(row.interpretationRefs) || !v.strings(row.checkRefs)) return { kind: 'corrupt' };
    originals.push({ messageId: envelope.message_id, languageVersionId: envelope.language_version_id, payload: envelope.payload,
      payloadDigest: row.payloadDigest, eventRefs: row.eventRefs, interpretationRefs: row.interpretationRefs, checkRefs: row.checkRefs });
  }
  if (new Set(originals.map(o => o.messageId)).size !== originals.length) return { kind: 'corrupt' };
  return { kind: 'valid', originals, versions: input.versions };
}

export function storageInput(request: StorageCheckRequest): JsonValue {
  const { original, retrieved, expectedConditions, criteriaDigest, evaluatorVersion, scope, taskId } = request;
  return v.record(expectedConditions) && expectedConditions.kind === 'storage-projection-v1'
    ? { original, retrieved, expectedConditions, criteriaDigest, evaluatorVersion, scope }
    : { taskId, original, retrieved, expectedConditions, scope };
}

export interface ProjectionJudgement {
  readonly literalRestoration: Verdict;
  readonly meaningPreservation: Verdict;
  readonly retrievalCorrectness: Verdict;
  readonly limitation: string;
}
const limitation = 'Finite public synthetic whole-payload projection; no real-model or blind-isolation claim';
const combine = (verdicts: readonly Verdict[]): Verdict => verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
const observed = (record: JsonObject, key: string, expected: JsonValue): Verdict => !Object.hasOwn(record, key) ? 'inconclusive' : v.same(record[key], expected) ? 'pass' : 'fail';

export function judgeProjection(request: StorageCheckRequest, rules: ProjectionConditions): ProjectionJudgement {
  const parsed = projectionOriginals(request);
  if (parsed.kind !== 'valid') {
    const verdict = parsed.kind === 'missing' ? 'inconclusive' : 'fail';
    return { literalRestoration: verdict, meaningPreservation: verdict, retrievalCorrectness: verdict, limitation };
  }
  const input = request.retrieved;
  if (!v.record(input)) {
    const verdict = input === null ? 'inconclusive' : 'fail';
    return { literalRestoration: verdict, meaningPreservation: verdict, retrievalCorrectness: verdict, limitation };
  }
  const literals = input.literals;
  const literalRestoration = literals === undefined || literals === null ? 'inconclusive' : !v.record(literals) ? 'fail'
    : combine(parsed.originals.map(o => !Object.hasOwn(literals, o.messageId) || literals[o.messageId] === null ? 'inconclusive'
      : literals[o.messageId] === o.payload ? 'pass' : 'fail'));
  if (!Object.hasOwn(input, 'units') || input.units === null) return { literalRestoration, meaningPreservation: 'inconclusive', retrievalCorrectness: 'inconclusive', limitation };
  if (!Array.isArray(input.units)) return { literalRestoration, meaningPreservation: 'fail', retrievalCorrectness: 'fail', limitation };
  const meanings: Verdict[] = [];
  const selectedIds: string[] = [];
  const unitIds = new Set<string>();
  let invalidSelection = false;
  for (const unit of input.units) {
    if (!v.record(unit) || !v.record(unit.source) || !v.text(unit.source.messageId)) {
      meanings.push('fail'); invalidSelection = true; continue;
    }
    const messageId = unit.source.messageId;
    const original = parsed.originals.find(o => o.messageId === messageId);
    const expected = rules.payloads[messageId];
    selectedIds.push(messageId);
    if (!original || expected === undefined || !v.text(unit.unitId) || unitIds.has(unit.unitId)) {
      meanings.push('fail'); invalidSelection = true; continue;
    }
    unitIds.add(unit.unitId);
    try {
      if (!v.same(JSON.parse(original.payload), expected)) meanings.push('fail');
    } catch { meanings.push('fail'); }
    meanings.push(observed(unit.source, 'digest', original.payloadDigest), observed(unit, 'versions', parsed.versions),
      observed(unit, 'eventRefs', [...original.eventRefs]), observed(unit, 'interpretationRefs', [...original.interpretationRefs]), observed(unit, 'checkRefs', [...original.checkRefs]));
    const location = unit.source.location;
    meanings.push(location === undefined || v.record(location) && location.kind === 'unknown' ? 'inconclusive'
      : v.same(location, { kind: 'range', start: 0, end: original.payload.length, unit: 'utf16_code_unit' }) ? 'pass' : 'fail');
    if (!Object.hasOwn(unit, 'representation')) meanings.push('inconclusive');
    else if (!v.record(unit.representation)) meanings.push('fail');
    else meanings.push(observed(unit.representation, 'meaning', expected), observed(unit.representation, 'literalPayload', original.payload));
    if (!Object.hasOwn(unit, 'ambiguities')) meanings.push('inconclusive');
    else if (!v.strings(unit.ambiguities)) meanings.push('fail');
    else if (unit.ambiguities.length) meanings.push('inconclusive');
    if (!isUtcTimestamp(unit.createdAt)) meanings.push('fail');
  }
  const query = Object.hasOwn(input, 'query') ? rules.queries.find(q => v.same(q.query, input.query)) : undefined;
  const retrievalCorrectness = invalidSelection ? 'fail' : query === undefined ? 'inconclusive'
    : v.same([...new Set(selectedIds)].sort(), [...query.messageIds].sort()) ? 'pass' : 'fail';
  return { literalRestoration, meaningPreservation: combine(meanings), retrievalCorrectness, limitation };
}
