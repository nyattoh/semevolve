import type { EvaluationPort, EvaluatorRuntime, ConformanceCandidate, StorageCheckRequest, StorageCheckResult } from '@semevolve/evaluator';
import type { ExecutionId, Result } from '@semevolve/core';
import { createRegistryInspectionAdapter } from '@semevolve/evaluator';
import type { RegistryInspectionPort } from '@semevolve/language-registry';
import type { TomboPort } from '@semevolve/tombo-bridge';
declare const evaluator: EvaluatorRuntime;
const port: EvaluationPort = evaluator;
declare const executionId: ExecutionId;
const storageEligibility: Promise<Result<{ readonly eligible: boolean; readonly recheckRequired: boolean; readonly reason: string | null;
  readonly runId: string; readonly testSetDigest: string; readonly request: StorageCheckRequest; readonly result: StorageCheckResult;
  readonly tomboInvalidationPending: boolean }>> = evaluator.readStorageCheckEligibility(executionId);
const adapter: RegistryInspectionPort = createRegistryInspectionAdapter({ evaluator, testSetDigest: '' as ConformanceCandidate['testSetDigest'] });
declare const tombo: TomboPort;
// @ts-expect-error TOMBO completion does not issue operation permissions.
tombo.authorise({});
// @ts-expect-error A storage result has three separate verdicts.
const aggregate: Awaited<ReturnType<EvaluationPort['evaluateStorage']>> = { ok: true, value: { verdict: 'pass' } };
void [port, adapter, aggregate, storageEligibility];
