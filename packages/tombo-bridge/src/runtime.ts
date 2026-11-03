import { hostIdentity, runOperation } from '@semevolve/core';
import type { HostIdentity, JsonObject, Result, StoreSnapshot, TaskId, TaskStore } from '@semevolve/core';
import type { OperationSpec, OperationStep } from '@semevolve/core';
import type { PendingTomboUpdate, TomboInspectionInput, TomboInspectionSummary, TomboPort, TomboReconciliation } from './contracts/tombo.js';
import * as v from './validation.js';

export const inspectionSteps = ['activated', 'prepared', 'inspected'] as const;
const pendingSteps = ['recorded'] as const;
const receiveSteps = ['received'] as const;
const applySteps = ['applied'] as const;
export interface InspectionCompletion { readonly actual: unknown; readonly steps: readonly string[] }
export interface ManagedSessionPort {
  inspect(input: TomboInspectionInput): Promise<InspectionCompletion>;
  status(taskId: string): Promise<unknown>;
  receive(update: PendingTomboUpdate): Promise<unknown>;
  apply(update: PendingTomboUpdate): Promise<unknown>;
}
export interface TomboBridgeOptions {
  readonly store: TaskStore;
  readonly session: ManagedSessionPort;
  readonly sdkCommit: '585a1c711d55fdcc4b380343ceba2b3534165d5b';
  readonly identity?: HostIdentity;
  readonly maxAttempts?: number;
  readonly fault?: (step: OperationStep, name: string) => Promise<void>;
  readonly boundary?: (point: 'pending_committed' | 'sdk_updated' | 'result_committed', update: PendingTomboUpdate) => Promise<void>;
}
export function createTomboBridge(options: TomboBridgeOptions): TomboPort {
  const identity = options.identity ?? hostIdentity;
  const attempts = options.maxAttempts ?? 8;
  if (options.sdkCommit !== '585a1c711d55fdcc4b380343ceba2b3534165d5b' || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 64) throw new Error('Invalid fixed SDK configuration');
  function read(s: StoreSnapshot, collection: string, id: string): JsonObject | undefined {
    const found = s.entries.find(e => e.key.collection === collection && e.key.id === id);
    if (!found) return undefined;
    if (!v.record(found.value) || found.value.schema !== 1) throw new Error('Invalid bridge record');
    return found.value;
  }
  async function insert(taskId: TaskId, collection: string, id: string, value: JsonObject): Promise<Result<boolean>> {
    for (let i = 0; i < attempts; i++) {
      const s = await options.store.snapshot(); if (!s.ok) return s;
      const old = read(s.value, collection, id);
      if (old) return v.same(old, value) ? ok(false) : collision(id);
      const result = await options.store.transact({ transactionId: identity.newId('transaction'), expectedRevision: s.value.revision,
        mutations: [{ kind: 'insert', entry: { key: { collection, id }, value } }],
        events: [{ eventId: identity.newId('event'), taskId, actor: 'host', kind: collection, occurredAt: identity.now(), data: { id } }] });
      if (result.ok) return ok(true);
      if (result.error.code !== 'revision_conflict') return result;
    }
    return unavailable('No progress committing bridge record');
  }
  function hooked<T>(spec: OperationSpec<T>): OperationSpec<T> {
    return options.fault ? { ...spec, fault: options.fault } : spec;
  }
  function summary(result: v.Management): TomboInspectionSummary {
    return { reference: { sessionRef: result.session.binding.sessionId as import('@semevolve/core').SessionRef, revision: result.state.revision },
      unresolvedGapRefs: result.state.gaps.filter(g => g.status !== 'resolved').map(g => g.id), reflectionRequired: result.state.task.reflectionRequired === true,
      canReportCompletion: result.understandingStatus.canReportCompletion, terminationReason: result.sessionStopReason?.reason ?? result.state.stopReason, retrievedAt: identity.now() };
  }
  async function inspect(input: TomboInspectionInput): Promise<Result<TomboInspectionSummary>> {
    if (!v.inspection(input)) return invalid('Invalid TOMBO inspection input');
    const inputDigest = identity.digest(v.serialise(input));
    const claim = { schema: 1, input: v.serialise(input), inputDigest, sdkCommit: options.sdkCommit };
    const operationIdentity = { taskId: input.taskId, inputDigest, sdkCommit: options.sdkCommit };
    return runOperation(options.store, identity, attempts, hooked({
      name: 'tombo.inspect', key: input.taskId, taskId: input.taskId, recover: 'rerun', pendingReason: 'Inspect already in flight', identity: operationIdentity, steps: inspectionSteps,
      intent: s => read(s, 'tombo.inspect-claims', input.taskId) ?? null,
      same: stored => stored.inputDigest === inputDigest && stored.sdkCommit === options.sdkCommit && v.same(stored.input, claim.input),
      proof: s => {
        const row = read(s, 'tombo.inspect-proofs', input.taskId);
        return row && row.inputDigest === inputDigest && row.sdkCommit === options.sdkCommit && v.management(row.actual) ? row : null;
      },
      prepare: async () => ok({ intent: claim, writes: [{ collection: 'tombo.inspect-claims', id: input.taskId, value: claim }], events: [{ kind: 'tombo.inspect-claims', data: { id: input.taskId } }] }),
      awaitEffect: async () => { await options.session.status(input.taskId); },
      async effect(_intent, recovery) {
        if (recovery) {
          try { await options.session.status(input.taskId); }
          catch (error) { return unavailable(error instanceof Error ? error.message : 'SDK inspection state or session unavailable'); }
        }
        let product: unknown;
        try { product = await options.session.inspect(input); }
        catch (error) { return unavailable(error instanceof Error ? error.message : 'SDK inspection state or session unavailable'); }
        const steps = v.record(product) && Array.isArray(product.steps) && product.steps.every(step => typeof step === 'string') ? product.steps : null;
        const actual = v.record(product) ? product.actual : undefined;
        if (!steps || !v.management(actual) || actual.state.taskId !== input.taskId || actual.session.binding.taskId !== input.taskId) return unavailable('SDK inspection state or session unavailable');
        return ok({ schema: 1, inputDigest, sdkCommit: options.sdkCommit, actual: v.serialise(actual), identity: operationIdentity, steps: [...steps] });
      },
      async finish(_intent, proof) {
        if (!v.management(proof.actual) || proof.inputDigest !== inputDigest || proof.sdkCommit !== options.sdkCommit) return unavailable('SDK inspection state or session unavailable');
        const recorded = await insert(input.taskId, 'tombo.inspect-proofs', input.taskId, { schema: 1, inputDigest, sdkCommit: options.sdkCommit, actual: v.serialise(proof.actual), identity: operationIdentity, steps: [...inspectionSteps] });
        if (!recorded.ok) return recorded;
        const current = await options.store.snapshot(); if (!current.ok) return current;
        const existing = read(current.value, 'tombo.bindings', input.taskId);
        if (existing) return v.summary(existing.summary) && existing.inputDigest === inputDigest && existing.sdkCommit === options.sdkCommit ? ok(structuredClone(existing.summary)) : unavailable('Invalid TOMBO binding');
        const result = summary(proof.actual);
        const saved = await insert(input.taskId, 'tombo.bindings', input.taskId, { schema: 1, sdkCommit: options.sdkCommit, inputDigest, sessionRef: result.reference.sessionRef, summary: v.serialise(result) });
        if (saved.ok) return ok(result);
        if (saved.error.code !== 'id_collision') return saved;
        const latest = await options.store.snapshot(); if (!latest.ok) return latest;
        const prior = read(latest.value, 'tombo.bindings', input.taskId);
        if (!prior || !v.summary(prior.summary) || prior.inputDigest !== inputDigest || prior.sdkCommit !== options.sdkCommit) return saved;
        return ok(structuredClone(prior.summary));
      },
    }));
  }
  async function ensurePending(update: PendingTomboUpdate): Promise<Result<JsonObject>> {
    const payloadHash = identity.digest(update.payload);
    const updateDigest = identity.digest(v.serialise(update));
    const operationIdentity = { executionId: update.executionId, taskId: update.taskId, updateDigest, payloadHash, sdkCommit: options.sdkCommit };
    const value = { schema: 1, update: v.serialise(update), payloadHash, updateDigest, sdkCommit: options.sdkCommit, identity: operationIdentity, steps: [...pendingSteps] };
    return runOperation(options.store, identity, attempts, hooked({
      name: 'tombo.pending', key: update.executionId, taskId: update.taskId, recover: 'rerun', pendingReason: 'Pending update already in flight', identity: operationIdentity, steps: pendingSteps,
      intent: s => read(s, 'tombo.pending', update.executionId) ?? null,
      same: stored => v.same(stored, value),
      proof: s => { const row = read(s, 'tombo.pending', update.executionId); return row && v.same(row, value) ? row : null; },
      async prepare() {
        const s = await options.store.snapshot(); if (!s.ok) return s;
        const binding = read(s.value, 'tombo.bindings', update.taskId);
        if (!binding || binding.sessionRef !== update.expected.sessionRef || binding.sdkCommit !== options.sdkCommit) return invalid('Task session binding mismatch');
        const actual = await options.session.status(update.taskId);
        if (!v.management(actual) || actual.session.binding.sessionId !== update.expected.sessionRef || actual.state.taskId !== update.taskId || actual.state.revision !== update.expected.revision) return invalid('SDK expected revision or session mismatch');
        return ok({ intent: value, writes: [{ collection: 'tombo.pending', id: update.executionId, value }], events: [{ kind: 'tombo.pending', data: { id: update.executionId } }] });
      },
      async effect(_intent, recovery) {
        if (!recovery) await options.boundary?.('pending_committed', update);
        return ok(value);
      },
      async finish(_intent, proof) { return ok(proof); },
    }));
  }
  function receiptProof(actual: v.Management, update: PendingTomboUpdate): string | null {
    if (actual.session.binding.sessionId !== update.expected.sessionRef || actual.session.binding.taskId !== update.taskId || actual.state.taskId !== update.taskId) return 'SDK session or task differs';
    if (actual.session.accountingUncertain || actual.session.pendingOperation !== null) return 'SDK accounting or operation remains uncertain';
    if (actual.state.revision < update.expected.revision) return 'SDK revision regressed';
    const receipt = actual.session.updates.find(r => r.id === update.executionId);
    if (!receipt || receipt.payloadHash !== identity.digest(update.payload)) return 'Receipt absent or payload hash differs';
    const canonicalReceipt = { id: receipt.id, source: receipt.source, ...(receipt.text === undefined ? {} : { text: receipt.text }), references: receipt.references, observations: receipt.observations };
    if (!v.same(canonicalReceipt, update.payload)) return 'Receipt body differs from saved payload';
    if (receipt.status === 'discarded_unassessed') return 'SDK discarded this observation without assessment';
    return null;
  }
  async function deliver(update: PendingTomboUpdate): Promise<Result<v.Management>> {
    const saved = await ensurePending(update); if (!saved.ok) return saved;
    const operationIdentity = { executionId: update.executionId, taskId: update.taskId, updateDigest: identity.digest(v.serialise(update)), sdkCommit: options.sdkCommit };
    return runOperation(options.store, identity, attempts, hooked({
      name: 'tombo.receive', key: update.executionId, taskId: update.taskId, recover: 'rerun', pendingReason: 'Receive already in flight', identity: operationIdentity, steps: receiveSteps,
      intent: s => read(s, 'tombo.pending', update.executionId) ?? null,
      same: stored => v.same(stored, saved.value),
      proof: () => null,
      prepare: async () => unavailable('Receive intent is the saved pending update'),
      async effect() {
        let actual = await options.session.status(update.taskId);
        if (!v.management(actual)) return unavailable('SDK status unavailable');
        if (!actual.session.updates.some(r => r.id === update.executionId)) actual = await options.session.receive(update);
        if (!v.management(actual)) return unavailable('SDK receive result unavailable');
        const reason = receiptProof(actual, update);
        if (reason) return unavailable(reason);
        const body = v.serialise(actual);
        return v.record(body) ? ok({ ...body, identity: operationIdentity, steps: [...receiveSteps] }) : unavailable('SDK receive result unavailable');
      },
      async finish(_intent, proof) { return v.management(proof) ? ok(proof) : unavailable('SDK receive result unavailable'); },
    }));
  }
  async function receive(update: PendingTomboUpdate): Promise<Result<{ readonly executionId: PendingTomboUpdate['executionId'] }>> {
    if (!v.update(update)) return invalid('Invalid update or input digest');
    const delivered = await deliver(update);
    return delivered.ok ? ok({ executionId: update.executionId }) : delivered;
  }
  async function reconcile(update: PendingTomboUpdate): Promise<Result<TomboReconciliation>> {
    if (!v.update(update)) return invalid('Invalid reconciliation input');
    const saved = await ensurePending(update); if (!saved.ok) return saved;
    const updateDigest = identity.digest(v.serialise(update));
    const operationIdentity = { executionId: update.executionId, taskId: update.taskId, updateDigest, sdkCommit: options.sdkCommit };
    const claim = { schema: 1, updateDigest };
    const unresolved = async (reason: string): Promise<Result<TomboReconciliation>> => {
      const r = await insert(update.taskId, 'tombo.reconciliation-events', identity.digest([update.executionId, reason]), { schema: 1, executionId: update.executionId, reason, updateDigest });
      return r.ok ? ok({ kind: 'pending', update: structuredClone(update), reason }) : r;
    };
    const result = await runOperation<TomboReconciliation>(options.store, identity, attempts, hooked({
      name: 'tombo.apply', key: update.executionId, taskId: update.taskId, recover: 'rerun', pendingReason: 'Application already in flight', identity: operationIdentity, steps: applySteps,
      intent: s => read(s, 'tombo.apply-claims', update.executionId) ?? null,
      same: stored => stored.updateDigest === updateDigest,
      proof: s => {
        const row = read(s, 'tombo.reconciliation-results', update.executionId);
        return row && v.summary(row.summary) && row.updateDigest === updateDigest ? row : null;
      },
      prepare: async () => ok({ intent: claim, writes: [{ collection: 'tombo.apply-claims', id: update.executionId, value: claim }], events: [{ kind: 'tombo.apply-claims', data: { id: update.executionId } }] }),
      async effect() {
        try {
          let actual = await options.session.status(update.taskId);
          if (!v.management(actual)) return unavailable('SDK state unavailable');
          if (!actual.session.updates.some(r => r.id === update.executionId)) actual = await options.session.receive(update);
          if (!v.management(actual)) return unavailable('SDK receipt state unavailable');
          const before = receiptProof(actual, update); if (before) return unavailable(before);
          if (!actual.state.appliedExecutions.some(e => e.executionId === update.executionId)) {
            actual = await options.session.apply(update);
            await options.boundary?.('sdk_updated', update);
          }
          if (!v.management(actual)) return unavailable('SDK update result unavailable');
          const after = receiptProof(actual, update); if (after) return unavailable(after);
          const observation = update.payload.observations[0];
          const execution = actual.state.appliedExecutions.find(e => e.executionId === update.executionId);
          const receipt = actual.session.updates.find(r => r.id === update.executionId);
          if (!observation || !execution || execution.payloadHash !== identity.digest(observation)) return unavailable('Applied execution missing or payload hash differs');
          if (actual.state.pendingAssessmentExecutionIds?.includes(update.executionId) || actual.session.pendingUpdates.some(r => r.id === update.executionId)
            || receipt?.status !== 'applied' || !v.integer(receipt.appliedRevision) || receipt.appliedRevision > actual.state.revision || receipt.appliedRevision < update.expected.revision) return unavailable('Execution or receipt assessment remains pending');
          return ok({ schema: 1, updateDigest, summary: v.serialise(summary(actual)), identity: operationIdentity, steps: [...applySteps] });
        } catch (error) { return unavailable(`SDK reconciliation unknown: ${error instanceof Error ? error.message : 'host error'}`); }
      },
      async finish(_intent, proof) {
        if (!v.summary(proof.summary) || proof.updateDigest !== updateDigest) return unavailable('Invalid saved reconciliation');
        const row = { schema: 1, updateDigest, summary: v.serialise(proof.summary), identity: operationIdentity, steps: [...applySteps] };
        const written = await insert(update.taskId, 'tombo.reconciliation-results', update.executionId, row);
        if (!written.ok) {
          if (written.error.code !== 'id_collision') return written;
          const latest = await options.store.snapshot(); if (!latest.ok) return latest;
          const prior = read(latest.value, 'tombo.reconciliation-results', update.executionId);
          if (!prior || !v.summary(prior.summary) || prior.updateDigest !== updateDigest) return written;
          return ok({ kind: 'reconciled' as const, executionId: update.executionId, summary: structuredClone(prior.summary) });
        }
        if (written.value) await options.boundary?.('result_committed', update);
        return ok({ kind: 'reconciled' as const, executionId: update.executionId, summary: structuredClone(proof.summary) });
      },
    }));
    return result.ok ? result : result.error.code === 'unavailable' ? unresolved(result.error.reason) : result;
  }
  return { inspect: boundary(inspect), receive: boundary(receive), reconcile: boundary(reconcile) };
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const invalid = <T>(issue: string): Result<T> => ({ ok: false, error: { code: 'invalid_input', issues: [issue] } });
const unavailable = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'unavailable', reason } });
const collision = <T>(id: string): Result<T> => ({ ok: false, error: { code: 'id_collision', id } });
function boundary<Input, Output>(action: (input: Input) => Promise<Result<Output>>): (input: Input) => Promise<Result<Output>> {
  return async input => {
    if (!v.json(input)) return invalid('Boundary value is not JSON');
    const copy = structuredClone(input);
    try { return await action(copy); } catch (error) { return unavailable(error instanceof Error ? error.message : 'Bridge failure'); }
  };
}
