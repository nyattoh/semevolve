import type { CheckExecution, CheckId, Digest, LanguageVersionId, PeerId, Result, UtcTimestamp, Verdict } from '@semevolve/core';
import type { EvaluatorRuntime } from './runtime.js';
import { invalid, ok } from './records.js';
import * as v from './validation.js';

export interface ConformanceCandidate {
  readonly versionId: LanguageVersionId;
  readonly fingerprint: { readonly peerId: PeerId };
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
      if (!v.json(record) || record.testSetDigest !== options.testSetDigest || record.checkIds.length === 0 || new Set(record.checkIds).size !== record.checkIds.length) return invalid('Conformance set mismatch');
      const fixed = structuredClone(record);
      const checks: CheckExecution[] = [];
      for (const id of fixed.checkIds) {
        const result = await options.evaluator.readCheckEligibility(id);
        if (!result.ok) return result;
        const { execution, request } = result.value;
        if (!result.value.eligible || result.value.testSetDigest !== fixed.testSetDigest || execution.result.dimension !== 'transmission' || execution.result.method !== 'deterministic_test'
          || execution.result.languageVersionId !== fixed.versionId || execution.result.scope !== fixed.scopeId || execution.result.evaluatorVersion !== fixed.evaluatorVersion
          || request.interpretation.receiverId !== fixed.fingerprint.peerId || execution.performedAt > fixed.checkedAt) return ok(null);
        checks.push(execution);
      }
      return ok({ record: fixed, independent: true, fixedBeforeRun: true, regressionVerdict: 'pass', checks });
    },
  };
}
