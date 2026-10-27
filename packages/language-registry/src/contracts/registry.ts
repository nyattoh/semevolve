import type { CheckId, Digest, Epoch, EpochId, EventId, LanguageVersionId, PeerId, Result, TaskId, UtcTimestamp, Verdict } from '@semevolve/core';

export type LanguageStatus = 'DRAFT' | 'CANDIDATE' | 'TRIAL' | 'ACTIVE' | 'RETIRED' | 'REJECTED' | 'QUARANTINED';
export interface LanguageScope {
  readonly scopeId: string;
  readonly purpose: string;
  readonly taskRange: string;
  readonly participantIds: readonly PeerId[];
}
export interface LanguageContent {
  readonly parent_ids: readonly LanguageVersionId[];
  readonly scope: LanguageScope;
  readonly specification_text: string;
  readonly public_examples: readonly { readonly expression: string; readonly explanation: string; readonly counterexample: boolean }[];
  readonly change_reason: string;
  readonly compatibility_claims: readonly string[];
}
export interface LanguageVersion extends LanguageContent {
  readonly version_id: LanguageVersionId;
  readonly digest: Digest;
}
export interface LanguageStatusEvent {
  readonly eventId: EventId;
  readonly versionId: LanguageVersionId;
  readonly scopeId: string;
  readonly status: LanguageStatus;
  readonly checkIds: readonly CheckId[];
  readonly reason: string;
  readonly occurredAt: UtcTimestamp;
}
export interface ParticipantFingerprint {
  readonly peerId: PeerId;
  readonly provider: string;
  readonly modelId: string | null;
  readonly cliVersion: string | null;
  readonly settingsDigest: Digest;
  readonly introductionDigest: Digest;
}
export interface ConformanceRecord {
  readonly versionId: LanguageVersionId;
  readonly fingerprint: ParticipantFingerprint;
  readonly scopeId: string;
  readonly testSetDigest: Digest;
  readonly evaluatorVersion: string;
  readonly checkIds: readonly CheckId[];
  readonly verdict: Verdict;
  readonly checkedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp | null;
}
export interface LanguageHead {
  readonly scopeId: string;
  readonly activeVersionId: LanguageVersionId;
  readonly revision: number;
}
export interface LanguageRegistry {
  register(version: LanguageVersion): Promise<Result<LanguageVersion>>;
  get(versionId: LanguageVersionId): Promise<Result<LanguageVersion | null>>;
  recordConformance(record: ConformanceRecord): Promise<Result<void>>;
  conformance(versionId: LanguageVersionId, fingerprint: ParticipantFingerprint, scopeId: string): Promise<Result<readonly ConformanceRecord[]>>;
  appendStatus(event: LanguageStatusEvent): Promise<Result<void>>;
  statusEvents(versionId: LanguageVersionId): Promise<Result<readonly LanguageStatusEvent[]>>;
  head(scopeId: string): Promise<Result<LanguageHead | null>>;
  selectHead(scopeId: string, versionId: LanguageVersionId, expectedRevision: number): Promise<Result<LanguageHead>>;
  nextEpoch(request: { readonly taskId: TaskId; readonly previousEpochId: EpochId | null; readonly epoch: Epoch; readonly expectedRevision: number }): Promise<Result<Epoch>>;
}
