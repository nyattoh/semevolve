import { canonicalJson, digestJson } from '@semevolve/core';
import type { Usage, Verdict } from '@semevolve/core';
import type { StorageComparison, StorageMeasurements, StorageProposal } from './contracts/storage.js';
import type { Planner } from './planner.js';
import * as v from './validation.js';

function proposalValid(proposal: unknown): proposal is StorageProposal {
  return v.object(proposal) && Object.keys(proposal).length === 14 && v.text(proposal.proposalId) && v.text(proposal.baselineProposalId)
    && ['maintain', 'data_addition', 'index_change', 'structure_change'].includes(String(proposal.change)) && v.text(proposal.reason)
    && v.text(proposal.languageVersionId) && v.digest(proposal.originalSetDigest) && v.digest(proposal.querySetDigest) && v.text(proposal.budgetRef)
    && v.mappingValid(proposal.mapping) && typeof proposal.structureSpecification === 'string' && Array.isArray(proposal.queryExamples)
    && typeof proposal.migrationSpecification === 'string' && Array.isArray(proposal.limitations) && proposal.limitations.every(v.text)
    && Array.isArray(proposal.unknowns) && proposal.unknowns.every(v.text);
}
export async function registerProposal(p: Planner, input: StorageProposal): Promise<void> {
  const proposal = structuredClone(input);
  if (!proposalValid(proposal) || proposal.languageVersionId !== proposal.mapping.versions.languageVersionId) v.invalid('Invalid storage proposal');
  const s = await p.snapshot();
  await p.registered(s, proposal.mapping);
  await p.immutable(s, 'storage.proposals', proposal.proposalId, proposal);
}
const verdict = (values: readonly Verdict[]): Verdict => values.includes('fail') ? 'fail' : values.length === 0 || values.includes('inconclusive') ? 'inconclusive' : 'pass';
const usage = (elapsedMs = 0): Usage => ({ inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs, source: 'unavailable' });

export async function compare(p: Planner, left: StorageProposal, right: StorageProposal): Promise<StorageComparison> {
  const baseline = structuredClone(left), candidate = structuredClone(right);
  if (!proposalValid(baseline) || !proposalValid(candidate) || baseline.change !== 'maintain' || baseline.baselineProposalId !== baseline.proposalId) v.invalid('Comparison requires an explicit maintain baseline');
  const s = await p.snapshot();
  const plan = p.options.comparison;
  const originals = await Promise.all(plan.originalIds.map(id => p.original(s, id)));
  for (const proposal of [baseline, candidate]) {
    if (!v.same(v.find(s, 'storage.proposals', proposal.proposalId), proposal) || proposal.baselineProposalId !== baseline.proposalId
      || proposal.languageVersionId !== baseline.languageVersionId || proposal.originalSetDigest !== digestJson(originals)
      || proposal.querySetDigest !== digestJson(plan.queries) || proposal.budgetRef !== plan.budgetRef || !v.same(proposal.queryExamples, plan.queries)) v.invalid('Unequal or unregistered comparison conditions');
    await p.registered(s, proposal.mapping);
  }
  const input = await p.inspectionInput(s, [baseline.mapping, candidate.mapping], originals);
  const conditions = { languageVersionId: baseline.languageVersionId, originalSetDigest: digestJson(originals), querySetDigest: digestJson(plan.queries),
    budgetRef: plan.budgetRef, budget: plan.budget, criteriaDigest: plan.criteriaDigest, evaluatorVersion: plan.evaluatorVersion,
    environmentRef: plan.environmentRef, cacheCondition: plan.cacheCondition, order: ['baseline', 'candidate'], scope: p.options.scope };
  const measurements: Record<string, StorageMeasurements> = {};
  const checkRefs = [];
  const inspections = [];
  for (const proposal of [baseline, candidate]) {
    const begin = plan.measurement.now();
    const units = await p.project(s, proposal.mapping, originals);
    const writeElapsedMs = plan.measurement.now() - begin;
    const queryElapsedMs = [];
    for (const query of plan.queries) {
      const start = plan.measurement.now();
      v.value(await p.adapter(s, proposal.mapping).retrieve(structuredClone(query), structuredClone(units), structuredClone(proposal.mapping)));
      queryElapsedMs.push(plan.measurement.now() - start);
    }
    if (![writeElapsedMs, ...queryElapsedMs].every(n => Number.isFinite(n) && n >= 0)) v.invalid('Invalid measurement clock');
    const checks = await p.inspect(s, proposal.mapping, originals, units);
    inspections.push(...checks); checkRefs.push(...checks.map(c => c.checkId));
    measurements[proposal.proposalId] = { meaningPreservation: verdict(checks.map(c => c.result.meaningPreservation)), retrievalCorrectness: verdict(checks.map(c => c.result.retrievalCorrectness)),
      falseRetrievals: null, missedRetrievals: null, queryElapsedMs, writeElapsedMs: [writeElapsedMs], dataBytes: Buffer.byteLength(canonicalJson(units), 'utf8'), indexBytes: null,
      introductionUsage: usage(), decompositionUsage: usage(writeElapsedMs), retrievalUsage: usage(queryElapsedMs.reduce((a, b) => a + b, 0)), migrationUsage: usage(), recoveryUsage: usage(),
      environmentRef: `${plan.environmentRef}; measurement=${plan.measurement.kind}`, cacheCondition: plan.cacheCondition };
  }
  const baselinePass = inspections.slice(0, plan.queries.length).every(c => p.passing(c.result));
  const candidatePass = inspections.slice(plan.queries.length).every(c => p.passing(c.result));
  const result: StorageComparison = { executionId: p.identity.newId('execution'), baselineProposalId: baseline.proposalId, candidateProposalId: candidate.proposalId,
    languageVersionId: baseline.languageVersionId, originalSetDigest: digestJson(originals), querySetDigest: digestJson(plan.queries), budgetRef: plan.budgetRef,
    criteriaDigest: plan.criteriaDigest, measurements, checkRefs, limitation: `${plan.measurement.kind} timings; public synthetic checks; null counts, index bytes, token and cost values are unmeasured; no production performance or adoption authority` };
  const final = await p.revalidateInspection(input, inspections);
  await p.commit(final, [...inspections.map(c => p.insert('storage.inspections', c.checkId, c)), p.insert('storage.comparisons', result.executionId,
    { result, conditions, conditionsDigest: digestJson(conditions), selectedProposalId: baselinePass ? baseline.proposalId : null,
      candidateEligible: candidatePass, reason: baselinePass ? 'Maintain meets fixed semantic criteria; structural change is not required' : 'No verified maintain result; current head remains unchanged' })], 'compared', { executionId: result.executionId, checkRefs });
  return result;
}
