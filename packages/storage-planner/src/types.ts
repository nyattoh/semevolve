import type { CheckExecution, CheckId, Digest, EventId, HostIdentity, Interpretation, JsonValue, MessageId, Result, RuleVersionId, StorageVersionId, StoredMessage, StoreSnapshot, TaskId, TaskRecord, TaskStore, UtcTimestamp } from '@semevolve/core';
import type { EvaluationPort, StorageCheckRequest, StorageCheckResult } from '@semevolve/evaluator';
import type { LanguageRegistry } from '@semevolve/language-registry';
import type { BudgetLimits } from '@semevolve/core';
import type { Operation, PolicyGate } from '@semevolve/policy';
import type { DerivedUnit, Mapping, MigrationPort, StoragePlanner } from './contracts/storage.js';

export interface RuleDefinition {
  readonly ruleVersionId: RuleVersionId;
  readonly parentIds: readonly RuleVersionId[];
  readonly definition: JsonValue;
  readonly adapterId: string;
}
export interface StructureDefinition {
  readonly storageVersionId: StorageVersionId;
  readonly parentIds: readonly StorageVersionId[];
  readonly definition: JsonValue;
}
export interface OriginalInput {
  readonly message: StoredMessage;
  readonly payloadDigest: Digest;
  readonly receivedAt: UtcTimestamp;
  readonly eventRefs: readonly EventId[];
  readonly interpretationRefs: readonly string[];
  readonly checkRefs: readonly CheckId[];
}
export interface ReferenceContext {
  readonly taskId: TaskId;
  readonly messageId: MessageId;
  readonly languageVersionId: string;
  readonly scope: string;
}
export interface StorageGrant extends Operation {
  readonly ref: string;
  readonly policyRevision: number;
  readonly expiresAt: UtcTimestamp;
  readonly revokedAt: UtcTimestamp | null;
}
export interface StorageReferences {
  readOriginal(snapshot: StoreSnapshot, messageId: MessageId): Promise<Result<OriginalInput | null>>;
  readInterpretation(snapshot: StoreSnapshot, id: string): Promise<Result<{ readonly context: ReferenceContext; readonly interpretation: Interpretation } | null>>;
  readCheck(snapshot: StoreSnapshot, id: CheckId): Promise<Result<{ readonly context: ReferenceContext; readonly execution: CheckExecution } | null>>;
  readTask(snapshot: StoreSnapshot, taskId: TaskId): Promise<Result<TaskRecord | null>>;
  readGrant(snapshot: StoreSnapshot, ref: string): Promise<Result<StorageGrant | null>>;
}
export interface StorageAdapter {
  readonly id: string;
  decompose(original: OriginalInput, mapping: Mapping, identity: HostIdentity): Promise<Result<readonly DerivedUnit[]>>;
  retrieve(query: JsonValue, units: readonly DerivedUnit[], mapping: Mapping): Promise<Result<readonly DerivedUnit[]>>;
  restoreLiteral(units: readonly DerivedUnit[], original: OriginalInput): Promise<Result<string>>;
}
export interface StorageInspection {
  readonly checkId: CheckId;
  readonly mappingDigest: Digest;
  readonly originalSetDigest: Digest;
  readonly querySetDigest: Digest;
  readonly request: StorageCheckRequest;
  readonly result: StorageCheckResult;
  readonly evidenceKind: 'host_evaluation_port';
}
export interface StorageHead {
  readonly generation: string;
  readonly mappingId: string;
  readonly mappingDigest: Digest;
  readonly revision: number;
}
export interface ComparisonPlan {
  readonly originalIds: readonly MessageId[];
  readonly queries: readonly JsonValue[];
  readonly expectedConditions: JsonValue;
  readonly criteriaDigest: Digest;
  readonly evaluatorVersion: string;
  readonly budgetRef: string;
  readonly budget: BudgetLimits;
  readonly environmentRef: string;
  readonly cacheCondition: string;
  readonly measurement: { readonly kind: 'monotonic'; readonly now: () => number }
    | { readonly kind: 'fixture'; readonly now: () => number };
}
export interface StoragePlannerOptions {
  readonly store: TaskStore;
  readonly identity: HostIdentity;
  readonly taskId: TaskId;
  readonly scope: string;
  readonly registry: Pick<LanguageRegistry, 'get'>;
  readonly evaluator: EvaluationPort;
  readonly policy: PolicyGate;
  readonly references: StorageReferences;
  readonly adapters: readonly StorageAdapter[];
  readonly comparison: ComparisonPlan;
  readonly copyAuthorisationRef: string;
}
export interface StorageTrace {
  readonly originals: readonly OriginalInput[];
  readonly units: readonly DerivedUnit[];
  readonly events: StoreSnapshot['events'];
  readonly interpretations: readonly Interpretation[];
  readonly checks: readonly CheckExecution[];
  readonly unknowns: readonly string[];
}
export interface StorageRuntime extends StoragePlanner {
  readonly migration: MigrationPort;
  registerRule(rule: RuleDefinition): Promise<Result<void>>;
  registerStructure(structure: StructureDefinition): Promise<Result<void>>;
  registerMapping(mapping: Mapping): Promise<Result<void>>;
  recordOriginal(messageId: MessageId): Promise<Result<OriginalInput>>;
  inspectMapping(mapping: Mapping): Promise<Result<readonly StorageInspection[]>>;
  recordConformance(mapping: Mapping, checkIds: readonly CheckId[]): Promise<Result<void>>;
  trace(reference: string): Promise<Result<StorageTrace>>;
  head(): Promise<Result<StorageHead | null>>;
}
