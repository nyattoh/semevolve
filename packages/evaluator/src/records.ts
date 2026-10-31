import type { HostIdentity, JsonObject, JsonValue, Result, StoreSnapshot, TaskId, TaskStore } from '@semevolve/core';
import * as v from './validation.js';

export const invalid = <T>(issue: string): Result<T> => ({ ok: false, error: { code: 'invalid_input', issues: [issue] } });
export const unavailable = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'unavailable', reason } });
export const collision = <T>(id: string): Result<T> => ({ ok: false, error: { code: 'id_collision', id } });
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export function read(snapshot: StoreSnapshot, collection: string, id: string): JsonObject | undefined {
  const value = snapshot.entries.find(e => e.key.collection === collection && e.key.id === id)?.value;
  if (value === undefined) return undefined;
  if (!v.record(value) || value.schema !== 1) throw new Error('Invalid evaluator record');
  return value;
}
export function records(store: TaskStore, identity: HostIdentity, taskId: TaskId, attempts: number) {
  async function append(snapshot: StoreSnapshot, items: readonly { collection: string; id: string; value: JsonValue }[], kind: string, data: JsonValue): Promise<Result<void>> {
    const result = await store.transact({ transactionId: identity.newId('transaction'), expectedRevision: snapshot.revision,
      mutations: items.map(item => ({ kind: 'insert' as const, entry: { key: { collection: item.collection, id: item.id }, value: item.value } })),
      events: [{ eventId: identity.newId('event'), taskId, actor: 'host', kind, occurredAt: identity.now(), data }] });
    return result.ok ? ok(undefined) : result;
  }
  async function insert(collection: string, id: string, value: JsonObject, kind: string): Promise<Result<JsonObject>> {
    for (let i = 0; i < attempts; i++) {
      const s = await store.snapshot(); if (!s.ok) return s;
      const old = read(s.value, collection, id);
      if (old) return v.same(old, value) ? ok(old) : collision(id);
      const r = await append(s.value, [{ collection, id, value }], kind, { id });
      if (r.ok) return ok(value);
      if (r.error.code !== 'revision_conflict') return r;
    }
    return unavailable('No progress while committing evaluator record');
  }
  async function audit(kind: string, data: JsonValue): Promise<Result<void>> {
    for (let i = 0; i < attempts; i++) {
      const s = await store.snapshot(); if (!s.ok) return s;
      const r = await append(s.value, [], kind, data);
      if (r.ok || r.error.code !== 'revision_conflict') return r;
    }
    return unavailable('No progress saving rejection audit');
  }
  async function rejected<T>(error: { readonly code: 'id_collision'; readonly id: string } | { readonly code: 'unavailable'; readonly reason: string }, data: JsonObject): Promise<Result<T>> {
    try {
      const result = await audit('evaluator.rejected', { ...data, error });
      if (result.ok) return { ok: false, error };
      return unavailable(`Rejection audit unconfirmed for ${error.code}: ${JSON.stringify(result.error)}`);
    } catch (cause) {
      return unavailable(`Rejection audit unconfirmed for ${error.code}: ${cause instanceof Error ? cause.message : 'Store failure'}`);
    }
  }
  return { append, insert, audit, rejected };
}
