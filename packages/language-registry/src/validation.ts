import { canonicalJson, digestJson, isUtcTimestamp } from '@semevolve/core';
import type { ConformanceRecord, LanguageContent, LanguageScope, LanguageStatusEvent, LanguageVersion, ParticipantFingerprint } from './contracts/registry.js';
import type { Epoch, JsonValue } from '@semevolve/core';

export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
export const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
export const unique = (v: unknown): v is string[] => strings(v) && new Set(v).size === v.length;
export const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export const json = (v: unknown): JsonValue => JSON.parse(canonicalJson(v)) as JsonValue;

export function scope(v: unknown): v is LanguageScope {
  return object(v) && exact(v, ['scopeId', 'purpose', 'taskRange', 'participantIds'])
    && text(v.scopeId) && text(v.purpose) && text(v.taskRange) && unique(v.participantIds) && v.participantIds.length > 0;
}

export function fingerprint(v: unknown): v is ParticipantFingerprint {
  return object(v) && exact(v, ['peerId', 'provider', 'modelId', 'cliVersion', 'settingsDigest', 'introductionDigest'])
    && text(v.peerId) && text(v.provider) && (v.modelId === null || text(v.modelId))
    && (v.cliVersion === null || text(v.cliVersion)) && digest(v.settingsDigest) && digest(v.introductionDigest);
}

export function contentOf(v: LanguageVersion): LanguageContent {
  return { parent_ids: v.parent_ids, scope: v.scope, specification_text: v.specification_text,
    public_examples: v.public_examples, change_reason: v.change_reason, compatibility_claims: v.compatibility_claims };
}

export function version(v: unknown): v is LanguageVersion {
  return object(v) && exact(v, ['version_id', 'digest', 'parent_ids', 'scope', 'specification_text', 'public_examples', 'change_reason', 'compatibility_claims'])
    && text(v.version_id) && digest(v.digest) && unique(v.parent_ids) && !v.parent_ids.includes(v.version_id)
    && scope(v.scope) && text(v.specification_text) && text(v.change_reason) && strings(v.compatibility_claims)
    && Array.isArray(v.public_examples) && v.public_examples.every(e => object(e) && exact(e, ['expression', 'explanation', 'counterexample'])
      && typeof e.expression === 'string' && text(e.explanation) && typeof e.counterexample === 'boolean')
    && digestJson(contentOf(v as unknown as LanguageVersion)) === v.digest;
}

export function conformance(v: unknown): v is ConformanceRecord {
  return object(v) && exact(v, ['versionId', 'fingerprint', 'scopeId', 'testSetDigest', 'evaluatorVersion', 'checkIds', 'verdict', 'checkedAt', 'expiresAt'])
    && text(v.versionId) && fingerprint(v.fingerprint) && text(v.scopeId) && digest(v.testSetDigest)
    && text(v.evaluatorVersion) && unique(v.checkIds) && v.checkIds.length > 0
    && ['pass', 'fail', 'inconclusive'].includes(String(v.verdict)) && isUtcTimestamp(v.checkedAt)
    && (v.expiresAt === null || (isUtcTimestamp(v.expiresAt) && v.expiresAt > v.checkedAt));
}

export function status(v: unknown): v is LanguageStatusEvent {
  return object(v) && exact(v, ['eventId', 'versionId', 'scopeId', 'status', 'checkIds', 'reason', 'occurredAt'])
    && text(v.eventId) && text(v.versionId) && text(v.scopeId) && text(v.reason) && isUtcTimestamp(v.occurredAt)
    && unique(v.checkIds) && ['DRAFT', 'CANDIDATE', 'TRIAL', 'ACTIVE', 'RETIRED', 'REJECTED', 'QUARANTINED'].includes(String(v.status));
}

export function epoch(v: unknown): v is Epoch {
  return object(v) && exact(v, ['epochId', 'taskId', 'language', 'contextRevision', 'openedAt', 'sendsClosedAt'])
    && text(v.epochId) && text(v.taskId) && integer(v.contextRevision) && isUtcTimestamp(v.openedAt)
    && (v.sendsClosedAt === null || (isUtcTimestamp(v.sendsClosedAt) && v.sendsClosedAt >= v.openedAt))
    && object(v.language) && exact(v.language, ['mode', 'languageVersionId'])
    && ((v.language.mode === 'bootstrap' && v.language.languageVersionId === null)
      || (v.language.mode === 'bound' && text(v.language.languageVersionId)));
}

export function canonicalConfig(value: unknown): string {
  const copy: unknown = JSON.parse(canonicalJson(value));
  if (!Array.isArray(copy) || copy.length === 0 || !copy.every(v => {
    if (!object(v) || !exact(v, ['scope', 'fingerprints', 'testSetDigest', 'evaluatorVersion']) || !scope(v.scope)
      || !digest(v.testSetDigest) || !text(v.evaluatorVersion) || !Array.isArray(v.fingerprints) || !v.fingerprints.every(fingerprint)) return false;
    const s = v.scope;
    return v.fingerprints.length === s.participantIds.length && new Set(v.fingerprints.map(f => f.peerId)).size === v.fingerprints.length
      && v.fingerprints.every(f => s.participantIds.includes(f.peerId));
  }) || new Set(copy.map(v => v.scope.scopeId)).size !== copy.length) throw new TypeError('Invalid registry scopes');
  return canonicalJson(copy);
}
