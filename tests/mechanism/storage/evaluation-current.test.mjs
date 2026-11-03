import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { take, reject, rows, mapping } from './fixtures.mjs';
import { recordingFixture, certifiedRecording } from './recording-evaluation-fixtures.mjs';
import { deferred, captureStore } from './supersession-fixtures.mjs';

for (const response of ['unavailable', 'missing', 'malformed', 'ineligible', 'recheck', 'mismatch']) test(`L-rem canonical ${response} refuses adoption without discarding evaluator history`, async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  const runtime = createStoragePlanner({ ...f.options, async inspectionEligibility(s, request, result) {
    const valid = await f.options.inspectionEligibility(s, request, result); assert.equal(valid.ok, true);
    if (response === 'unavailable') return { ok: false, error: { code: 'unavailable', reason: 'Current canonical read failed' } };
    if (response === 'missing') return { ok: true, value: null };
    if (response === 'malformed') return { ok: true, value: { eligible: true, recheckRequired: 'unknown', reason: null } };
    if (response === 'mismatch') return f.options.inspectionEligibility(s, { ...request, taskId: 'other-task' }, result);
    return { ok: true, value: { eligible: response !== 'ineligible', recheckRequired: response === 'recheck', reason: 'Current canonical proof refused' } };
  } });
  reject(await runtime.inspectMapping(mapping()), 'unavailable'); const s = await f.snapshot();
  assert.equal(rows(s, 'synthetic.canonical-storage').length, 1); assert.equal(rows(s, 'storage.inspections').length, 0);
});

test('L-rem current failed evaluation is recorded but cannot become conformance', async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  const options = { ...f.options, comparison: { ...f.options.comparison, expectedConditions: { payloads: {} } } };
  const runtime = createStoragePlanner(options); const checks = take(await runtime.inspectMapping(mapping()));
  assert.equal(checks[0].result.meaningPreservation, 'inconclusive');
  reject(await runtime.recordConformance(mapping(), checks.map(c => c.checkId)), 'unavailable');
  assert.equal(rows(await f.snapshot(), 'storage.inspections').length, 1);
});

test('L-rem A0 profile preserves the same request identity and externally fixed criteria digest', async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  const storage = { kind: 'storage-projection-v1', payloads: f.options.comparison.expectedConditions.payloads, queries: [{ query: { all: true }, messageIds: ['message-1'] }] };
  const runConditions = { transmission: [], factuality: [], authorisation: [], task_outcome: [], storage };
  const runtime = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, expectedConditions: storage, criteriaDigest: digestJson(runConditions) } });
  const checks = take(await runtime.inspectMapping(mapping())); const record = rows(await f.snapshot(), 'synthetic.canonical-storage')[0];
  assert.deepEqual(checks[0].request, record.request); assert.deepEqual(checks[0].result, record.result);
  assert.equal(checks[0].request.criteriaDigest, digestJson(runConditions));
  const r = checks[0].request;
  assert.equal(r.inputDigest, digestJson({ original: r.original, retrieved: r.retrieved, expectedConditions: r.expectedConditions, criteriaDigest: r.criteriaDigest, evaluatorVersion: r.evaluatorVersion, scope: r.scope }));
});

test('L-rem simultaneous recorded inspections preserve a real final CAS loser and do not evaluate again', { timeout: 30000 }, async t => {
  const f = await recordingFixture(); t.after(() => f.store.close());
  const evaluations = deferred(), releaseEvaluations = deferred(), commits = deferred(), releaseCommits = deferred(); let evaluated = 0, admitted = 0, settled = 0;
  f.controls.after = async () => { if (++evaluated === 2) evaluations.resolve(); await releaseEvaluations.promise; };
  const captured = captureStore(f, async batch => { if (batch.events.some(e => e.kind === 'storage.inspected')) { if (++admitted === 2) commits.resolve(); await releaseCommits.promise; } });
  const runtime = createStoragePlanner({ ...f.options, store: captured.store });
  const calls = [0, 1].map(() => runtime.inspectMapping(mapping()).then(r => { settled++; return r; }));
  await evaluations.promise; assert.equal(settled, 0); releaseEvaluations.resolve();
  await commits.promise; assert.equal(settled, 0); releaseCommits.resolve(); const results = await Promise.all(calls);
  assert.equal(results.filter(r => r.ok).length, 1); reject(results.find(r => !r.ok), 'revision_conflict');
  assert.equal(f.controls.calls, 2); const s = await f.snapshot();
  assert.equal(rows(s, 'synthetic.canonical-storage').length, 2); assert.equal(rows(s, 'storage.inspections').length, 1);
});

test('L-rem withdrawal during canonical validation cannot commit the inspected result', async t => {
  const f = await recordingFixture(); t.after(() => f.store.close()); let armed = true;
  const runtime = createStoragePlanner({ ...f.options, async inspectionEligibility(...args) {
    const result = await f.options.inspectionEligibility(...args);
    if (armed) { armed = false; await f.withdraw(); }
    return result;
  } });
  reject(await runtime.inspectMapping(mapping()), 'revision_conflict');
  assert.equal(rows(await f.snapshot(), 'storage.inspections').length, 0); assert.equal(f.controls.calls, 1);
});
