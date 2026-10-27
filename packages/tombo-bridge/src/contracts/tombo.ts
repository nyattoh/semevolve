import type { Digest, EvidenceRef, ExecutionId, Interpretation, JsonValue, Result, SessionRef, TaskId, UtcTimestamp } from '@semevolve/core';

export interface TomboInspectionInput {
  readonly taskId: TaskId;
  readonly contextRevision: number;
  readonly transmissionContract: JsonValue;
  readonly interpretation: Interpretation;
  readonly proposedAction: JsonValue;
  readonly evidence: readonly EvidenceRef[];
  readonly reflectionRequired: true;
}

export interface TomboReference {
  readonly sessionRef: SessionRef;
  readonly revision: number;
}

export interface TomboInspectionSummary {
  readonly reference: TomboReference;
  readonly unresolvedGapRefs: readonly string[];
  readonly reflectionRequired: boolean;
  readonly canReportCompletion: boolean;
  readonly terminationReason: string | null;
  readonly retrievedAt: UtcTimestamp;
}

export interface PendingTomboUpdate {
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly expected: TomboReference;
  readonly inputDigest: Digest;
  readonly payload: JsonValue;
}

export type TomboReconciliation =
  | { readonly kind: 'pending'; readonly update: PendingTomboUpdate; readonly reason: string }
  | { readonly kind: 'reconciled'; readonly executionId: ExecutionId; readonly summary: TomboInspectionSummary };

export interface TomboPort {
  inspect(input: TomboInspectionInput): Promise<Result<TomboInspectionSummary>>;
  receive(update: PendingTomboUpdate): Promise<Result<{ readonly executionId: ExecutionId }>>;
  reconcile(update: PendingTomboUpdate): Promise<Result<TomboReconciliation>>;
}
