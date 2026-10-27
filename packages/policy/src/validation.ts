import { canonicalJson, isUtcTimestamp, type JsonValue, type TaskRecord, type Usage } from '@semevolve/core';
import type { BudgetReservation, ReservationAmount } from './contracts/policy.js';

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const quantity = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export const metrics = ['inputTokens', 'outputTokens', 'reasoningTokens', 'costYen'] as const;
export const limits = { inputTokens: 'maxInputTokens', outputTokens: 'maxOutputTokens', reasoningTokens: 'maxReasoningTokens', costYen: 'maxCostYen' } as const;
export function json(value: unknown): JsonValue { return JSON.parse(canonicalJson(value)) as JsonValue; }

export function validAmount(value: unknown): value is ReservationAmount {
  return object(value) && value.invocations === 1 && metrics.every(key => value[key] === null
    || (key === 'costYen' ? quantity(value[key]) : integer(value[key])));
}

export function validUsage(value: unknown): value is Usage {
  return object(value) && metrics.every(key => value[key] === null
    || (key === 'costYen' ? quantity(value[key]) : integer(value[key])))
    && quantity(value.elapsedMs) && ['provider', 'local_estimate', 'unavailable'].includes(String(value.source))
    && (value.source !== 'unavailable' || metrics.every(key => value[key] === null));
}

export function validOutcome(value: unknown): value is BudgetReservation['outcome'] {
  return object(value) && (value.kind === 'pending' || ((value.kind === 'completed'
    || (value.kind === 'unknown_outcome' && nonempty(value.reason))) && validUsage(value.usage)));
}

export function validTask(value: unknown): value is TaskRecord {
  if (!object(value) || !object(value.budget)) return false;
  const b = value.budget;
  return nonempty(value.taskId) && nonempty(value.purpose) && nonempty(value.policyRef)
    && Array.isArray(value.successConditions) && value.successConditions.every(nonempty)
    && integer(b.maxInvocations) && quantity(b.maxElapsedMs) && b.maxElapsedMs > 0
    && integer(b.maxNoProgressSteps) && b.maxNoProgressSteps > 0
    && metrics.every(key => b[limits[key]] === null || (key === 'costYen' ? quantity(b[limits[key]]) : integer(b[limits[key]])))
    && isUtcTimestamp(value.startedAt) && isUtcTimestamp(value.deadline) && value.deadline > value.startedAt
    && Date.parse(value.deadline) - Date.parse(value.startedAt) <= b.maxElapsedMs
    && (value.epochId === null || nonempty(value.epochId)) && integer(value.revision)
    && (value.cancellationRequestedAt === null || (isUtcTimestamp(value.cancellationRequestedAt) && value.cancellationRequestedAt >= value.startedAt))
    && (value.stopReason === null || nonempty(value.stopReason));
}

export function validReservation(value: unknown): value is BudgetReservation {
  return object(value) && nonempty(value.reservationId) && nonempty(value.taskId) && nonempty(value.invocationId)
    && validAmount(value.amount) && isUtcTimestamp(value.reservedAt) && isUtcTimestamp(value.startedAt)
    && value.reservedAt === value.startedAt && validOutcome(value.outcome);
}

export function unknownUsage(elapsedMs: number): Usage {
  return { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs, source: 'unavailable' };
}
