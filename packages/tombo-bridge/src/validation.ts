import { canonicalJson, digestJson, isUtcTimestamp } from '@semevolve/core';
import type { JsonObject, JsonValue } from '@semevolve/core';
import type { PendingTomboUpdate, TomboInspectionInput, TomboInspectionSummary } from './contracts/tombo.js';

export const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
export const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
export function json(x: unknown): x is JsonValue { try { canonicalJson(x); return true; } catch { return false; } }
export const serialise = (x: unknown): JsonValue => JSON.parse(canonicalJson(x)) as JsonValue;
export const record = (x: unknown): x is JsonObject => object(x) && json(x);
export const same = (a: unknown, b: unknown): boolean => json(a) && json(b) && canonicalJson(a) === canonicalJson(b);
export interface Observation extends JsonObject { readonly executionId: string; readonly probeId: string; readonly outcome: string; readonly evidence: readonly JsonObject[]; readonly toolCalls: number; readonly elapsedMs: number; readonly costYen: number | null }
export interface Receipt extends JsonObject { readonly id: string; readonly source: JsonObject; readonly references: readonly string[]; readonly observations: readonly Observation[] }
export function receipt(x: unknown): x is Receipt {
  if (!record(x) || !text(x.id) || !record(x.source) || !['tool', 'document', 'user_statement'].includes(String(x.source.kind)) || !text(x.source.locator)
    || Object.keys(x.source).some(k => !['kind', 'locator', 'receivedAt'].includes(k)) || x.source.receivedAt !== undefined && !isUtcTimestamp(x.source.receivedAt)
    || Object.keys(x).some(k => !['id', 'source', 'references', 'observations', 'text'].includes(k)) || x.text !== undefined && typeof x.text !== 'string'
    || !Array.isArray(x.references) || !x.references.every(text) || !Array.isArray(x.observations) || x.observations.length !== 1) return false;
  return x.observations.every(o => record(o) && text(o.executionId) && text(o.probeId) && ['completed', 'no_result', 'unavailable', 'error'].includes(String(o.outcome))
    && Array.isArray(o.evidence) && o.evidence.every(record) && (o.outcome === 'completed' || o.evidence.length === 0) && integer(o.toolCalls)
    && typeof o.elapsedMs === 'number' && Number.isFinite(o.elapsedMs) && o.elapsedMs >= 0 && (o.costYen === null || typeof o.costYen === 'number' && Number.isFinite(o.costYen) && o.costYen >= 0));
}
export function update(x: unknown): x is PendingTomboUpdate & { readonly payload: Receipt } {
  return object(x) && text(x.taskId) && text(x.executionId) && object(x.expected) && text(x.expected.sessionRef) && integer(x.expected.revision)
    && digest(x.inputDigest) && receipt(x.payload) && x.payload.id === x.executionId && x.payload.observations[0]?.executionId === x.executionId && digestJson(x.payload) === x.inputDigest;
}
export function inspection(x: unknown): x is TomboInspectionInput {
  return record(x) && text(x.taskId) && integer(x.contextRevision) && json(x.transmissionContract) && json(x.proposedAction) && x.reflectionRequired === true
    && record(x.interpretation) && text(x.interpretation.messageId) && text(x.interpretation.receiverId) && json(x.interpretation.inputSnapshot)
    && digest(x.interpretation.inputDigest) && digestJson(x.interpretation.inputSnapshot) === x.interpretation.inputDigest && json(x.interpretation.answer)
    && isUtcTimestamp(x.interpretation.recordedAt) && (x.interpretation.expectedConditionsDisclosedAt === null || isUtcTimestamp(x.interpretation.expectedConditionsDisclosedAt))
    && Array.isArray(x.evidence) && x.evidence.every(e => record(e) && text(e.evidenceId) && text(e.source) && text(e.scope) && Array.isArray(e.allowedReaders) && e.allowedReaders.every(text) && record(e.content));
}
export interface Management {
  readonly session: { readonly binding: { readonly sessionId: string; readonly taskId: string }; readonly updates: readonly JsonObject[]; readonly pendingUpdates: readonly JsonObject[]; readonly accountingUncertain: boolean; readonly pendingOperation: JsonValue };
  readonly state: { readonly taskId: string; readonly revision: number; readonly task: { readonly reflectionRequired?: boolean }; readonly gaps: readonly { readonly id: string; readonly status: string }[]; readonly appliedExecutions: readonly { readonly executionId: string; readonly payloadHash: string }[]; readonly pendingAssessmentExecutionIds?: readonly string[]; readonly stopReason: string | null };
  readonly understandingStatus: { readonly canReportCompletion: boolean };
  readonly sessionStopReason?: { readonly reason: string } | null;
}
export function management(x: unknown): x is Management {
  if (!record(x) || x.mode !== 'activated-session' || !record(x.session) || !record(x.session.binding) || !text(x.session.binding.sessionId) || !text(x.session.binding.taskId)
    || !Array.isArray(x.session.updates) || !x.session.updates.every(record) || !Array.isArray(x.session.pendingUpdates) || !x.session.pendingUpdates.every(record)
    || typeof x.session.accountingUncertain !== 'boolean' || !json(x.session.pendingOperation) || !record(x.state) || !text(x.state.taskId) || !integer(x.state.revision)
    || !record(x.state.task) || !Array.isArray(x.state.gaps) || !x.state.gaps.every(g => record(g) && text(g.id) && text(g.status))
    || !Array.isArray(x.state.appliedExecutions) || !x.state.appliedExecutions.every(e => record(e) && text(e.executionId) && digest(e.payloadHash))
    || x.state.pendingAssessmentExecutionIds !== undefined && (!Array.isArray(x.state.pendingAssessmentExecutionIds) || !x.state.pendingAssessmentExecutionIds.every(text))
    || !(x.state.stopReason === null || text(x.state.stopReason)) || !record(x.understandingStatus) || typeof x.understandingStatus.canReportCompletion !== 'boolean') return false;
  return x.sessionStopReason === null || x.sessionStopReason === undefined || record(x.sessionStopReason) && text(x.sessionStopReason.reason);
}
export function summary(x: unknown): x is TomboInspectionSummary {
  return object(x) && object(x.reference) && text(x.reference.sessionRef) && integer(x.reference.revision) && Array.isArray(x.unresolvedGapRefs) && x.unresolvedGapRefs.every(text)
    && typeof x.reflectionRequired === 'boolean' && typeof x.canReportCompletion === 'boolean' && (x.terminationReason === null || text(x.terminationReason)) && isUtcTimestamp(x.retrievedAt);
}
