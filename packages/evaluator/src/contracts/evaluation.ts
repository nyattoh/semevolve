import type { CheckExecution, CheckResult, Digest, EvidenceId, EvidenceRef, ExecutionId, Interpretation, JsonValue, LanguageVersionId, MessageId, Result, TaskId, UtcTimestamp, Verdict } from '@semevolve/core';

export interface EvaluationRequest {
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly targetMessageId: MessageId;
  readonly languageVersionId: LanguageVersionId;
  readonly dimension: CheckResult['dimension'];
  readonly interpretation: Interpretation;
  readonly expectedConditions: JsonValue;
  readonly evidence: readonly EvidenceRef[];
  readonly inputDigest: Digest;
  readonly evaluatorVersion: string;
  readonly criteriaDigest: Digest;
  readonly scope: string;
}

export interface StorageCheckRequest {
  readonly executionId: ExecutionId;
  readonly taskId: TaskId;
  readonly original: JsonValue;
  readonly retrieved: JsonValue;
  readonly expectedConditions: JsonValue;
  readonly inputDigest: Digest;
  readonly evaluatorVersion: string;
  readonly criteriaDigest: Digest;
  readonly scope: string;
}

export interface StorageCheckResult {
  readonly executionId: ExecutionId;
  readonly inputDigest: Digest;
  readonly evaluatorVersion: string;
  readonly criteriaDigest: Digest;
  readonly scope: string;
  readonly literalRestoration: Verdict;
  readonly meaningPreservation: Verdict;
  readonly retrievalCorrectness: Verdict;
  readonly evidenceIds: readonly EvidenceId[];
  readonly limitation: string | null;
}

export interface EvidenceWithdrawal {
  readonly evidenceId: EvidenceId;
  readonly reason: string;
  readonly withdrawnAt: UtcTimestamp;
}

export interface EvaluationPort {
  evaluate(request: EvaluationRequest): Promise<Result<CheckExecution>>;
  evaluateStorage(request: StorageCheckRequest): Promise<Result<StorageCheckResult>>;
  withdraw(request: EvidenceWithdrawal): Promise<Result<void>>;
}
