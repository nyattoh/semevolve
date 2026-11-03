import { setImmediate } from 'node:timers/promises';
import { completionProven } from './completion.js';
import type { HostIdentity, JsonObject, Result, TaskId } from './contracts/identity.js';
import type { StoreSnapshot, TaskStore } from './contracts/task-store.js';

export const operationSteps = ['prepared', 'intent', 'effect'] as const;
export type OperationStep = typeof operationSteps[number];
export interface OperationWrite { readonly collection: string; readonly id: string; readonly value: JsonObject }
export interface OperationEvent { readonly kind: string; readonly data: JsonObject }
export interface OperationPrepared { readonly intent: JsonObject; readonly writes: readonly OperationWrite[]; readonly events: readonly OperationEvent[] }
export interface OperationSpec<T> {
  readonly name: string;
  readonly key: string;
  readonly taskId: TaskId;
  readonly recover: 'rerun' | 'unknown';
  readonly pendingReason: string;
  readonly identity: JsonObject;
  readonly steps: readonly string[];
  intent(snapshot: StoreSnapshot): JsonObject | null;
  same(stored: JsonObject): boolean;
  proof(snapshot: StoreSnapshot): JsonObject | null;
  prepare(): Promise<Result<OperationPrepared>>;
  effect(intent: JsonObject, recovery: boolean): Promise<Result<JsonObject>>;
  finish(intent: JsonObject, proof: JsonObject): Promise<Result<T>>;
  awaitEffect?(intent: JsonObject): Promise<void>;
  fault?(step: OperationStep, name: string): Promise<void>;
}

const flights = new WeakMap<TaskStore, Set<string>>();
const flightSet = (store: TaskStore): Set<string> => {
  let keys = flights.get(store);
  if (!keys) { keys = new Set(); flights.set(store, keys); }
  return keys;
};

export async function runOperation<T>(store: TaskStore, identity: HostIdentity, attempts: number, spec: OperationSpec<T>): Promise<Result<T>> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) return unavailable('Invalid operation attempt limit');
  const flightKey = `${spec.name}\0${spec.key}`;
  const held = () => flightSet(store).has(flightKey);
  async function waitForProof(): Promise<Result<T> | undefined> {
    for (let i = 0; i < attempts; i++) {
      await setImmediate();
      const snap = await store.snapshot();
      if (!snap.ok) return snap;
      const found = await finishFrom(snap.value);
      if (found) return found;
      if (!held()) return undefined;
    }
    return undefined;
  }
  async function finishFrom(snapshot: StoreSnapshot): Promise<Result<T> | undefined> {
    const stored = spec.intent(snapshot);
    const proved = spec.proof(snapshot);
    if (stored && !spec.same(stored)) return collision(spec.key);
    if (!proved || !stored || !completionProven(proved, spec)) return undefined;
    return spec.finish(stored, proved);
  }
  async function runEffect(intent: JsonObject, recovery: boolean): Promise<Result<T>> {
    const keys = flightSet(store);
    if (keys.has(flightKey)) return unavailable(spec.pendingReason);
    keys.add(flightKey);
    try {
      const produced = await spec.effect(intent, recovery);
      if (!produced.ok) return produced;
      if (!completionProven(produced.value, spec)) return unavailable(`Completion proof for ${spec.name} does not bind its identity and every required step`);
      if (spec.fault) await spec.fault('effect', spec.name);
      return spec.finish(intent, produced.value);
    } finally { keys.delete(flightKey); }
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snap = await store.snapshot();
    if (!snap.ok) return snap;
    const stored = spec.intent(snap.value);
    if (stored && !spec.same(stored)) return collision(spec.key);
    const completed = await finishFrom(snap.value);
    if (completed) return completed;
    if (stored) {
      if (held()) {
        try { await spec.awaitEffect?.(stored); }
        catch (error) { return unavailable(error instanceof Error ? error.message : 'Operation failed'); }
        const waited = await waitForProof();
        if (waited) return waited;
        const latest = await store.snapshot();
        if (!latest.ok) return latest;
        const proved = await finishFrom(latest.value);
        if (proved) return proved;
        return unavailable(spec.pendingReason);
      }
      if (spec.recover === 'unknown') return unavailable(spec.pendingReason);
      return runEffect(stored, true);
    }
    const prepared = await spec.prepare();
    if (!prepared.ok) return prepared;
    if (prepared.value.writes.length === 0) return unavailable(`Operation ${spec.name} has no intent`);
    if (spec.fault) await spec.fault('prepared', spec.name);
    const committed = await store.transact({
      transactionId: identity.newId('transaction'), expectedRevision: snap.value.revision,
      mutations: prepared.value.writes.map(item => ({ kind: 'insert' as const, entry: { key: { collection: item.collection, id: item.id }, value: item.value } })),
      events: [...prepared.value.events, { kind: 'operation.intent', data: { name: spec.name, key: spec.key } }].map(event => ({
        eventId: identity.newId('event'), taskId: spec.taskId, actor: 'host' as const, kind: event.kind, occurredAt: identity.now(), data: event.data,
      })),
    });
    if (!committed.ok) { if (committed.error.code === 'revision_conflict') continue; return committed; }
    if (spec.fault) await spec.fault('intent', spec.name);
    return runEffect(prepared.value.intent, false);
  }
  return unavailable(`No progress committing ${spec.name}`);
}

const unavailable = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'unavailable', reason } });
const collision = <T>(id: string): Result<T> => ({ ok: false, error: { code: 'id_collision', id } });
