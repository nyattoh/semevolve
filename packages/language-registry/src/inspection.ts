import { isUtcTimestamp } from '@semevolve/core';
import type { CheckExecution, EpochId, LanguageVersionId, PeerId, Result, TaskId, Verdict } from '@semevolve/core';
import type { ConformanceRecord, LanguageRegistry, ParticipantFingerprint } from './contracts/registry.js';
import * as v from './validation.js';

export interface RegistryInspection {
  readonly record: ConformanceRecord;
  readonly independent: boolean;
  readonly fixedBeforeRun: boolean;
  readonly regressionVerdict: Verdict;
  readonly checks: readonly CheckExecution[];
}

export interface RegistryInspectionPort {
  readConformance(record: ConformanceRecord): Promise<Result<RegistryInspection | null>>;
}

export interface EpochReadiness {
  readonly storeRevision: number;
  readonly taskId: TaskId;
  readonly previousEpochId: EpochId | null;
  readonly epochId: EpochId;
  readonly scopeId: string;
  readonly previousSendsClosed: boolean;
  readonly pendingMessageIds: readonly string[];
  readonly heldMessageIds: readonly string[];
  readonly acquired: readonly {
    readonly fingerprint: ParticipantFingerprint;
    readonly versionId: LanguageVersionId | null;
    readonly digest: string | null;
  }[];
}

export interface EpochReadinessPort {
  inspect(request: Parameters<LanguageRegistry['nextEpoch']>[0], storeRevision: number): Promise<Result<EpochReadiness>>;
}

function check(value: unknown): value is CheckExecution {
  if (!v.object(value) || !v.exact(value, ['executionId', 'taskId', 'inputDigest', 'performedAt', 'result', 'usage'])
    || !v.text(value.executionId) || !v.text(value.taskId) || !v.digest(value.inputDigest) || !isUtcTimestamp(value.performedAt)
    || !v.object(value.result) || !v.object(value.usage)) return false;
  const r = value.result;
  const u = value.usage;
  return v.exact(r, ['checkId', 'targetMessageId', 'languageVersionId', 'dimension', 'verdict', 'scope', 'method', 'evidenceIds', 'evaluatorVersion', 'limitation'])
    && [r.checkId, r.targetMessageId, r.languageVersionId, r.scope, r.evaluatorVersion].every(v.text)
    && r.dimension === 'transmission' && r.method === 'deterministic_test'
    && ['pass', 'fail', 'inconclusive'].includes(String(r.verdict)) && v.unique(r.evidenceIds) && r.evidenceIds.length > 0
    && (r.limitation === null || typeof r.limitation === 'string')
    && v.exact(u, ['inputTokens', 'outputTokens', 'reasoningTokens', 'costYen', 'elapsedMs', 'source'])
    && [u.inputTokens, u.outputTokens, u.reasoningTokens].every(n => n === null || v.integer(n))
    && (u.costYen === null || (typeof u.costYen === 'number' && Number.isFinite(u.costYen) && u.costYen >= 0))
    && typeof u.elapsedMs === 'number' && Number.isFinite(u.elapsedMs) && u.elapsedMs >= 0
    && ['provider', 'local_estimate', 'unavailable'].includes(String(u.source));
}

export function inspection(value: unknown, record: ConformanceRecord): value is RegistryInspection {
  if (!v.object(value) || !v.exact(value, ['record', 'independent', 'fixedBeforeRun', 'regressionVerdict', 'checks'])
    || !v.conformance(value.record) || !v.same(value.record, record) || value.independent !== true || value.fixedBeforeRun !== true
    || !['pass', 'fail', 'inconclusive'].includes(String(value.regressionVerdict))
    || !Array.isArray(value.checks) || !value.checks.every(check) || value.checks.length !== record.checkIds.length) return false;
  const checks = value.checks;
  if (new Set(checks.map(c => c.executionId)).size !== checks.length
    || !v.same(checks.map(c => c.result.checkId).sort(), [...record.checkIds].sort())
    || checks.some(c => c.performedAt > record.checkedAt || c.result.languageVersionId !== record.versionId
      || c.result.scope !== record.scopeId || c.result.evaluatorVersion !== record.evaluatorVersion)) return false;
  const verdicts = [...checks.map(c => c.result.verdict), value.regressionVerdict];
  const verdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
  return record.verdict === verdict;
}

export function readiness(value: unknown): value is EpochReadiness {
  if (!v.object(value) || !v.exact(value, ['storeRevision', 'taskId', 'previousEpochId', 'epochId', 'scopeId', 'previousSendsClosed', 'pendingMessageIds', 'heldMessageIds', 'acquired'])
    || !v.integer(value.storeRevision) || !v.text(value.taskId) || !(value.previousEpochId === null || v.text(value.previousEpochId))
    || !v.text(value.epochId) || !v.text(value.scopeId) || typeof value.previousSendsClosed !== 'boolean'
    || !v.unique(value.pendingMessageIds) || !v.unique(value.heldMessageIds) || !Array.isArray(value.acquired)) return false;
  const peers = new Set<PeerId>();
  return value.acquired.every(a => {
    if (!v.object(a) || !v.exact(a, ['fingerprint', 'versionId', 'digest']) || !v.fingerprint(a.fingerprint)
      || !(a.versionId === null || v.text(a.versionId)) || !(a.digest === null || v.digest(a.digest)) || peers.has(a.fingerprint.peerId)) return false;
    peers.add(a.fingerprint.peerId);
    return true;
  });
}
