import { canonicalJson, digestJson, isUtcTimestamp } from '@semevolve/core';
import type { ContractError, JsonValue, Result, StoreSnapshot } from '@semevolve/core';
import type { DerivedUnit, Mapping, VersionCombination } from './contracts/storage.js';
import type { OriginalInput, RuleDefinition, StructureDefinition } from './types.js';

export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export const unique = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
export const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
export const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export const json = (v: unknown): JsonValue => JSON.parse(canonicalJson(v)) as JsonValue;
export const rows = (s: StoreSnapshot, collection: string): readonly JsonValue[] => s.entries.filter(e => e.key.collection === collection).map(e => e.value);
export const find = (s: StoreSnapshot, collection: string, id: string): JsonValue | undefined => s.entries.find(e => e.key.collection === collection && e.key.id === id)?.value;
export function manifestUnitDigest(units: readonly DerivedUnit[]): ReturnType<typeof digestJson> {
  const ordered = [...units].sort((left, right) => {
    const a = canonicalJson(left), b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return digestJson(ordered);
}
export class Refusal extends Error { constructor(readonly error: ContractError) { super(JSON.stringify(error)); } }
export function invalid(issue: string): never { throw new Refusal({ code: 'invalid_input', issues: [issue] }); }
export function unavailable(reason: string): never { throw new Refusal({ code: 'unavailable', reason }); }
export function collision(id: string): never { throw new Refusal({ code: 'id_collision', id }); }
export function value<T>(result: Result<T>): T { if (!result.ok) throw new Refusal(result.error); return result.value; }
export async function boundary<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.error };
    if (error instanceof TypeError || error instanceof SyntaxError) return { ok: false, error: { code: 'invalid_input', issues: [error.message] } };
    return { ok: false, error: { code: 'unavailable', reason: String(error) } };
  }
}
export function combination(v: unknown): v is VersionCombination {
  return object(v) && Object.keys(v).length === 3 && text(v.languageVersionId) && text(v.ruleVersionId) && text(v.storageVersionId);
}
export function mappingValid(v: unknown): v is Mapping {
  return object(v) && Object.keys(v).length === 6 && text(v.mappingId) && combination(v.versions) && text(v.scope)
    && text(v.decompositionSpecification) && text(v.retrievalSpecification) && unique(v.conformanceRefs);
}
export function ruleValid(v: unknown): v is RuleDefinition {
  return object(v) && Object.keys(v).length === 4 && text(v.ruleVersionId) && unique(v.parentIds)
    && !v.parentIds.includes(v.ruleVersionId) && Object.hasOwn(v, 'definition') && text(v.adapterId);
}
export function structureValid(v: unknown): v is StructureDefinition {
  return object(v) && Object.keys(v).length === 3 && text(v.storageVersionId) && unique(v.parentIds)
    && !v.parentIds.includes(v.storageVersionId) && Object.hasOwn(v, 'definition');
}
export function originalValid(v: unknown): v is OriginalInput {
  if (!object(v) || Object.keys(v).length !== 6 || !object(v.message) || Object.keys(v.message).length !== 2 || !object(v.message.envelope)
    || !digest(v.message.digest) || !digest(v.payloadDigest) || !isUtcTimestamp(v.receivedAt)
    || !unique(v.eventRefs) || !unique(v.interpretationRefs) || !unique(v.checkRefs)) return false;
  const e = v.message.envelope;
  return e.protocol_version === '0.1' && text(e.message_id) && text(e.task_id) && text(e.epoch_id) && text(e.sender_id)
    && unique(e.recipient_ids) && e.recipient_ids.length > 0 && integer(e.context_revision) && unique(e.causation_ids)
    && ['utterance', 'clarification', 'proposal', 'acceptance', 'rejection', 'language_notice', 'cancellation'].includes(String(e.kind))
    && (e.language_version_id === null || text(e.language_version_id)) && text(e.content_type) && typeof e.payload === 'string'
    && isUtcTimestamp(e.created_at) && Object.keys(e).length === 13
    && digestJson(e) === v.message.digest && digestJson(e.payload) === v.payloadDigest;
}
export function unitValid(v: unknown, original: OriginalInput, mapping: Mapping): v is DerivedUnit {
  if (!object(v) || Object.keys(v).length !== 9 || !text(v.unitId) || !object(v.source) || Object.keys(v.source).length !== 3
    || v.source.messageId !== original.message.envelope.message_id || v.source.digest !== original.payloadDigest
    || !same(v.versions, mapping.versions) || !Object.hasOwn(v, 'representation') || !unique(v.eventRefs) || !unique(v.interpretationRefs)
    || !unique(v.checkRefs) || !Array.isArray(v.ambiguities) || !v.ambiguities.every(text) || !isUtcTimestamp(v.createdAt)) return false;
  const loc = v.source.location;
  if (!object(loc)) return false;
  return (loc.kind === 'range' && Object.keys(loc).length === 4 && loc.unit === 'utf16_code_unit'
    && integer(loc.start) && integer(loc.end) && loc.start <= loc.end && loc.end <= original.message.envelope.payload.length)
    || (loc.kind === 'unknown' && Object.keys(loc).length === 2 && text(loc.reason) && v.ambiguities.length > 0);
}
