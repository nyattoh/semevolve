import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { take, rows, mapping, original, clausePayload } from './fixtures.mjs';
import { checkedMigration, migrationRequest, targetMapping } from './migration-fixtures.mjs';
import { recordingFixture, certifiedRecording, comparisonProposal } from './recording-evaluation-fixtures.mjs';

for (const action of ['inspect', 'compare']) test(`L-rem ${action} commits after evaluator records without repeating evaluation`, async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  take(await f.runtime.registerProposal(comparisonProposal())); take(await f.runtime.registerProposal(comparisonProposal('candidate')));
  const before = await f.snapshot();
  const result = action === 'inspect' ? await f.runtime.inspectMapping(mapping()) : await f.runtime.compare(comparisonProposal(), comparisonProposal('candidate'));
  assert.equal(result.ok, true, `L_REM_RECORDING_${action.toUpperCase()}`);
  const after = await f.snapshot(); assert.ok(after.revision > before.revision + 1);
  assert.equal(rows(after, 'storage.inspections').length, action === 'inspect' ? 1 : 2);
  assert.equal(f.controls.calls, action === 'inspect' ? 1 : 2);
  assert.ok(f.controls.eligibilityReads > 0);
  if (action === 'compare') assert.equal(rows(after, 'storage.comparisons')[0].selectedProposalId, 'baseline');
  else { take(await f.runtime.recordConformance(mapping(), result.value.map(c => c.checkId))); take(await f.runtime.store('message-1', mapping())); }
});

for (const action of ['inspect', 'compare']) for (const change of ['original', 'head', 'grant', 'cancel', 'deadline', 'started', 'budget', 'gate', 'clock', 'withdrawal', 'canonical']) test(`L-rem ${action} refuses concurrent ${change} without adopting checks`, async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  take(await f.runtime.registerProposal(comparisonProposal())); take(await f.runtime.registerProposal(comparisonProposal('candidate')));
  let armed = true;
  f.controls.after = async () => {
    if (!armed) return; armed = false; const s = await f.snapshot();
    if (change === 'original') await f.update('original', original('message-1', { ...clausePayload, literal: 'changed' }));
    if (change === 'head') await f.append('storage.heads', f.scope, { generation: 'changed-head', mappingId: 'M1', mappingDigest: digestJson(mapping()), revision: s.revision + 1 });
    if (change === 'grant') await f.update('grant', { ...rows(s, 'host.grants').find(g => g.ref === 'grant-copy'), revokedAt: f.clock.value });
    if (['cancel', 'deadline', 'started', 'budget'].includes(change)) {
      const task = structuredClone(rows(s, 'host.tasks')[0]);
      if (change === 'cancel') task.cancellationRequestedAt = f.clock.value;
      if (change === 'deadline') task.deadline = '2026-10-30T00:00:00.000Z';
      if (change === 'started') task.startedAt = '2026-10-27T00:00:00.000Z';
      if (change === 'budget') task.budget.maxInvocations++;
      await f.update('task', task);
    }
    if (change === 'gate') f.controls.gate = false;
    if (change === 'clock') f.clock.value = '2026-10-30T00:00:00.000Z';
    if (change === 'withdrawal') await f.withdraw();
    if (change === 'canonical') f.controls.mismatch = true;
  };
  const result = action === 'inspect' ? await f.runtime.inspectMapping(mapping()) : await f.runtime.compare(comparisonProposal(), comparisonProposal('candidate'));
  assert.equal(result.ok, false); const s = await f.snapshot();
  assert.equal(rows(s, 'storage.inspections').length, 0); assert.equal(rows(s, 'storage.comparisons').length, 0);
  assert.equal(rows(s, 'storage.conformance').length, 0); assert.ok(rows(s, 'synthetic.canonical-storage').length > 0);
});

test('L-rem policy task revision can advance while task limits and identity remain fixed', async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  f.controls.after = async () => { const s = await f.snapshot(); await f.update('task', { ...rows(s, 'host.tasks')[0], revision: s.revision }); };
  const result = await f.runtime.inspectMapping(mapping()); assert.equal(result.ok, true, 'L_REM_POLICY_ACCOUNTING_REVISION');
});

for (const action of ['conformance', 'store', 'retrieve', 'copy', 'catchUp', 'switch', 'restore']) test(`L-rem withdrawal stops existing ${action} adoption while original pass remains`, async t => {
  const f = await certifiedRecording(); t.after(() => f.store.close());
  if (['catchUp', 'switch', 'restore'].includes(action)) await checkedMigration(f);
  if (action === 'restore') take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  const before = await f.snapshot(); await f.withdraw();
  let result;
  if (action === 'conformance') result = await f.runtime.recordConformance(mapping(), rows(before, 'storage.inspections').filter(c => c.mappingDigest === digestJson(mapping())).slice(0, 1).map(c => c.checkId));
  if (action === 'store') result = await f.runtime.store('message-1', mapping());
  if (action === 'retrieve') result = await f.runtime.retrieve({ all: true }, mapping());
  if (action === 'copy') result = await f.runtime.migration.prepare(await migrationRequest(f));
  if (action === 'catchUp') result = await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision);
  if (action === 'switch' || action === 'restore') result = await f.runtime.migration[action]({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: `grant-${action}` });
  assert.equal(result.ok, false, `L_REM_WITHDRAWAL_${action}`);
  const after = await f.snapshot(); assert.deepEqual(rows(after, 'storage.heads'), rows(before, 'storage.heads'));
  for (const c of rows(before, 'storage.inspections')) assert.deepEqual(rows(after, 'storage.inspections').find(a => a.checkId === c.checkId), c);
});

test('L-rem referenced factuality failure stays traceable with current recheck limitation', async t => {
  const f = await recordingFixture({ writing: false }); t.after(() => f.store.close());
  const o = original('message-2'); o.checkRefs = ['fact']; await f.append('host.originals', 'message-2', o);
  const proof = { context: { taskId: f.taskId, messageId: 'message-2', languageVersionId: 'L1', scope: f.scope }, execution: { taskId: f.taskId, executionId: 'fact-execution', inputDigest: digestJson('fact-input'), performedAt: f.clock.value, result: { checkId: 'fact', targetMessageId: 'message-2', languageVersionId: 'L1', scope: f.scope, dimension: 'factuality', verdict: 'fail' } } };
  let current = false;
  const runtime = createStoragePlanner({ ...f.options, references: { ...f.options.references, async readCheck() { return { ok: true, value: { ...proof, context: current ? { ...proof.context, recheckRequired: true, reason: 'Referenced evidence withdrawn' } : proof.context } }; } } });
  take(await runtime.recordOriginal('message-2')); current = true;
  const trace = take(await runtime.trace('fact')); assert.equal(trace.checks.length, 1, 'L_REM_HISTORICAL_FACTUALITY');
  assert.equal(trace.checks[0].result.verdict, 'fail'); assert.ok(trace.unknowns.includes('Referenced evidence withdrawn'));
  assert.equal((await runtime.recordOriginal('message-2')).ok, false);
});
