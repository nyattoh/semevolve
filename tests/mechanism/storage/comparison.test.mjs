import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, original, mapping, clausePayload, take, reject, rows } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';

export function proposal(id = 'baseline', change = 'maintain', m = mapping()) {
  return { proposalId: id, change, baselineProposalId: 'baseline', reason: 'Public synthetic comparison', languageVersionId: m.versions.languageVersionId,
    originalSetDigest: digestJson([original()]), querySetDigest: digestJson([{ all: true }]), budgetRef: 'synthetic-budget', mapping: m,
    structureSpecification: 'DROP TABLE hypothetical; import("proposal-only"); delete /synthetic', queryExamples: [{ all: true }], migrationSpecification: 'Data only', limitations: ['public synthetic example'], unknowns: ['Production performance'] };
}
async function setup(extra = {}) {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { expectedConditions: { payloads: { 'message-1': clausePayload } } }, ...extra });
  await f.versions(); await f.certify(); take(await f.runtime.store('message-1', mapping()));
  take(await f.runtime.registerProposal(proposal()));
  return f;
}

test('L3 compares four alternatives with fixed conditions, separate measurements and unchanged head', async () => {
  const f = await setup(); const head = take(await f.runtime.head());
  for (const change of ['maintain', 'data_addition', 'index_change', 'structure_change']) {
    const candidate = proposal(`candidate-${change}`, change);
    take(await f.runtime.registerProposal(candidate));
    const comparison = take(await f.runtime.compare(proposal(), candidate));
    assert.deepEqual(Object.keys(comparison.measurements), ['baseline', candidate.proposalId], 'L3_BOTH_MEASUREMENTS');
    assert.equal(comparison.originalSetDigest, proposal().originalSetDigest);
    assert.equal(comparison.querySetDigest, proposal().querySetDigest);
    for (const m of Object.values(comparison.measurements)) {
      assert.equal(m.meaningPreservation, 'pass'); assert.equal(m.retrievalCorrectness, 'pass');
      assert.deepEqual(m.queryElapsedMs, [0]); assert.deepEqual(m.writeElapsedMs, [0]);
      assert.equal(m.falseRetrievals, null); assert.equal(m.missedRetrievals, null);
      assert.ok(m.dataBytes > 0); assert.equal(m.indexBytes, null);
      for (const column of ['introductionUsage', 'decompositionUsage', 'retrievalUsage', 'migrationUsage', 'recoveryUsage']) { assert.equal(m[column].costYen, null); assert.equal(m[column].inputTokens, null); }
      assert.match(m.environmentRef, /fixture/); assert.equal(m.cacheCondition, 'cold');
    }
    assert.deepEqual(take(await f.runtime.head()), head);
  }
  const records = rows(await f.snapshot(), 'storage.comparisons');
  assert.equal(records.length, 4); assert.ok(records.every(r => r.selectedProposalId === 'baseline'));
  assert.ok(records.every(r => r.conditionsDigest === records[0].conditionsDigest));
  await f.store.close();
});

test('L3 rejects unequal query, inputs, budget and baseline conditions', async () => {
  const f = await setup();
  for (const changes of [{ querySetDigest: digestJson('other') }, { originalSetDigest: digestJson('other') }, { budgetRef: 'other' }, { baselineProposalId: 'other' }]) {
    const candidate = { ...proposal('unequal'), ...changes };
    take(await f.runtime.registerProposal(candidate));
    reject(await f.runtime.compare(proposal(), candidate));
    const next = { ...proposal('unequal'), reason: 'Different content' };
    reject(await f.runtime.registerProposal(next), 'id_collision');
    break;
  }
  for (const [i, changes] of [{ originalSetDigest: digestJson('other') }, { budgetRef: 'other' }, { baselineProposalId: 'other' }].entries()) {
    const candidate = { ...proposal(`unequal-${i}`), ...changes }; take(await f.runtime.registerProposal(candidate)); reject(await f.runtime.compare(proposal(), candidate));
  }
  assert.deepEqual(rows(await f.snapshot(), 'storage.comparisons'), []);
  await f.store.close();
});

test('L3 refuses a fast meaning-losing candidate and keeps the accurate maintain option', async () => {
  const adapters = syntheticStorageAdapters(); const base = adapters[0];
  const fast = { ...base, id: 'fast', async decompose(...args) { const r = await base.decompose(...args); if (r.ok) delete r.value[0].representation.meaning.clauses[0].negation; return r; } };
  let tick = 0;
  const f = await setup({ adapters: [...adapters, fast], plan: { expectedConditions: { payloads: { 'message-1': clausePayload } }, measurement: { kind: 'fixture', now: () => ++tick } } });
  const bad = mapping('fast-map', 'L1', 'fast-rule', 'S2'); await f.versions(bad, 'fast');
  const candidate = proposal('fast', 'index_change', bad); take(await f.runtime.registerProposal(candidate));
  const head = take(await f.runtime.head()); const result = take(await f.runtime.compare(proposal(), candidate));
  assert.equal(result.measurements.fast.meaningPreservation, 'fail', 'L3_FAST_MEANING_REJECTED');
  assert.equal(result.measurements.baseline.meaningPreservation, 'pass');
  assert.equal(rows(await f.snapshot(), 'storage.comparisons')[0].selectedProposalId, 'baseline');
  assert.deepEqual(take(await f.runtime.head()), head);
  assert.match(result.limitation, /fixture/);
  await f.store.close();
});
