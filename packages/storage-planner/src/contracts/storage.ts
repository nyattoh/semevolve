import type { CheckId, Digest, EventId, ExecutionId, JsonValue, LanguageVersionId, MessageId, Result, RuleVersionId, StorageVersionId, TaskId, Usage, UtcTimestamp, Verdict } from '@semevolve/core';

export interface VersionCombination {
  readonly languageVersionId: LanguageVersionId;
  readonly ruleVersionId: RuleVersionId;
  readonly storageVersionId: StorageVersionId;
}

export interface OriginalReference {
  readonly messageId: MessageId;
  readonly digest: Digest;
  readonly location:
    | { readonly kind: 'range'; readonly start: number; readonly end: number; readonly unit: 'utf16_code_unit' }
    | { readonly kind: 'unknown'; readonly reason: string };
}

export interface DerivedUnit {
  readonly unitId: string;
  readonly source: OriginalReference;
  readonly versions: VersionCombination;
  readonly representation: JsonValue;
  readonly eventRefs: readonly EventId[];
  readonly interpretationRefs: readonly string[];
  readonly checkRefs: readonly CheckId[];
  readonly ambiguities: readonly string[];
  readonly createdAt: UtcTimestamp;
}

export interface Mapping {
  readonly mappingId: string;
  readonly versions: VersionCombination;
  readonly decompositionSpecification: string;
  readonly retrievalSpecification: string;
  readonly scope: string;
  readonly conformanceRefs: readonly CheckId[];
}

export interface StorageProposal {
  readonly proposalId: string;
  readonly change: 'maintain' | 'data_addition' | 'index_change' | 'structure_change';
  readonly baselineProposalId: string;
  readonly reason: string;
  readonly languageVersionId: LanguageVersionId;
  readonly originalSetDigest: Digest;
  readonly querySetDigest: Digest;
  readonly budgetRef: string;
  readonly mapping: Mapping;
  readonly structureSpecification: string;
  readonly queryExamples: readonly JsonValue[];
  readonly migrationSpecification: string;
  readonly limitations: readonly string[];
  readonly unknowns: readonly string[];
}

export interface StorageMeasurements {
  readonly meaningPreservation: Verdict;
  readonly retrievalCorrectness: Verdict;
  readonly falseRetrievals: number | null;
  readonly missedRetrievals: number | null;
  readonly queryElapsedMs: readonly number[];
  readonly writeElapsedMs: readonly number[];
  readonly dataBytes: number | null;
  readonly indexBytes: number | null;
  readonly introductionUsage: Usage;
  readonly decompositionUsage: Usage;
  readonly retrievalUsage: Usage;
  readonly migrationUsage: Usage;
  readonly recoveryUsage: Usage;
  readonly environmentRef: string;
  readonly cacheCondition: string;
}

export interface StorageComparison {
  readonly executionId: ExecutionId;
  readonly baselineProposalId: string;
  readonly candidateProposalId: string;
  readonly languageVersionId: LanguageVersionId;
  readonly originalSetDigest: Digest;
  readonly querySetDigest: Digest;
  readonly budgetRef: string;
  readonly criteriaDigest: Digest;
  readonly measurements: Readonly<Record<string, StorageMeasurements>>;
  readonly checkRefs: readonly CheckId[];
  readonly limitation: string | null;
}

export interface Migration {
  readonly migrationId: string;
  readonly taskId: TaskId;
  readonly source: VersionCombination;
  readonly target: VersionCombination;
  readonly snapshotDigest: Digest;
  readonly baseRevision: number;
  readonly reconciledThroughRevision: number;
  readonly shadowRef: string;
  readonly checkRefs: readonly CheckId[];
  readonly pendingOperation: null | {
    readonly executionId: ExecutionId;
    readonly operation: 'copy' | 'catch_up' | 'switch' | 'restore';
    readonly expectedRevision: number;
  };
  readonly switchedAtRevision: number | null;
  readonly restoration:
    | { readonly verified: false; readonly reason: string }
    | { readonly verified: true; readonly throughRevision: number; readonly checkRefs: readonly CheckId[] };
}

export interface StoragePlanner {
  registerProposal(proposal: StorageProposal): Promise<Result<void>>;
  compare(baseline: StorageProposal, candidate: StorageProposal): Promise<Result<StorageComparison>>;
  store(messageId: MessageId, mapping: Mapping): Promise<Result<readonly DerivedUnit[]>>;
  retrieve(query: JsonValue, mapping: Mapping): Promise<Result<readonly DerivedUnit[]>>;
}

export interface MigrationPort {
  prepare(migration: Migration): Promise<Result<Migration>>;
  catchUp(migrationId: string, throughRevision: number): Promise<Result<Migration>>;
  switch(request: { readonly migrationId: string; readonly expectedRevision: number; readonly authorisationRef: string }): Promise<Result<Migration>>;
  restore(request: { readonly migrationId: string; readonly expectedRevision: number; readonly authorisationRef: string }): Promise<Result<Migration>>;
  reconcile(migrationId: string): Promise<Result<Migration>>;
}
