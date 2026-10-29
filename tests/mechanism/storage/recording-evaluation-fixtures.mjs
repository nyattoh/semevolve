import assert from 'node:assert/strict';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner, syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, mapping, original, clausePayload, rows, take, taskId, scope } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';
import { targetMapping } from './migration-fixtures.mjs';

export function comparisonProposal(id = 'baseline') {
  return { proposalId: id, change: id === 'baseline' ? 'maintain' : 'index_change', baselineProposalId: 'baseline', reason: 'Synthetic input comparison', languageVersionId: 'L1',
    originalSetDigest: digestJson([original()]), querySetDigest: digestJson([{ all: true }]), budgetRef: 'synthetic-budget', mapping: mapping(), structureSpecification: 'Synthetic', queryExamples: [{ all: true }], migrationSpecification: 'Synthetic', limitations: ['synthetic port, not real E'], unknowns: [] };
}
export async function recordingFixture({ writing = true, store, seed = true } = {}) {
  const records = new Map(); const controls = { writing, after: async () => {}, calls: 0, eligibilityReads: 0, gate: true, mismatch: false };
  const evaluator = evaluationDouble(); let f; let writeTail = Promise.resolve();
  const port = { ...evaluator, async evaluateStorage(request) {
    controls.calls++;
    const result = await evaluator.evaluateStorage(request); records.set(request.executionId, { request: structuredClone(request), result: structuredClone(result.value) });
    if (controls.writing) {
      const write = writeTail.then(() => f.append('synthetic.canonical-storage', request.executionId, { request, result: result.value }));
      writeTail = write; await write;
    }
    await controls.after(request, result.value);
    return result;
  } };
  f = await fixture({ store, seed, adapters: syntheticStorageAdapters(), evaluator: port, plan: { expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': clausePayload } } } });
  const refs = f.options.references; const gate = f.options.policy;
  const latest = (s, key) => rows(s, 'synthetic.input-updates').filter(r => r.key === key).at(-1)?.value;
  const options = { ...f.options, references: { ...refs,
    async readTask(s, id) { return latest(s, 'task') ? { ok: true, value: latest(s, 'task') } : refs.readTask(s, id); },
    async readGrant(s, id) { const grant = latest(s, 'grant'); return grant?.ref === id ? { ok: true, value: grant } : refs.readGrant(s, id); },
    async readOriginal(s, id) { const value = latest(s, 'original'); return value?.message.envelope.message_id === id ? { ok: true, value } : refs.readOriginal(s, id); },
  }, policy: { async authorise(op) { return controls.gate ? gate.authorise(op) : { allowed: false, reason: 'Current host gate refused' }; } },
    async inspectionEligibility(s, request, result) {
      controls.eligibilityReads++;
      const record = rows(s, 'synthetic.canonical-storage').find(r => r.request.executionId === request.executionId) ?? records.get(request.executionId);
      if (controls.mismatch || !record || digestJson(record.request) !== digestJson(request) || digestJson(record.result) !== digestJson(result)) return { ok: false, error: { code: 'unavailable', reason: 'Synthetic canonical request/result mismatch or unavailable' } };
      const withdrawn = rows(s, 'synthetic.withdrawals').some(r => r.executionId === request.executionId || r.executionId === '*');
      return { ok: true, value: { eligible: !withdrawn && ['literalRestoration', 'meaningPreservation', 'retrievalCorrectness'].every(k => result[k] === 'pass'), recheckRequired: withdrawn, reason: withdrawn ? 'Synthetic canonical withdrawal' : null } };
    } };
  f.options = options; f.runtime = createStoragePlanner(options);
  f.certify = async (m = mapping()) => { const checks = take(await f.runtime.inspectMapping(m)); take(await f.runtime.recordConformance(m, checks.map(c => c.checkId))); return checks; };
  f.update = async (key, value) => f.append('synthetic.input-updates', f.options.identity.newId('update'), { key, value });
  f.withdraw = async (executionId = '*') => f.append('synthetic.withdrawals', f.options.identity.newId('withdrawal'), { executionId });
  if (seed) { await f.versions(); await f.versions(targetMapping); }
  return { ...f, controls, records, taskId, scope };
}

export async function certifiedRecording(extra = {}) {
  const f = await recordingFixture({ writing: false, ...extra });
  await f.certify(); await f.certify(targetMapping); take(await f.runtime.store('message-1', mapping()));
  return f;
}
