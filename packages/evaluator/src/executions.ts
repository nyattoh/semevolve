import { runOperation } from '@semevolve/core';
import type { CheckExecution, HostIdentity, JsonObject, JsonValue, Result, TaskStore, Usage } from '@semevolve/core';
import type { OperationStep } from '@semevolve/core';
import type { EvaluationRequest, StorageCheckRequest, StorageCheckResult } from './contracts/evaluation.js';
import type { EvaluatorOptions, EvaluatorRun } from './runtime.js';
import { collision, ok, read, records, unavailable } from './records.js';
import * as v from './validation.js';

export interface ExecutionProduct { readonly result: CheckExecution | StorageCheckResult; readonly evidence: JsonValue; readonly usage: Usage }
export interface ExecutionReservation { readonly collection: string; readonly id: string; readonly value: JsonObject }
export const evaluationSteps = ['judged', 'settled'] as const;
const pending = 'Execution is pending or unknown; no new start permitted';
export function executionIdentity(digest: (value: JsonValue) => string, run: Pick<EvaluatorRun, 'runId' | 'taskId' | 'testSetDigest' | 'criteriaDigest' | 'evaluatorVersion' | 'languageVersionId' | 'scope'>, request: EvaluationRequest | StorageCheckRequest, kind: 'evaluation' | 'storage'): JsonObject {
  const snapshot = 'interpretation' in request ? request.interpretation.inputSnapshot : null;
  const fingerprint = v.record(snapshot) && snapshot.fingerprint !== undefined && v.json(snapshot.fingerprint) ? snapshot.fingerprint : null;
  return { runId: run.runId, taskId: run.taskId, testSetDigest: run.testSetDigest, criteriaDigest: run.criteriaDigest, evaluatorVersion: run.evaluatorVersion,
    languageVersionId: run.languageVersionId, scope: run.scope, executionId: request.executionId, requestDigest: digest(v.serialise({ runId: run.runId, kind, request })), fingerprint };
}
export function executionLog(store: TaskStore, identity: HostIdentity, run: EvaluatorRun, budget: EvaluatorOptions['budget'], attempts: number, timeoutMs: number, signal: AbortSignal | undefined, fault?: (step: OperationStep, name: string) => Promise<void>) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid checker timeout');
  const log = records(store, identity, run.taskId, attempts);
  async function runCheck(request: EvaluationRequest | StorageCheckRequest, kind: 'evaluation' | 'storage', reservations: readonly ExecutionReservation[], judge: (snapshot: import('@semevolve/core').StoreSnapshot, signal: AbortSignal) => Promise<ExecutionProduct>): Promise<Result<CheckExecution | StorageCheckResult>> {
    const requestDigest = identity.digest(v.serialise({ runId: run.runId, kind, request }));
    const operationIdentity = executionIdentity(value => identity.digest(value), run, request, kind);
    const rejection = { operation: kind === 'evaluation' ? 'evaluate' : 'evaluateStorage', runId: run.runId, executionId: request.executionId, requestDigest };
    const resultCollection = kind === 'evaluation' ? 'evaluator.executions' : 'evaluator.storage-results';
    const outcome = await runOperation<CheckExecution | StorageCheckResult>(store, identity, attempts, {
      name: 'evaluator.execution', key: request.executionId, taskId: request.taskId, recover: 'unknown', pendingReason: pending, identity: operationIdentity, steps: evaluationSteps,
      ...(fault ? { fault } : {}),
      intent: snapshot => read(snapshot, 'evaluator.requests', request.executionId) ?? null,
      same: stored => stored.requestDigest === requestDigest && stored.runId === run.runId && v.same(stored.request, request),
      proof: snapshot => {
        const saved = read(snapshot, resultCollection, request.executionId);
        if (!saved || saved.requestDigest !== requestDigest || !v.record(saved.identity) || !Array.isArray(saved.steps)) return null;
        const serialised = v.serialise(saved.result);
        if (!v.record(serialised)) return null;
        if (kind === 'evaluation' && !v.execution(serialised)) return null;
        if (kind === 'storage' && !storageResult(serialised)) return null;
        return { phase: 'saved', result: serialised, identity: saved.identity, steps: saved.steps };
      },
      async prepare() {
        const state = await store.snapshot(); if (!state.ok) return state;
        const writes: ExecutionReservation[] = [];
        for (const item of reservations) {
          const old = read(state.value, item.collection, item.id);
          if (old && !v.same(old, item.value)) return collision(item.id);
          if (!old) writes.push(item);
        }
        const claim = { schema: 1, runId: run.runId, kind, request: v.serialise(request), requestDigest, invocationId: identity.newId('invocation'), reservationId: identity.newId('reservation') };
        return ok({ intent: claim, writes: [{ collection: 'evaluator.requests', id: request.executionId, value: claim }, ...writes], events: [{ kind: 'evaluator.start_claimed', data: { executionId: request.executionId, requestDigest } }] });
      },
      async effect(intent) {
        if (!budget) return unavailable('Budget start is unavailable; claimed execution remains pending');
        if (!v.text(intent.invocationId) || !v.text(intent.reservationId)) return unavailable('Invalid execution intent');
        const binding = { taskId: request.taskId, executionId: request.executionId, invocationId: intent.invocationId as import('@semevolve/core').InvocationId, reservationId: intent.reservationId as import('@semevolve/core').ReservationId };
        let reserved = false;
        const startedAt = performance.now();
        const controller = new AbortController();
        const abort = () => controller.abort('cancelled');
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (controller.signal.aborted) throw new Error('Checker cancelled before start');
          const start = await budget.start(binding);
          if (!start.ok) {
            const event = await store.snapshot();
            if (event.ok) await log.append(event.value, [], 'evaluator.start_refused', { executionId: request.executionId, error: v.serialise(start.error) });
            return start;
          }
          reserved = true;
          const current = await store.snapshot(); if (!current.ok) throw new Error(`Store snapshot failed after budget start: ${JSON.stringify(current.error)}`);
          timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
          let removeAbort = () => {};
          const interrupted = new Promise<never>((_, reject) => {
            const stop = () => reject(new Error(`Checker ${String(controller.signal.reason)}`));
            removeAbort = () => controller.signal.removeEventListener('abort', stop);
            controller.signal.addEventListener('abort', stop, { once: true });
            if (controller.signal.aborted) stop();
          });
          let product: ExecutionProduct;
          try {
            if (controller.signal.aborted) throw new Error(`Checker ${String(controller.signal.reason)}`);
            product = await Promise.race([judge(current.value, controller.signal), interrupted]);
          }
          finally { removeAbort(); }
          const settled = await runOperation(store, identity, attempts, {
            name: 'evaluator.settle', key: request.executionId, taskId: request.taskId, recover: 'unknown', pendingReason: pending,
            identity: { executionId: request.executionId, reservationId: binding.reservationId, outcome: 'completed' }, steps: ['settled'],
            ...(fault ? { fault } : {}),
            intent: snapshot => read(snapshot, 'evaluator.settle-intents', request.executionId) ?? null,
            same: stored => stored.reservationId === binding.reservationId && stored.kind === 'completed',
            proof: snapshot => read(snapshot, 'evaluator.settle-proofs', request.executionId) ?? null,
            async prepare() {
              const row = { schema: 1, reservationId: binding.reservationId, kind: 'completed', usage: v.serialise(product.usage) };
              return ok({ intent: row, writes: [{ collection: 'evaluator.settle-intents', id: request.executionId, value: row }], events: [{ kind: 'evaluator.settle_claimed', data: { executionId: request.executionId, reservationId: binding.reservationId } }] });
            },
            async effect() {
              const completed = await budget.settle({ reservationId: binding.reservationId, outcome: { kind: 'completed', usage: product.usage } });
              if (!completed.ok) return completed;
              return ok({ schema: 1, reservationId: binding.reservationId, settled: true, identity: { executionId: request.executionId, reservationId: binding.reservationId, outcome: 'completed' }, steps: ['settled'] });
            },
            async finish() {
              const row = { schema: 1, reservationId: binding.reservationId, settled: true, identity: { executionId: request.executionId, reservationId: binding.reservationId, outcome: 'completed' }, steps: ['settled'] };
              for (let i = 0; i < attempts; i++) {
                const s = await store.snapshot(); if (!s.ok) return s;
                const old = read(s.value, 'evaluator.settle-proofs', request.executionId);
                if (old) return v.same(old, row) ? ok(row) : collision(request.executionId);
                const written = await log.append(s.value, [{ collection: 'evaluator.settle-proofs', id: request.executionId, value: row }], 'evaluator.settled', { executionId: request.executionId, reservationId: binding.reservationId });
                if (written.ok) return ok(row);
                if (written.error.code !== 'revision_conflict') return written;
              }
              return unavailable('Settlement proof has no progress');
            },
          });
          if (!settled.ok) throw new Error('Settlement is unknown; execution result not promoted');
          const evidence = v.serialise(product.evidence);
          const result = v.serialise(product.result);
          if (!v.record(evidence) || !v.record(result)) return unavailable('Unexpected execution product');
          return ok({ phase: 'product', result, evidence, usage: v.serialise(product.usage), identity: operationIdentity, steps: [...evaluationSteps] });
        } catch (error) {
          if (reserved) {
            const usage: Usage = { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: performance.now() - startedAt, source: 'unavailable' };
            await budget.settle({ reservationId: binding.reservationId, outcome: { kind: 'unknown_outcome', usage, reason: 'Checker or host failed after start' } }).catch(() => undefined);
          }
          const s = await store.snapshot();
          if (s.ok) await log.append(s.value, [], 'evaluator.unknown_outcome', { executionId: request.executionId, reason: error instanceof Error ? error.message : 'Host error' });
          return unavailable(`Execution outcome unknown: ${error instanceof Error ? error.message : 'host error'}`);
        } finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      },
      async finish(_intent, payload) {
        if (payload.phase === 'saved') {
          if (kind === 'evaluation' && v.execution(payload.result)) return ok(structuredClone(payload.result));
          if (kind === 'storage' && storageResult(payload.result)) return ok(structuredClone(payload.result));
          return unavailable('Invalid persisted execution product');
        }
        if (payload.phase !== 'product' || !v.record(payload.result) || !v.record(payload.evidence) || !v.record(payload.usage)) return unavailable('Unexpected execution product');
        for (let i = 0; i < attempts; i++) {
          const s = await store.snapshot(); if (!s.ok) return s;
          const saved = read(s.value, resultCollection, request.executionId);
          if (saved) {
            if (saved.requestDigest !== requestDigest) return unavailable('Invalid persisted execution result');
            if (kind === 'evaluation' && v.execution(saved.result)) return ok(structuredClone(saved.result));
            if (kind === 'storage' && storageResult(saved.result)) return ok(structuredClone(saved.result));
            return unavailable('Invalid persisted execution product');
          }
          const written = await log.append(s.value, [
            { collection: resultCollection, id: request.executionId, value: { schema: 1, requestDigest, result: payload.result, usage: payload.usage, identity: operationIdentity, steps: [...evaluationSteps] } },
            { collection: 'evaluator.evidence', id: `observation-${request.executionId}`, value: { schema: 1, evidence: payload.evidence } },
          ], 'evaluator.completed', { executionId: request.executionId, reservationId: v.text(_intent.reservationId) ? _intent.reservationId : null });
          if (written.ok) {
            if (kind === 'evaluation' && v.execution(payload.result)) return ok(structuredClone(payload.result));
            if (kind === 'storage' && storageResult(payload.result)) return ok(structuredClone(payload.result));
            return unavailable('Unexpected execution product');
          }
          if (written.error.code !== 'revision_conflict') return written;
        }
        return unavailable('Result commit has no progress; retain settled reservation and pending claim');
      },
    });
    if (!outcome.ok && (outcome.error.code === 'id_collision' || (outcome.error.code === 'unavailable' && outcome.error.reason === pending))) return log.rejected(outcome.error, rejection);
    return outcome;
  }
  return { runCheck };
}
export function storageResult(x: unknown): x is StorageCheckResult {
  return v.object(x) && v.text(x.executionId) && v.digest(x.inputDigest) && v.text(x.evaluatorVersion) && v.digest(x.criteriaDigest) && v.text(x.scope)
    && [x.literalRestoration, x.meaningPreservation, x.retrievalCorrectness].every(verdict => ['pass', 'fail', 'inconclusive'].includes(String(verdict)))
    && v.strings(x.evidenceIds) && (x.limitation === null || typeof x.limitation === 'string');
}
