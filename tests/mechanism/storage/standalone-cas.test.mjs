import assert from 'node:assert/strict';
import test from 'node:test';
import { rows, take } from './fixtures.mjs';
import { comparisonProposal, recordingFixture } from './recording-evaluation-fixtures.mjs';
import { standaloneCase } from './standalone-cas-fixtures.mjs';

for (const operation of ['inspect', 'compare', 'conformance']) for (const change of ['cancel', 'revoke', 'none']) {
  test(`D27 standalone memory ${operation} ${change}`, { timeout: 30000 }, t => standaloneCase(t, 'memory', operation, change));
}

test('D27 callback compare accepts evaluator records and task accounting revision', { timeout: 30000 }, async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  take(await f.runtime.registerProposal(comparisonProposal())); take(await f.runtime.registerProposal(comparisonProposal('candidate')));
  const before = await f.snapshot();
  f.controls.after = async () => { const s = await f.snapshot(); await f.update('task', { ...rows(s, 'host.tasks')[0], revision: s.revision }); };
  const result = await f.runtime.compare(comparisonProposal(), comparisonProposal('candidate'));
  take(result); const after = await f.snapshot();
  assert.equal(after.revision, before.revision + 5);
  assert.equal(rows(after, 'synthetic.canonical-storage').length, 2);
  assert.equal(rows(after, 'synthetic.input-updates').length, 2);
  assert.equal(rows(after, 'storage.inspections').length, 2);
  assert.equal(rows(after, 'storage.comparisons').length, 1);
  assert.equal(rows(after, 'storage.comparisons')[0].selectedProposalId, 'baseline');
  assert.equal(rows(after, 'storage.conformance').length, 0);
  assert.equal(f.controls.calls, 2);
  assert.ok(f.controls.eligibilityReads > 0);
  for (const c of rows(after, 'storage.inspections')) assert.deepEqual([c.result.literalRestoration, c.result.meaningPreservation, c.result.retrievalCorrectness], ['pass', 'pass', 'pass']);
  t.diagnostic(JSON.stringify({ before, after, result, calls: f.controls.calls, eligibilityReads: f.controls.eligibilityReads }));
});
