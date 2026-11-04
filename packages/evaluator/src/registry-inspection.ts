import { sameFields, uniqueManifest } from '@semevolve/core';
import type { CheckExecution, CheckId, Digest, LanguageVersionId, PeerId, Result, UtcTimestamp, Verdict } from '@semevolve/core';
import { aggregateVerdict, classifyObservation } from './observation.js';
import type { EvaluatorRuntime } from './runtime.js';
import { invalid, ok } from './records.js';
import * as v from './validation.js';

export interface ConformanceCandidate {
  readonly versionId: LanguageVersionId;
  readonly fingerprint: { readonly peerId: PeerId; readonly provider: string; readonly modelId: string | null; readonly cliVersion: string | null; readonly settingsDigest: Digest; readonly introductionDigest: Digest };
  readonly scopeId: string;
  readonly testSetDigest: Digest;
  readonly evaluatorVersion: string;
  readonly checkIds: readonly CheckId[];
  readonly checkedAt: UtcTimestamp;
  readonly verdict: Verdict;
}
export function createRegistryInspectionAdapter(options: { readonly evaluator: EvaluatorRuntime; readonly testSetDigest: Digest }) {
  return {
    async readConformance<Record extends ConformanceCandidate>(record: Record): Promise<Result<{ readonly record: Record; readonly independent: true; readonly fixedBeforeRun: true; readonly regressionVerdict: Verdict; readonly checks: readonly CheckExecution[] } | null>> {
      if (!v.json(record) || !v.implementationFingerprint(record.fingerprint) || !sameFields(['testSetDigest'] as const, { testSetDigest: record.testSetDigest }, { testSetDigest: options.testSetDigest }) || record.checkIds.length === 0 || !uniqueManifest([...record.checkIds])) return invalid('Conformance set mismatch');
      const fixed = structuredClone(record);
      const checks: CheckExecution[] = [];
      for (const id of fixed.checkIds) {
        const result = await options.evaluator.readCheckEligibility(id);
        if (!result.ok) return result;
        const { execution, request } = result.value;
        const snapshot = request.interpretation.inputSnapshot;
        if (!sameFields(['testSetDigest', 'evaluatorVersion'] as const, { testSetDigest: result.value.testSetDigest, evaluatorVersion: execution.result.evaluatorVersion }, { testSetDigest: fixed.testSetDigest, evaluatorVersion: fixed.evaluatorVersion })
          || execution.result.dimension !== 'transmission' || execution.result.method !== 'deterministic_test'
          || execution.result.languageVersionId !== fixed.versionId || execution.result.scope !== fixed.scopeId
          || !v.record(snapshot) || !v.same(snapshot.fingerprint, fixed.fingerprint) || request.interpretation.receiverId !== fixed.fingerprint.peerId
          || execution.performedAt > fixed.checkedAt) return ok(null);
        const observation = classifyObservation({ recheckRequired: result.value.recheckRequired, reason: result.value.reason, verdict: execution.result.verdict });
        if (observation.kind === 'recheck') return invalid(`needs re-check: ${observation.reason}`);
        checks.push(execution);
      }
      return ok({ record: fixed, independent: true, fixedBeforeRun: true, regressionVerdict: aggregateVerdict(checks.map(check => check.result.verdict)), checks });
    },
  };
}
