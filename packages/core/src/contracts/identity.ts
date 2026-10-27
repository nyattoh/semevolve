declare const identity: unique symbol;

export type Id<Kind extends string> = string & { readonly [identity]: Kind };
export type TaskId = Id<'task'>;
export type EpochId = Id<'epoch'>;
export type MessageId = Id<'message'>;
export type PeerId = Id<'peer'>;
export type InvocationId = Id<'invocation'>;
export type ExecutionId = Id<'execution'>;
export type EventId = Id<'event'>;
export type LanguageVersionId = Id<'language-version'>;
export type RuleVersionId = Id<'rule-version'>;
export type StorageVersionId = Id<'storage-version'>;
export type EvidenceId = Id<'evidence'>;
export type CheckId = Id<'check'>;
export type ReservationId = Id<'reservation'>;
export type TransactionId = Id<'transaction'>;
export type SessionRef = Id<'tombo-session'>;
export type Digest = Id<'sha256'>;
export type UtcTimestamp = Id<'utc-timestamp'>;

export interface HostIdentity {
  newId<Kind extends string>(kind: Kind): Id<Kind>;
  now(): UtcTimestamp;
  digest(value: JsonValue): Digest;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

export type ContractError =
  | { readonly code: 'invalid_input'; readonly issues: readonly string[] }
  | { readonly code: 'revision_conflict'; readonly expected: number; readonly actual: number }
  | { readonly code: 'id_collision'; readonly id: string }
  | { readonly code: 'unavailable'; readonly reason: string };

export type Result<T, E = ContractError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
