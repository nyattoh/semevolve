import { hostIdentity } from '@semevolve/core';
import type { HostIdentity, JsonObject, Result, StoreSnapshot, TaskId, TaskStore } from '@semevolve/core';
import type { PendingTomboUpdate, TomboInspectionInput, TomboInspectionSummary, TomboPort, TomboReconciliation } from './contracts/tombo.js';
import * as v from './validation.js';

export interface ManagedSessionPort {
  inspect(input: TomboInspectionInput): Promise<unknown>;
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
  function summary(result: v.Management): TomboInspectionSummary {
    return { reference: { sessionRef: result.session.binding.sessionId as import('@semevolve/core').SessionRef, revision: result.state.revision },
      unresolvedGapRefs: result.state.gaps.filter(g => g.status !== 'resolved').map(g => g.id), reflectionRequired: result.state.task.reflectionRequired === true,
      canReportCompletion: result.understandingStatus.canReportCompletion, terminationReason: result.sessionStopReason?.reason ?? result.state.stopReason, retrievedAt: identity.now() };
  }
  async function inspect(input: TomboInspectionInput): Promise<Result<TomboInspectionSummary>> {
    if (!v.inspection(input)) return invalid('Invalid TOMBO inspection input');
    const inputDigest = identity.digest(v.serialise(input));
    const claim = await insert(input.taskId, 'tombo.inspect-claims', input.taskId, { schema: 1, input: v.serialise(input), inputDigest, sdkCommit: options.sdkCommit });
    if (!claim.ok) return claim;
    const s = await options.store.snapshot(); if (!s.ok) return s;
    const old = read(s.value, 'tombo.bindings', input.taskId);
    if (old) return v.summary(old.summary) && old.inputDigest === inputDigest ? ok(structuredClone(old.summary)) : unavailable('Invalid TOMBO binding');
    const actual = claim.value ? await options.session.inspect(input) : await options.session.status(input.taskId);
    if (!v.management(actual) || actual.state.taskId !== input.taskId || actual.session.binding.taskId !== input.taskId) return unavailable('SDK inspection state or session unavailable');
    const result = summary(actual);
    const saved = await insert(input.taskId, 'tombo.bindings', input.taskId, { schema: 1, sdkCommit: options.sdkCommit, inputDigest, sessionRef: result.reference.sessionRef, summary: v.serialise(result) });
    return saved.ok ? ok(result) : saved;
  }
  async function pending(update: PendingTomboUpdate): Promise<Result<JsonObject>> {
    const s = await options.store.snapshot(); if (!s.ok) return s;
    const binding = read(s.value, 'tombo.bindings', update.taskId);
    if (!binding || binding.sessionRef !== update.expected.sessionRef || binding.sdkCommit !== options.sdkCommit) return invalid('Task session binding mismatch');
    const value = { schema: 1, update: v.serialise(update), payloadHash: identity.digest(update.payload), updateDigest: identity.digest(v.serialise(update)), sdkCommit: options.sdkCommit };
    const old = read(s.value, 'tombo.pending', update.executionId);
    if (old) return v.same(old, value) ? ok(old) : collision(update.executionId);
    const actual = await options.session.status(update.taskId);
    if (!v.management(actual) || actual.session.binding.sessionId !== update.expected.sessionRef || actual.state.taskId !== update.taskId || actual.state.revision !== update.expected.revision) return invalid('SDK expected revision or session mismatch');
    const saved = await insert(update.taskId, 'tombo.pending', update.executionId, value);
    if (!saved.ok) return saved;
    if (saved.value) await options.boundary?.('pending_committed', update);
    return ok(value);
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
  async function receive(update: PendingTomboUpdate): Promise<Result<{ readonly executionId: PendingTomboUpdate['executionId'] }>> {
    if (!v.update(update)) return invalid('Invalid update or input digest');
    const saved = await pending(update); if (!saved.ok) return saved;
    let actual = await options.session.status(update.taskId);
    if (!v.management(actual)) return unavailable('SDK status unavailable');
    if (!actual.session.updates.some(r => r.id === update.executionId)) actual = await options.session.receive(update);
    if (!v.management(actual)) return unavailable('SDK receive result unavailable');
    const reason = receiptProof(actual, update);
    return reason ? unavailable(reason) : ok({ executionId: update.executionId });
  }
  async function reconcile(update: PendingTomboUpdate): Promise<Result<TomboReconciliation>> {
    if (!v.update(update)) return invalid('Invalid reconciliation input');
    const saved = await pending(update); if (!saved.ok) return saved;
    const s = await options.store.snapshot(); if (!s.ok) return s;
    const old = read(s.value, 'tombo.reconciliation-results', update.executionId);
    if (old) {
      if (!v.summary(old.summary) || old.updateDigest !== identity.digest(v.serialise(update))) return unavailable('Invalid saved reconciliation');
      return ok({ kind: 'reconciled', executionId: update.executionId, summary: structuredClone(old.summary) });
    }
    const unresolved = async (reason: string): Promise<Result<TomboReconciliation>> => {
      const r = await insert(update.taskId, 'tombo.reconciliation-events', identity.digest([update.executionId, reason]), { schema: 1, executionId: update.executionId, reason, updateDigest: identity.digest(v.serialise(update)) });
      return r.ok ? ok({ kind: 'pending', update: structuredClone(update), reason }) : r;
    };
    try {
      let actual = await options.session.status(update.taskId);
      if (!v.management(actual)) return unresolved('SDK state unavailable');
      if (!actual.session.updates.some(r => r.id === update.executionId)) actual = await options.session.receive(update);
      if (!v.management(actual)) return unresolved('SDK receipt state unavailable');
      const before = receiptProof(actual, update); if (before) return unresolved(before);
      const applied = actual.state.appliedExecutions.some(e => e.executionId === update.executionId);
      if (!applied) {
        const claim = await insert(update.taskId, 'tombo.apply-claims', update.executionId, { schema: 1, updateDigest: identity.digest(v.serialise(update)) });
        if (!claim.ok) return claim;
        if (!claim.value) return unresolved('Application already claimed; reconcile the SDK authority without repeating it');
        actual = await options.session.apply(update);
        await options.boundary?.('sdk_updated', update);
      }
      if (!v.management(actual)) return unresolved('SDK update result unavailable');
      const after = receiptProof(actual, update); if (after) return unresolved(after);
      const observation = update.payload.observations[0];
      const execution = actual.state.appliedExecutions.find(e => e.executionId === update.executionId);
      const receipt = actual.session.updates.find(r => r.id === update.executionId);
      if (!observation || !execution || execution.payloadHash !== identity.digest(observation)) return unresolved('Applied execution missing or payload hash differs');
      if (actual.state.pendingAssessmentExecutionIds?.includes(update.executionId) || actual.session.pendingUpdates.some(r => r.id === update.executionId)
        || receipt?.status !== 'applied' || !v.integer(receipt.appliedRevision) || receipt.appliedRevision > actual.state.revision || receipt.appliedRevision < update.expected.revision) return unresolved('Execution or receipt assessment remains pending');
      const result = summary(actual);
      const r = await insert(update.taskId, 'tombo.reconciliation-results', update.executionId, { schema: 1, updateDigest: identity.digest(v.serialise(update)), summary: v.serialise(result) });
      if (!r.ok) {
        if (r.error.code !== 'id_collision') return r;
        const latest = await options.store.snapshot(); if (!latest.ok) return latest;
        const prior = read(latest.value, 'tombo.reconciliation-results', update.executionId);
        if (!prior || !v.summary(prior.summary) || prior.updateDigest !== identity.digest(v.serialise(update))) return r;
        return ok({ kind: 'reconciled', executionId: update.executionId, summary: structuredClone(prior.summary) });
      }
      await options.boundary?.('result_committed', update);
      return ok({ kind: 'reconciled', executionId: update.executionId, summary: result });
    } catch (error) { return unresolved(`SDK reconciliation unknown: ${error instanceof Error ? error.message : 'host error'}`); }
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
