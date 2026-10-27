import type { CheckId, Digest, EvidenceId, ExecutionId, JsonValue, LanguageVersionId, MessageId, PeerId, TaskId, UtcTimestamp } from './identity.js';

export type EvidenceStatus = 'verified' | 'unverified' | 'unavailable';

export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costYen: number | null;
  readonly elapsedMs: number;
  readonly source: 'provider' | 'local_estimate' | 'unavailable';
}

export type Verdict = 'pass' | 'fail' | 'inconclusive';
export interface CheckResult {
  readonly checkId: CheckId;
  readonly targetMessageId: MessageId;
  readonly languageVersionId: LanguageVersionId;
  readonly dimension: 'transmission' | 'factuality' | 'authorisation' | 'task_outcome';
  readonly verdict: Verdict;
  readonly scope: string;
  readonly method: 'deterministic_test' | 'source_check' | 'human_review' | 'model_judgment';
  readonly evidenceIds: readonly EvidenceId[];
  readonly evaluatorVersion: string;
  readonly limitation: string | null;
}

export interface CheckExecution {
  readonly executionId: ExecutionId;
  readonly taskId: TaskId;
  readonly inputDigest: Digest;
  readonly performedAt: UtcTimestamp;
  readonly result: CheckResult;
  readonly usage: Usage;
}

export interface EvidenceRef {
  readonly evidenceId: EvidenceId;
  readonly source: string;
  readonly scope: string;
  readonly allowedReaders: readonly PeerId[];
  readonly content:
    | { readonly kind: 'retrieved'; readonly body: string; readonly digest: Digest; readonly retrievedAt: UtcTimestamp }
    | { readonly kind: 'unavailable'; readonly reason: string }
    | { readonly kind: 'reference_only' };
}

export interface Interpretation {
  readonly messageId: MessageId;
  readonly receiverId: PeerId;
  readonly inputSnapshot: JsonValue;
  readonly inputDigest: Digest;
  readonly answer: JsonValue;
  readonly recordedAt: UtcTimestamp;
  readonly expectedConditionsDisclosedAt: UtcTimestamp | null;
}
