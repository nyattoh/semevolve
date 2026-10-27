import type { Digest, EpochId, EventId, JsonValue, PeerId, Result, TaskId, TransactionId, UtcTimestamp } from './identity.js';

export interface BudgetLimits {
  readonly maxInvocations: number;
  readonly maxElapsedMs: number;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly maxReasoningTokens: number | null;
  readonly maxCostYen: number | null;
  readonly maxNoProgressSteps: number;
}

export interface TaskRecord {
  readonly taskId: TaskId;
  readonly purpose: string;
  readonly successConditions: readonly string[];
  readonly policyRef: string;
  readonly budget: BudgetLimits;
  readonly startedAt: UtcTimestamp;
  readonly deadline: UtcTimestamp;
  readonly epochId: EpochId | null;
  readonly revision: number;
  readonly cancellationRequestedAt: UtcTimestamp | null;
  readonly stopReason: string | null;
}

export interface AuditEvent {
  readonly eventId: EventId;
  readonly taskId: TaskId;
  readonly actor: PeerId | 'host';
  readonly kind: string;
  readonly occurredAt: UtcTimestamp;
  readonly data: JsonValue;
}

export interface StoreKey {
  readonly collection: string;
  readonly id: string;
}
export interface StoreEntry {
  readonly key: StoreKey;
  readonly value: JsonValue;
}
export interface StoreSnapshot {
  readonly revision: number;
  readonly entries: readonly StoreEntry[];
  readonly events: readonly AuditEvent[];
  readonly digest: Digest;
}

export type StoreMutation =
  | { readonly kind: 'insert'; readonly entry: StoreEntry }
  | { readonly kind: 'replace'; readonly entry: StoreEntry; readonly expectedDigest: Digest };

export interface StoreTransaction {
  readonly transactionId: TransactionId;
  readonly expectedRevision: number;
  readonly mutations: readonly StoreMutation[];
  readonly events: readonly AuditEvent[];
}

export interface TaskStore {
  snapshot(): Promise<Result<StoreSnapshot>>;
  transact(batch: StoreTransaction): Promise<Result<{ readonly revision: number }>>;
  close(): Promise<void>;
}
