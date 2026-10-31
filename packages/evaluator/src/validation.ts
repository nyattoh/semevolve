import { canonicalJson, isUtcTimestamp } from '@semevolve/core';
import type { CheckExecution, EvidenceRef, Interpretation, JsonObject, JsonValue, Usage } from '@semevolve/core';

export const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
export const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(text) && new Set(x).size === x.length;
export function json(x: unknown): x is JsonValue {
  try { canonicalJson(x as JsonValue); return true; } catch { return false; }
}
export function serialise(x: unknown): JsonValue {
  if (!json(x)) throw new Error('Non-JSON boundary value');
  return JSON.parse(canonicalJson(x)) as JsonValue;
}
export const same = (a: unknown, b: unknown): boolean => json(a) && json(b) && canonicalJson(a) === canonicalJson(b);
export function record(x: unknown): x is JsonObject { return object(x) && json(x); }
export function interpretation(x: unknown): x is Interpretation {
  return object(x) && text(x.messageId) && text(x.receiverId) && json(x.inputSnapshot) && digest(x.inputDigest)
    && json(x.answer) && isUtcTimestamp(x.recordedAt) && (x.expectedConditionsDisclosedAt === null || isUtcTimestamp(x.expectedConditionsDisclosedAt));
}
export function evidence(x: unknown): x is EvidenceRef {
  if (!object(x) || !text(x.evidenceId) || !text(x.source) || !text(x.scope) || !strings(x.allowedReaders) || x.allowedReaders.length === 0 || !object(x.content)) return false;
  const c = x.content;
  return c.kind === 'reference_only' || c.kind === 'unavailable' && text(c.reason)
    || c.kind === 'retrieved' && typeof c.body === 'string' && digest(c.digest) && isUtcTimestamp(c.retrievedAt);
}
export function usage(x: unknown): x is Usage {
  if (!object(x)) return false;
  return [x.inputTokens, x.outputTokens, x.reasoningTokens].every(n => n === null || Number.isSafeInteger(n) && Number(n) >= 0)
    && (x.costYen === null || typeof x.costYen === 'number' && Number.isFinite(x.costYen) && x.costYen >= 0)
    && typeof x.elapsedMs === 'number' && Number.isFinite(x.elapsedMs) && x.elapsedMs >= 0
    && ['provider', 'local_estimate', 'unavailable'].includes(String(x.source));
}
export function execution(x: unknown): x is CheckExecution {
  if (!object(x) || !text(x.executionId) || !text(x.taskId) || !digest(x.inputDigest) || !isUtcTimestamp(x.performedAt) || !usage(x.usage) || !object(x.result)) return false;
  const r = x.result;
  return [r.checkId, r.targetMessageId, r.languageVersionId, r.scope, r.evaluatorVersion].every(text)
    && ['transmission', 'factuality', 'authorisation', 'task_outcome'].includes(String(r.dimension))
    && ['pass', 'fail', 'inconclusive'].includes(String(r.verdict))
    && ['deterministic_test', 'source_check'].includes(String(r.method)) && strings(r.evidenceIds)
    && (r.limitation === null || typeof r.limitation === 'string');
}
