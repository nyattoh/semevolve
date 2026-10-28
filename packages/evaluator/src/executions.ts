import { setImmediate } from 'node:timers/promises';
import type { CheckExecution, HostIdentity, JsonValue, Result, StoreSnapshot, TaskStore, Usage } from '@semevolve/core';
import type { EvaluationRequest, StorageCheckRequest, StorageCheckResult } from './contracts/evaluation.js';
import type { EvaluatorOptions, EvaluatorRun } from './runtime.js';
import { collision, ok, read, records, unavailable } from './records.js';
import * as v from './validation.js';

export interface ExecutionProduct { readonly result: CheckExecution | StorageCheckResult; readonly evidence: JsonValue; readonly usage: Usage }
export function executionLog(store: TaskStore, identity: HostIdentity, run: EvaluatorRun, budget: EvaluatorOptions['budget'], attempts: number, timeoutMs: number, signal: AbortSignal | undefined) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid checker timeout');
  const log = records(store, identity, run.taskId, attempts);
  async function runCheck(request: EvaluationRequest | StorageCheckRequest, kind: 'evaluation' | 'storage', judge: (snapshot: StoreSnapshot, signal: AbortSignal) => Promise<ExecutionProduct>): Promise<Result<CheckExecution | StorageCheckResult>> {
    const requestDigest = identity.digest(v.serialise({ runId: run.runId, kind, request }));
    let binding: Parameters<NonNullable<EvaluatorOptions['budget']>['start']>[0] | undefined;
    for (let i = 0; i < attempts; i++) {
      const state = await store.snapshot(); if (!state.ok) return state;
      const old = read(state.value, 'evaluator.requests', request.executionId);
      if (old) {
        if (old.requestDigest !== requestDigest || old.runId !== run.runId || !v.same(old.request, request)) return collision(request.executionId);
        const saved = read(state.value, kind === 'evaluation' ? 'evaluator.executions' : 'evaluator.storage-results', request.executionId);
        if (saved) {
          const product: unknown = saved.result;
          if (saved.requestDigest !== requestDigest) return unavailable('Invalid persisted execution result');
          if (kind === 'evaluation' && v.execution(product)) return ok(structuredClone(product));
          if (kind === 'storage' && storageResult(product)) return ok(structuredClone(product));
          return unavailable('Invalid persisted execution product');
        }
        await setImmediate();
        continue;
      }
      binding = { taskId: request.taskId, executionId: request.executionId, invocationId: identity.newId('invocation'), reservationId: identity.newId('reservation') };
      const claim = { schema: 1, runId: run.runId, kind, request: v.serialise(request), requestDigest, invocationId: binding.invocationId, reservationId: binding.reservationId };
      const started = await log.append(state.value, [{ collection: 'evaluator.requests', id: request.executionId, value: claim }], 'evaluator.start_claimed', { executionId: request.executionId, requestDigest });
      if (started.ok) break;
      binding = undefined;
      if (started.error.code !== 'revision_conflict') return started;
    }
    if (!binding) return unavailable('Execution is pending or unknown; no new start permitted');
    if (!budget) return unavailable('Budget start is unavailable; claimed execution remains pending');
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
      const settled = await budget.settle({ reservationId: binding.reservationId, outcome: { kind: 'completed', usage: product.usage } });
      if (!settled.ok) return unavailable('Settlement is unknown; execution result not promoted');
      for (let i = 0; i < attempts; i++) {
        const s = await store.snapshot(); if (!s.ok) return s;
        const result = await log.append(s.value, [
          { collection: kind === 'evaluation' ? 'evaluator.executions' : 'evaluator.storage-results', id: request.executionId, value: { schema: 1, requestDigest, result: v.serialise(product.result), usage: v.serialise(product.usage) } },
          { collection: 'evaluator.evidence', id: `observation-${request.executionId}`, value: { schema: 1, evidence: product.evidence } },
        ], 'evaluator.completed', { executionId: request.executionId, reservationId: binding.reservationId });
        if (result.ok) return ok(structuredClone(product.result));
        if (result.error.code !== 'revision_conflict') return result;
      }
      return unavailable('Result commit has no progress; retain settled reservation and pending claim');
    } catch (error) {
      if (reserved) {
        const usage: Usage = { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: performance.now() - startedAt, source: 'unavailable' };
        await budget.settle({ reservationId: binding.reservationId, outcome: { kind: 'unknown_outcome', usage, reason: 'Checker or host failed after start' } }).catch(() => undefined);
      }
      const s = await store.snapshot();
      if (s.ok) await log.append(s.value, [], 'evaluator.unknown_outcome', { executionId: request.executionId, reason: error instanceof Error ? error.message : 'Host error' });
      return unavailable(`Execution outcome unknown: ${error instanceof Error ? error.message : 'host error'}`);
    } finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return { runCheck };
}
export function storageResult(x: unknown): x is StorageCheckResult {
  return v.object(x) && v.text(x.executionId) && v.digest(x.inputDigest) && v.text(x.evaluatorVersion) && v.digest(x.criteriaDigest) && v.text(x.scope)
    && [x.literalRestoration, x.meaningPreservation, x.retrievalCorrectness].every(verdict => ['pass', 'fail', 'inconclusive'].includes(String(verdict)))
    && v.strings(x.evidenceIds) && (x.limitation === null || typeof x.limitation === 'string');
}
