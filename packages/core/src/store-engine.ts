import type { ContractError, Result } from './contracts/identity.js';
import type { AuditEvent, StoreEntry, StoreSnapshot, StoreTransaction } from './contracts/task-store.js';
import { canonicalJson, digestJson, isUtcTimestamp } from './identity.js';

export interface StoreOptions { readonly mutableCollections?: readonly string[] }
export type TransactionResult = Result<{ readonly revision: number }>;
export type TransactionRecord = { readonly batch: StoreTransaction; readonly result: TransactionResult };
type Prepared = { result: TransactionResult; entries: Map<string, StoreEntry>; events: readonly AuditEvent[]; repeated: boolean };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = (issue: string): TransactionResult => ({ ok: false, error: { code: 'invalid_input', issues: [issue] } });
const collision = (id: string): TransactionResult => ({ ok: false, error: { code: 'id_collision', id } });
const keyOf = (entry: StoreEntry) => canonicalJson([entry.key.collection, entry.key.id]);

export function copyBatch(value: unknown): StoreTransaction {
  const clean: unknown = JSON.parse(canonicalJson(value));
  if (!object(clean) || !exact(clean, ['transactionId', 'expectedRevision', 'mutations', 'events'])
    || !nonempty(clean.transactionId) || !integer(clean.expectedRevision) || !Array.isArray(clean.mutations)
    || !Array.isArray(clean.events)) throw new TypeError('Invalid transaction');
  for (const mutation of clean.mutations) {
    if (!object(mutation) || !['insert', 'replace'].includes(String(mutation.kind))
      || !exact(mutation, mutation.kind === 'insert' ? ['kind', 'entry'] : ['kind', 'entry', 'expectedDigest'])
      || (mutation.kind === 'replace' && (typeof mutation.expectedDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(mutation.expectedDigest)))
      || !object(mutation.entry) || !exact(mutation.entry, ['key', 'value'])
      || !object(mutation.entry.key) || !exact(mutation.entry.key, ['collection', 'id'])
      || !nonempty(mutation.entry.key.collection) || !nonempty(mutation.entry.key.id)) throw new TypeError('Invalid mutation');
  }
  for (const event of clean.events) {
    if (!object(event) || !exact(event, ['eventId', 'taskId', 'actor', 'kind', 'occurredAt', 'data'])
      || !['eventId', 'taskId', 'actor', 'kind'].every(key => nonempty(event[key]))
      || !isUtcTimestamp(event.occurredAt)) throw new TypeError('Invalid event');
  }
  return clean as unknown as StoreTransaction;
}

export function mutableCollections(options: StoreOptions): readonly string[] {
  const collections = options.mutableCollections ?? [];
  if (!Array.isArray(collections) || !collections.every(nonempty) || new Set(collections).size !== collections.length) throw new TypeError('Invalid mutable collections');
  return [...collections].sort();
}

export class StoreEngine {
  private revision = 0;
  private entries = new Map<string, StoreEntry>();
  private events: readonly AuditEvent[] = [];
  private receipts = new Map<string, { digest: string; result: TransactionResult }>();
  readonly records: TransactionRecord[] = [];
  constructor(readonly mutable: readonly string[]) {}

  prepare(batch: StoreTransaction): Prepared {
    const previous = this.receipts.get(batch.transactionId);
    const failed = (result: TransactionResult, repeated = false): Prepared => ({ result, entries: this.entries, events: this.events, repeated });
    if (previous) return failed(previous.digest === digestJson(batch) ? previous.result : collision(batch.transactionId), true);
    if (batch.expectedRevision !== this.revision) return failed({ ok: false, error: { code: 'revision_conflict', expected: batch.expectedRevision, actual: this.revision } });
    if (!Number.isSafeInteger(this.revision + 1)) return failed(invalid('Revision exhausted'));
    const entries = new Map(this.entries);
    for (const mutation of batch.mutations) {
      const key = keyOf(mutation.entry);
      const previousEntry = entries.get(key);
      if (mutation.kind === 'insert') {
        if (previousEntry) return failed(collision(mutation.entry.key.id));
      } else {
        if (!this.mutable.includes(mutation.entry.key.collection)) return failed(invalid('Collection is immutable'));
        if (!previousEntry || digestJson(previousEntry.value) !== mutation.expectedDigest) return failed(invalid('Entry digest conflict'));
      }
      entries.set(key, mutation.entry);
    }
    const ids = new Set(this.events.map(event => event.eventId));
    for (const event of batch.events) {
      if (ids.has(event.eventId)) return failed(collision(event.eventId));
      ids.add(event.eventId);
    }
    return { result: { ok: true, value: { revision: this.revision + 1 } }, entries, events: [...this.events, ...batch.events], repeated: false };
  }

  commit(batch: StoreTransaction, prepared: Prepared): TransactionResult {
    if (!prepared.repeated) {
      this.entries = prepared.entries;
      this.events = prepared.events;
      if (prepared.result.ok) this.revision = prepared.result.value.revision;
      this.receipts.set(batch.transactionId, { digest: digestJson(batch), result: prepared.result });
      this.records.push({ batch, result: prepared.result });
    }
    return structuredClone(prepared.result);
  }

  snapshot(): StoreSnapshot {
    const snapshot = { revision: this.revision, entries: [...this.entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry), events: this.events };
    return structuredClone({ ...snapshot, digest: digestJson(snapshot) });
  }
}

export const unavailable = (reason: string): { ok: false; error: ContractError } => ({ ok: false, error: { code: 'unavailable', reason } });
export const invalidBatch = (): { ok: false; error: ContractError } => ({ ok: false, error: { code: 'invalid_input', issues: ['Invalid transaction JSON or shape'] } });
