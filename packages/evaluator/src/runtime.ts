import { hostIdentity, isUtcTimestamp } from '@semevolve/core';
import type { CheckExecution, CheckId, ExecutionId, HostIdentity, Interpretation, InvocationId, JsonValue, LanguageVersionId, MessageId, PeerId, ReservationId, Result, StoreSnapshot, TaskId, TaskStore, Usage } from '@semevolve/core';
import type { EvaluationPort, EvaluationRequest, EvidenceWithdrawal, StorageCheckRequest, StorageCheckResult } from './contracts/evaluation.js';
import { collision, invalid, ok, read, records, unavailable } from './records.js';
import * as v from './validation.js';
import { compare, conditions, retrieval, storageConditions } from './conditions.js';
import { bodyDigest, checkSources } from './evidence.js';
import { executionLog, storageResult } from './executions.js';
import { judgeProjection, projectionOriginals, storageInput } from './storage-projection.js';
import type { ProjectionOriginal } from './storage-projection.js';

export interface EvaluatorRun {
  readonly runId: string;
  readonly taskId: TaskId;
  readonly languageVersionId: LanguageVersionId;
  readonly evaluatorVersion: string;
  readonly criteriaDigest: string;
  readonly testSetDigest: string;
  readonly scope: string;
  readonly checkerId: string;
  readonly expectedConditions: JsonValue;
  readonly evaluatorId: PeerId;
  readonly synthetic: true;
}
export interface CaptureInput {
  readonly messageId: MessageId;
  readonly receiverId: PeerId;
  readonly payload: JsonValue;
  readonly sharedContext: JsonValue;
}
export interface EvaluatorOptions {
  readonly store: TaskStore;
  readonly run: EvaluatorRun;
  readonly identity?: HostIdentity;
  readonly maxReadAttempts?: number;
  readonly checkerTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly observe?: {
    authorisation(taskId: TaskId, scope: string, signal: AbortSignal): Promise<JsonValue | null>;
    taskOutcome(taskId: TaskId, scope: string, signal: AbortSignal): Promise<JsonValue | null>;
  };
  readonly invalidateEvidence?: (request: EvidenceWithdrawal) => Promise<Result<void>>;
  readonly budget?: {
    start(input: { readonly taskId: TaskId; readonly executionId: ExecutionId; readonly invocationId: InvocationId; readonly reservationId: ReservationId }): Promise<Result<{ readonly started: true }>>;
    settle(input: { readonly reservationId: ReservationId; readonly outcome: { readonly kind: 'completed'; readonly usage: Usage } | { readonly kind: 'unknown_outcome'; readonly usage: Usage; readonly reason: string } }): Promise<Result<void>>;
  };
}
export interface EvaluatorRuntime extends EvaluationPort {
  captureInput(input: CaptureInput): Promise<Result<JsonValue>>;
  recordAnswer(input: { readonly messageId: MessageId; readonly receiverId: PeerId; readonly answer: JsonValue }): Promise<Result<Interpretation>>;
  recordDisclosure(input: { readonly messageId: MessageId; readonly receiverId: PeerId }): Promise<Result<Interpretation>>;
  readCheckEligibility(checkId: CheckId): Promise<Result<CheckEligibility>>;
  readStorageCheckEligibility(executionId: ExecutionId): Promise<Result<StorageCheckEligibility>>;
}
export interface StorageCheckEligibility {
  readonly eligible: boolean;
  readonly recheckRequired: boolean;
  readonly reason: string | null;
  readonly runId: string;
  readonly testSetDigest: string;
  readonly request: StorageCheckRequest;
  readonly result: StorageCheckResult;
  readonly tomboInvalidationPending: boolean;
}
export interface CheckEligibility {
  readonly eligible: boolean;
  readonly recheckRequired: boolean;
  readonly reason: string | null;
  readonly runId: string;
  readonly testSetDigest: string;
  readonly execution: CheckExecution;
  readonly request: EvaluationRequest;
  readonly tomboInvalidationPending: boolean;
}
export function createEvaluator(options: EvaluatorOptions): EvaluatorRuntime {
  const identity = options.identity ?? hostIdentity;
  const run = structuredClone(options.run);
  const attempts = options.maxReadAttempts ?? 8;
  const configuredConditions = run.expectedConditions;
  if (![run.runId, run.taskId, run.languageVersionId, run.evaluatorVersion, run.scope, run.evaluatorId].every(v.text)
    || !v.digest(run.criteriaDigest) || !v.digest(run.testSetDigest) || run.synthetic !== true || run.checkerId !== 'conditions-v1'
    || !v.record(configuredConditions) || !['transmission', 'factuality', 'authorisation', 'task_outcome'].every(d => conditions(configuredConditions[d]))
    || !storageConditions(configuredConditions.storage) || identity.digest(configuredConditions) !== run.criteriaDigest
    || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 64) throw new Error('Invalid evaluator configuration');
  const expected = configuredConditions;
  const log = records(options.store, identity, run.taskId, attempts);
  const executions = executionLog(options.store, identity, run, options.budget, attempts, options.checkerTimeoutMs ?? 30000, options.signal);
  const key = (messageId: string, receiverId: string) => identity.digest([run.runId, messageId, receiverId]);
  async function ready(): Promise<Result<void>> {
    const result = await log.insert('evaluator.runs', run.runId, { schema: 1, configuration: v.serialise(run) }, 'evaluator.run_fixed');
    return result.ok ? ok(undefined) : result;
  }
  const audit = log.audit;
  async function reject<T>(reason: string, data: JsonValue): Promise<Result<T>> {
    const recorded = await audit('evaluator.rejected', { reason, request: data });
    return recorded.ok ? invalid(reason) : recorded;
  }
  async function fixed(request: EvaluationRequest | StorageCheckRequest): Promise<Result<void>> {
    if (request.criteriaDigest !== run.criteriaDigest || request.evaluatorVersion !== run.evaluatorVersion) {
      const r = await log.insert('evaluator.run-invalidations', identity.newId('event'), { schema: 1, runId: run.runId, reason: 'Criteria or evaluator changed', request: v.serialise(request) }, 'evaluator.comparison_invalid');
      return r.ok ? invalid('Criteria or evaluator changed within a fixed run') : r;
    }
    return request.taskId === run.taskId ? ok(undefined) : invalid('Task mismatch');
  }
  const withdrawn = (s: StoreSnapshot): Set<string> => new Set(s.entries.filter(e => e.key.collection === 'evaluator.withdrawals').map(e => {
    if (!v.record(e.value) || e.value.schema !== 1 || !v.text(e.value.evidenceId)) throw new Error('Invalid withdrawal record');
    return e.value.evidenceId;
  }));
  const usage = (started: number): Usage => ({ inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: performance.now() - started, source: 'local_estimate' });
  async function evaluate(request: EvaluationRequest): Promise<Result<CheckExecution>> {
    if (!evaluationRequest(request)) return reject('Invalid evaluation request', v.serialise(request));
    const r = await ready(); if (!r.ok) return r;
    const version = await fixed(request); if (!version.ok) return version;
    const rules = expected[request.dimension];
    if (request.languageVersionId !== run.languageVersionId || request.scope !== run.scope || !conditions(rules) || !v.same(request.expectedConditions, rules)
      || identity.digest(evaluationInput(request)) !== request.inputDigest) return reject('Run, conditions or input digest mismatch', v.serialise(request));
    const s = await options.store.snapshot(); if (!s.ok) return s;
    const id = key(request.targetMessageId, request.interpretation.receiverId);
    const captured = read(s.value, 'evaluator.inputs', id);
    const answer = read(s.value, 'evaluator.answers', id);
    const disclosed = read(s.value, 'evaluator.disclosures', id);
    if (!captured || !answer || !v.interpretation(answer.interpretation) || !v.same(captured.snapshot, request.interpretation.inputSnapshot)
      || captured.digest !== request.interpretation.inputDigest || identity.digest(request.interpretation.inputSnapshot) !== request.interpretation.inputDigest
      || request.targetMessageId !== request.interpretation.messageId
      || !v.same(request.interpretation, disclosed?.projection ?? answer.interpretation)) return reject('Independent committed interpretation mismatch', v.serialise(request));
    for (const ref of request.evidence) {
      const written = await log.insert('evaluator.evidence', ref.evidenceId, { schema: 1, evidence: v.serialise(ref) }, 'evaluator.evidence_registered');
      if (!written.ok) return written.error.code === 'id_collision'
        ? log.rejected(written.error, { operation: 'evaluate', runId: run.runId, executionId: request.executionId, evidenceId: ref.evidenceId,
          requestDigest: identity.digest(v.serialise({ runId: run.runId, kind: 'evaluation', request })) }) : written;
    }
    const result = await executions.runCheck(request, 'evaluation', async (snapshot, signal) => {
      const started = performance.now();
      let judgement: { verdict: 'pass' | 'fail' | 'inconclusive'; limitation: string | null };
      let observation: JsonValue = request.interpretation.answer;
      if (request.dimension === 'transmission') {
        const verdict = compare(observation, rules.checks);
        judgement = { verdict, limitation: verdict === 'inconclusive' ? 'Answer fields unavailable' : null };
      } else if (request.dimension === 'factuality') {
        judgement = checkSources(request.evidence, rules, run.scope, run.evaluatorId, withdrawn(snapshot));
        observation = v.serialise(request.evidence);
      } else {
        const observer = request.dimension === 'authorisation' ? options.observe?.authorisation : options.observe?.taskOutcome;
        observation = observer ? await observer(request.taskId, request.scope, signal) : null;
        if (!v.json(observation)) throw new Error('Invalid host observation');
        const verdict = observation === null ? 'inconclusive' : compare(observation, rules.checks);
        judgement = { verdict, limitation: verdict === 'inconclusive' ? 'Independent host observation unavailable' : null };
      }
      const measured = usage(started);
      const execution: CheckExecution = { executionId: request.executionId, taskId: request.taskId, inputDigest: request.inputDigest, performedAt: identity.now(),
        result: { checkId: identity.newId('check'), targetMessageId: request.targetMessageId, languageVersionId: request.languageVersionId, dimension: request.dimension,
          verdict: judgement.verdict, scope: request.scope, method: request.dimension === 'factuality' ? 'source_check' : 'deterministic_test',
          evidenceIds: [...request.evidence.map(e => e.evidenceId), `observation-${request.executionId}` as import('@semevolve/core').EvidenceId], evaluatorVersion: request.evaluatorVersion, limitation: judgement.limitation }, usage: measured };
      const body = JSON.stringify({ dimension: request.dimension, observation, verdict: judgement.verdict });
      const evidence = { evidenceId: `observation-${request.executionId}`, source: 'registered-structured-synthetic-check', scope: run.scope, allowedReaders: [run.evaluatorId], content: { kind: 'retrieved', body, digest: bodyDigest(body), retrievedAt: execution.performedAt } };
      return { result: execution, evidence: v.serialise(evidence), usage: measured };
    });
    return result.ok && v.execution(result.value) ? ok(result.value) : result.ok ? unavailable('Unexpected execution product') : result;
  }
  async function evaluateStorage(request: StorageCheckRequest): Promise<Result<StorageCheckResult>> {
    if (!storageRequest(request)) return reject('Invalid storage request', v.serialise(request));
    const r = await ready(); if (!r.ok) return r;
    const version = await fixed(request); if (!version.ok) return version;
    const rules = expected.storage;
    if (!storageConditions(rules)) return invalid('Invalid storage conditions');
    if (request.scope !== run.scope || !v.same(request.expectedConditions, rules)
      || request.inputDigest !== identity.digest(storageInput(request))) return reject('Storage conditions or input digest mismatch', v.serialise(request));
    const result = await executions.runCheck(request, 'storage', async () => {
      const started = performance.now();
      const judgement = rules.kind === 'storage-projection-v1' ? judgeProjection(request, rules) : {
        literalRestoration: v.same(request.original, request.retrieved) ? 'pass' as const : 'fail' as const,
        meaningPreservation: compare(request.retrieved, rules.meaning), retrievalCorrectness: retrieval(request.retrieved, rules.retrieval),
      };
      const evidenceId = `observation-${request.executionId}` as import('@semevolve/core').EvidenceId;
      const result: StorageCheckResult = { executionId: request.executionId, inputDigest: request.inputDigest, evaluatorVersion: request.evaluatorVersion, criteriaDigest: request.criteriaDigest, scope: request.scope,
        ...judgement, evidenceIds: [evidenceId],
        limitation: 'limitation' in judgement ? judgement.limitation : [judgement.meaningPreservation, judgement.retrievalCorrectness].includes('inconclusive') ? 'Required structured field unavailable' : null };
      return { result, evidence: v.serialise({ evidenceId, kind: 'synthetic-storage-observation', original: request.original, retrieved: request.retrieved }), usage: usage(started) };
    });
    return result.ok && 'literalRestoration' in result.value ? ok(result.value) : result.ok ? unavailable('Unexpected storage product') : result;
  }
  async function withdraw(request: EvidenceWithdrawal): Promise<Result<void>> {
    if (!v.text(request.evidenceId) || !v.text(request.reason) || !isUtcTimestamp(request.withdrawnAt)) return invalid('Invalid evidence withdrawal');
    const s = await options.store.snapshot(); if (!s.ok) return s;
    if (!read(s.value, 'evaluator.evidence', request.evidenceId)) return invalid('Evidence is not registered');
    const id = identity.digest(v.serialise(request));
    const saved = await log.insert('evaluator.withdrawals', id, { schema: 1, evidenceId: request.evidenceId, reason: request.reason, withdrawnAt: request.withdrawnAt }, 'evaluator.evidence_withdrawn');
    if (!saved.ok) return saved;
    const current = await options.store.snapshot(); if (!current.ok) return current;
    if (read(current.value, 'evaluator.withdrawal-reconciliation', identity.digest([id, true]))) return ok(undefined);
    const done = options.invalidateEvidence ? await options.invalidateEvidence(request) : unavailable('TOMBO invalidation not connected');
    const observation = { schema: 1, withdrawalId: id, evidenceId: request.evidenceId, applied: done.ok, reason: done.ok ? null : v.serialise(done.error) };
    if (!done.ok) {
      const observed = await options.store.snapshot(); if (!observed.ok) return observed;
      const legacy = read(observed.value, 'evaluator.withdrawal-reconciliation', identity.digest([id, false]));
      if (legacy && v.same(legacy, observation)) return ok(undefined);
    }
    const observationId = identity.digest(done.ok ? [id, true] : [id, false, observation.reason]);
    const recorded = await log.insert('evaluator.withdrawal-reconciliation', observationId, observation, 'evaluator.withdrawal_reconciled');
    return recorded.ok ? ok(undefined) : recorded;
  }
  async function readCheckEligibility(checkId: CheckId): Promise<Result<CheckEligibility>> {
    const s = await options.store.snapshot(); if (!s.ok) return s;
    const saved = s.value.entries.find(e => e.key.collection === 'evaluator.executions' && v.record(e.value) && v.execution(e.value.result) && e.value.result.result.checkId === checkId);
    if (!saved || !v.record(saved.value) || !v.execution(saved.value.result)) return unavailable('Check not found');
    const execution: CheckExecution = saved.value.result;
    const source = read(s.value, 'evaluator.requests', execution.executionId);
    if (!source || !evaluationRequest(source.request) || source.runId !== run.runId || source.requestDigest !== saved.value.requestDigest
      || source.requestDigest !== identity.digest(v.serialise({ runId: run.runId, kind: 'evaluation', request: source.request }))
      || source.request.criteriaDigest !== run.criteriaDigest || source.request.evaluatorVersion !== run.evaluatorVersion || source.request.inputDigest !== execution.inputDigest
      || source.request.taskId !== execution.taskId || source.request.scope !== execution.result.scope || source.request.dimension !== execution.result.dimension
      || source.request.targetMessageId !== execution.result.targetMessageId || source.request.languageVersionId !== execution.result.languageVersionId
      || execution.result.evaluatorVersion !== run.evaluatorVersion || source.request.inputDigest !== identity.digest(evaluationInput(source.request))
      || !v.same(source.request.expectedConditions, expected[source.request.dimension])) return unavailable('Canonical request and result linkage is invalid');
    const refs = withdrawn(s.value);
    const affected = execution.result.evidenceIds.filter(e => refs.has(e));
    const invalidated = s.value.entries.some(e => e.key.collection === 'evaluator.run-invalidations' && v.record(e.value) && e.value.runId === run.runId);
    const pending = affected.some(evidenceId => !s.value.entries.some(e => e.key.collection === 'evaluator.withdrawal-reconciliation' && v.record(e.value) && e.value.evidenceId === evidenceId && e.value.applied === true));
    return ok({ eligible: execution.result.verdict === 'pass' && affected.length === 0 && !invalidated, recheckRequired: affected.length > 0 || invalidated,
      reason: affected.length ? 'Evidence withdrawn; a new execution ID is required' : invalidated ? 'Comparison run invalidated' : execution.result.verdict !== 'pass' ? 'Check did not pass' : null,
      runId: run.runId, testSetDigest: run.testSetDigest, execution: structuredClone(execution), request: structuredClone(source.request), tomboInvalidationPending: pending });
  }
  function referencedStorageCheck(snapshot: StoreSnapshot, checkId: string, original: ProjectionOriginal): { runId: string; evidenceIds: readonly string[] } {
    const matches = snapshot.entries.filter(e => e.key.collection === 'evaluator.executions' && v.record(e.value) && v.execution(e.value.result) && e.value.result.result.checkId === checkId);
    if (matches.length !== 1) throw new Error('Canonical referenced check is missing or ambiguous');
    const saved = read(snapshot, 'evaluator.executions', matches[0]!.key.id);
    if (!saved || !v.execution(saved.result)) throw new Error('Invalid canonical referenced check');
    const execution = saved.result;
    const source = read(snapshot, 'evaluator.requests', execution.executionId);
    if (!source || !v.text(source.runId) || !evaluationRequest(source.request)) throw new Error('Canonical referenced request is unavailable');
    const req = source.request;
    const configuration = read(snapshot, 'evaluator.runs', source.runId)?.configuration;
    if (!validRun(configuration) || configuration.runId !== source.runId || source.kind !== 'evaluation'
      || execution.executionId !== matches[0]!.key.id || req.executionId !== execution.executionId
      || source.requestDigest !== saved.requestDigest || source.requestDigest !== identity.digest(v.serialise({ runId: source.runId, kind: 'evaluation', request: req }))
      || req.taskId !== run.taskId || execution.taskId !== run.taskId || configuration.taskId !== run.taskId
      || req.scope !== run.scope || execution.result.scope !== run.scope || configuration.scope !== run.scope
      || req.targetMessageId !== original.messageId || execution.result.targetMessageId !== original.messageId
      || req.languageVersionId !== original.languageVersionId || execution.result.languageVersionId !== original.languageVersionId || configuration.languageVersionId !== original.languageVersionId
      || req.criteriaDigest !== configuration.criteriaDigest || req.evaluatorVersion !== configuration.evaluatorVersion || execution.result.evaluatorVersion !== configuration.evaluatorVersion
      || req.dimension !== execution.result.dimension || req.inputDigest !== execution.inputDigest || req.inputDigest !== identity.digest(evaluationInput(req))
      || !v.record(configuration.expectedConditions) || !v.same(req.expectedConditions, configuration.expectedConditions[req.dimension])
      || !v.same(execution.result.evidenceIds, [...req.evidence.map(e => e.evidenceId), `observation-${execution.executionId}`])) throw new Error('Canonical referenced check linkage is invalid');
    for (const evidenceId of execution.result.evidenceIds) {
      const evidence = read(snapshot, 'evaluator.evidence', evidenceId)?.evidence;
      if (!v.evidence(evidence) || evidence.evidenceId !== evidenceId) throw new Error('Canonical referenced evidence is unavailable');
      const supplied = req.evidence.find(e => e.evidenceId === evidenceId);
      if (supplied && !v.same(supplied, evidence)) throw new Error('Canonical referenced evidence differs from the request');
      if (!supplied && (evidence.scope !== run.scope || !evidence.allowedReaders.includes(configuration.evaluatorId)
        || evidence.content.kind !== 'retrieved' || evidence.content.retrievedAt !== execution.performedAt
        || bodyDigest(evidence.content.body) !== evidence.content.digest)) throw new Error('Canonical referenced observation is invalid');
    }
    return { runId: source.runId, evidenceIds: execution.result.evidenceIds };
  }
  function storageFreshness(snapshot: StoreSnapshot, evidenceIds: ReadonlySet<string>, runIds: ReadonlySet<string>): { withdrawn: boolean; invalidated: boolean; pending: boolean } {
    let withdrawn = false;
    let pending = false;
    let invalidated = false;
    for (const entry of snapshot.entries) {
      if (entry.key.collection === 'evaluator.run-invalidations') {
        const record = read(snapshot, entry.key.collection, entry.key.id);
        if (!record || !v.text(record.runId)) throw new Error('Invalid run invalidation');
        if (runIds.has(record.runId)) invalidated = true;
      }
      if (entry.key.collection !== 'evaluator.withdrawals') continue;
      const record = read(snapshot, entry.key.collection, entry.key.id);
      if (!record || !v.text(record.evidenceId) || !v.text(record.reason) || !isUtcTimestamp(record.withdrawnAt)) throw new Error('Invalid withdrawal record');
      if (!evidenceIds.has(record.evidenceId)) continue;
      if (entry.key.id !== identity.digest({ evidenceId: record.evidenceId, reason: record.reason, withdrawnAt: record.withdrawnAt })) throw new Error('Withdrawal identity mismatch');
      withdrawn = true;
      const applied = read(snapshot, 'evaluator.withdrawal-reconciliation', identity.digest([entry.key.id, true]));
      if (!applied) pending = true;
      else if (applied.withdrawalId !== entry.key.id || applied.evidenceId !== record.evidenceId || applied.applied !== true || applied.reason !== null) throw new Error('Invalid withdrawal reconciliation');
    }
    return { withdrawn, invalidated, pending };
  }
  async function readStorageCheckEligibility(executionId: ExecutionId): Promise<Result<StorageCheckEligibility>> {
    if (!v.text(executionId)) return invalid('Invalid storage execution ID');
    const snapshot = await options.store.snapshot(); if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    const source = read(s, 'evaluator.requests', executionId);
    const saved = read(s, 'evaluator.storage-results', executionId);
    const configuration = read(s, 'evaluator.runs', run.runId)?.configuration;
    if (!source || !storageRequest(source.request) || !saved || !storageResult(saved.result) || !v.usage(saved.usage)
      || !v.same(configuration, run)) return unavailable('Canonical storage records are unavailable');
    const req = source.request;
    const result = saved.result;
    const rules = req.expectedConditions;
    if (source.kind !== 'storage' || source.runId !== run.runId || req.executionId !== executionId || result.executionId !== executionId
      || req.taskId !== run.taskId || req.scope !== run.scope || result.scope !== req.scope
      || req.criteriaDigest !== run.criteriaDigest || result.criteriaDigest !== req.criteriaDigest
      || req.evaluatorVersion !== run.evaluatorVersion || result.evaluatorVersion !== req.evaluatorVersion
      || req.inputDigest !== identity.digest(storageInput(req)) || result.inputDigest !== req.inputDigest
      || source.requestDigest !== saved.requestDigest || source.requestDigest !== identity.digest(v.serialise({ runId: run.runId, kind: 'storage', request: req }))
      || !storageConditions(rules) || !v.same(rules, expected.storage)
      || !v.same(result.evidenceIds, [`observation-${executionId}`])) return unavailable('Canonical storage request and result linkage is invalid');
    const evidence = read(s, 'evaluator.evidence', `observation-${executionId}`)?.evidence;
    if (!v.same(evidence, { evidenceId: `observation-${executionId}`, kind: 'synthetic-storage-observation', original: req.original, retrieved: req.retrieved })) return unavailable('Canonical storage observation is unavailable');
    const judgement = rules.kind === 'storage-projection-v1' ? judgeProjection(req, rules) : {
      literalRestoration: v.same(req.original, req.retrieved) ? 'pass' : 'fail',
      meaningPreservation: compare(req.retrieved, rules.meaning), retrievalCorrectness: retrieval(req.retrieved, rules.retrieval),
    };
    if (result.literalRestoration !== judgement.literalRestoration || result.meaningPreservation !== judgement.meaningPreservation || result.retrievalCorrectness !== judgement.retrievalCorrectness) return unavailable('Canonical storage verdicts do not match the observation');
    const evidenceIds = new Set<string>(result.evidenceIds);
    const runIds = new Set([run.runId]);
    if (rules.kind === 'storage-projection-v1') {
      const originals = projectionOriginals(req);
      if (originals.kind === 'valid') for (const original of originals.originals) for (const checkId of original.checkRefs) {
        const referenced = referencedStorageCheck(s, checkId, original);
        runIds.add(referenced.runId);
        for (const evidenceId of referenced.evidenceIds) evidenceIds.add(evidenceId);
      }
    }
    const freshness = storageFreshness(s, evidenceIds, runIds);
    const passed = [result.literalRestoration, result.meaningPreservation, result.retrievalCorrectness].every(verdict => verdict === 'pass');
    return ok({ eligible: passed && !freshness.withdrawn && !freshness.invalidated, recheckRequired: freshness.withdrawn || freshness.invalidated,
      reason: freshness.withdrawn ? 'Evidence withdrawn; a new execution ID is required' : freshness.invalidated ? 'Comparison run invalidated' : !passed ? 'Storage checks did not all pass' : null,
      runId: run.runId, testSetDigest: run.testSetDigest, request: structuredClone(req), result: structuredClone(result), tomboInvalidationPending: freshness.pending });
  }
  async function captureInput(input: CaptureInput): Promise<Result<JsonValue>> {
    const copy = v.serialise(input);
    if (!v.record(copy) || !v.text(copy.messageId) || !v.text(copy.receiverId) || !v.json(copy.payload) || !v.json(copy.sharedContext)) return invalid('Invalid capture');
    const r = await ready(); if (!r.ok) return r;
    const snapshot = { taskId: run.taskId, languageVersionId: run.languageVersionId, messageId: copy.messageId, receiverId: copy.receiverId, payload: copy.payload, sharedContext: copy.sharedContext };
    const id = key(copy.messageId, copy.receiverId);
    const result = await log.insert('evaluator.inputs', id, { schema: 1, snapshot, digest: identity.digest(snapshot) }, 'evaluator.input_captured');
    return result.ok ? ok(structuredClone(snapshot)) : result;
  }
  async function recordAnswer(input: { readonly messageId: MessageId; readonly receiverId: PeerId; readonly answer: JsonValue }): Promise<Result<Interpretation>> {
    const fixed = structuredClone(input);
    const copy = v.serialise(fixed);
    if (!v.record(copy) || !v.text(copy.messageId) || !v.text(copy.receiverId) || !v.json(copy.answer)) return invalid('Invalid answer');
    const r = await ready(); if (!r.ok) return r;
    const id = key(fixed.messageId, fixed.receiverId);
    for (let i = 0; i < attempts; i++) {
      const s = await options.store.snapshot(); if (!s.ok) return s;
      if (read(s.value, 'evaluator.disclosures', id)) return invalid('Expected conditions already disclosed');
      const captured = read(s.value, 'evaluator.inputs', id);
      if (!captured || !v.record(captured.snapshot) || !v.digest(captured.digest) || identity.digest(captured.snapshot) !== captured.digest) return invalid('No valid committed input');
      const old = read(s.value, 'evaluator.answers', id);
      if (old) {
        if (!v.interpretation(old.interpretation)) return unavailable('Invalid persisted answer');
        return v.same(old.interpretation.answer, copy.answer) ? ok(structuredClone(old.interpretation)) : collision(id);
      }
      const interpretation: Interpretation = { messageId: fixed.messageId, receiverId: fixed.receiverId, inputSnapshot: captured.snapshot, inputDigest: identity.digest(captured.snapshot), answer: copy.answer, recordedAt: identity.now(), expectedConditionsDisclosedAt: null };
      const written = await log.append(s.value, [{ collection: 'evaluator.answers', id, value: { schema: 1, interpretation: v.serialise(interpretation), capturedRevision: s.value.revision } }], 'evaluator.answer_committed', { runId: run.runId, id });
      if (written.ok) return ok(structuredClone(interpretation));
      if (written.error.code !== 'revision_conflict') return written;
    }
    return unavailable('No progress committing independent answer');
  }
  async function recordDisclosure(input: { readonly messageId: MessageId; readonly receiverId: PeerId }): Promise<Result<Interpretation>> {
    const id = key(input.messageId, input.receiverId);
    const r = await ready(); if (!r.ok) return r;
    for (let i = 0; i < attempts; i++) {
      const s = await options.store.snapshot(); if (!s.ok) return s;
      const answer = read(s.value, 'evaluator.answers', id);
      if (!answer || !v.interpretation(answer.interpretation)) return invalid('Independent answer must be committed before disclosure');
      const committed: Interpretation = answer.interpretation;
      const prior = read(s.value, 'evaluator.disclosures', id);
      if (prior) {
        if (!v.interpretation(prior.projection)) return unavailable('Invalid disclosure record');
        return ok(structuredClone(prior.projection));
      }
      const projection = { ...committed, expectedConditionsDisclosedAt: identity.now() };
      const written = await log.append(s.value, [{ collection: 'evaluator.disclosures', id, value: { schema: 1, projection: v.serialise(projection), answerRevision: s.value.revision } }], 'evaluator.conditions_disclosed', { runId: run.runId, id });
      if (written.ok) return ok(projection);
      if (written.error.code !== 'revision_conflict') return written;
    }
    return unavailable('No progress committing disclosure');
  }
  return {
    readStorageCheckEligibility: boundary(readStorageCheckEligibility),
    captureInput: boundary(captureInput), recordAnswer: boundary(recordAnswer), recordDisclosure: boundary(recordDisclosure),
    evaluate: boundary(evaluate), evaluateStorage: boundary(evaluateStorage), withdraw: boundary(withdraw), readCheckEligibility: boundary(readCheckEligibility),
  };
}

function boundary<Input, Output>(action: (input: Input) => Promise<Result<Output>>): (input: Input) => Promise<Result<Output>> {
  return async input => {
    if (!v.json(input)) return invalid('Boundary value is not JSON');
    const copy = structuredClone(input);
    try { return await action(copy); } catch (error) { return unavailable(error instanceof Error ? error.message : 'Boundary failure'); }
  };
}
function evaluationRequest(x: unknown): x is EvaluationRequest {
  return v.object(x) && [x.taskId, x.executionId, x.targetMessageId, x.languageVersionId, x.scope, x.evaluatorVersion].every(v.text)
    && ['transmission', 'factuality', 'authorisation', 'task_outcome'].includes(String(x.dimension))
    && v.interpretation(x.interpretation) && conditions(x.expectedConditions) && Array.isArray(x.evidence) && x.evidence.every(v.evidence)
    && new Set(x.evidence.map(e => e.evidenceId)).size === x.evidence.length && v.digest(x.inputDigest) && v.digest(x.criteriaDigest);
}
function storageRequest(x: unknown): x is StorageCheckRequest {
  return v.object(x) && [x.taskId, x.executionId, x.scope, x.evaluatorVersion].every(v.text) && v.json(x.original) && v.json(x.retrieved)
    && storageConditions(x.expectedConditions) && v.digest(x.inputDigest) && v.digest(x.criteriaDigest);
}
function evaluationInput(request: EvaluationRequest): JsonValue {
  return v.serialise({ taskId: request.taskId, targetMessageId: request.targetMessageId, languageVersionId: request.languageVersionId, dimension: request.dimension, interpretation: request.interpretation, evidence: request.evidence, scope: request.scope });
}
function validRun(value: unknown): value is EvaluatorRun {
  if (!v.object(value) || ![value.runId, value.taskId, value.languageVersionId, value.evaluatorVersion, value.scope, value.evaluatorId].every(v.text)
    || !v.digest(value.criteriaDigest) || !v.digest(value.testSetDigest) || value.synthetic !== true || value.checkerId !== 'conditions-v1'
    || !v.record(value.expectedConditions)) return false;
  const expected = value.expectedConditions;
  return ['transmission', 'factuality', 'authorisation', 'task_outcome'].every(d => conditions(expected[d]))
    && storageConditions(expected.storage) && hostIdentity.digest(expected) === value.criteriaDigest;
}
