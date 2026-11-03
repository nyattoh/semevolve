import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner, syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, mapping, original, clausePayload, take, reject, rows } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';
import { migrationFixture, migrationRequest, targetMapping } from './migration-fixtures.mjs';
import { recordingFixture } from './recording-evaluation-fixtures.mjs';

const plan = { expectedConditions: { payloads: { 'message-1': clausePayload } } };

// Regression test for Finding 1: Verify coverage of every query before certifying
test('L1 recordConformance rejects mismatched queries even with valid digest', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { ...plan, queries: [{ all: true }, { messageId: 'message-1' }] } });
  await f.versions();
  
  // Create checks for the original queries
  const checks = take(await f.runtime.inspectMapping(mapping()));
  assert.equal(checks.length, 2);
  
  // Now change the comparison plan to different queries (same number, same digest structure)
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ all: true }, { messageId: 'message-2' }] } });
  
  // Attempt to reuse checks from the original queries
  // This should fail because the queries don't match
  reject(await runtime2.recordConformance(mapping(), checks.map(c => c.checkId)), 'invalid_input');
  
  await f.store.close();
});

// Regression test for Finding 2: Bind standalone conformance to the full inspection plan
test('L2 standalone mode rejects conformance when queries or conditions change', async () => {
  // Create a fixture WITHOUT inspectionEligibility (standalone mode)
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan, seed: true });
  f.options.inspectionEligibility = undefined;
  const runtime1 = createStoragePlanner(f.options);
  
  await f.versions();
  
  // Certify with the original plan
  const checks1 = take(await runtime1.inspectMapping(mapping()));
  take(await runtime1.recordConformance(mapping(), checks1.map(c => c.checkId)));
  
  // Store should work initially
  take(await runtime1.store('message-1', mapping()));
  
  // Now create a runtime with different queries but same criteria/evaluator
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ messageId: 'message-1' }] } });
  
  // Store should fail because conformance was for different queries
  reject(await runtime2.store('message-1', mapping()), 'unavailable');
  
  // Also test with different expectedConditions
  const runtime3 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, expectedConditions: { payloads: { 'message-1': { ...clausePayload, clauses: [] } } } } });
  reject(await runtime3.store('message-1', mapping()), 'unavailable');
  
  await f.store.close();
});

// Regression test for Finding 3: Reject empty query plans before selecting a baseline
test('L2 compare rejects empty query plans', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { ...plan, queries: [] } });
  await f.versions();
  
  const originals = [original()];
  const baseline = { proposalId: 'P1', baselineProposalId: 'P1', change: 'maintain', reason: 'baseline', budgetRef: 'synthetic-budget', languageVersionId: 'L1', originalSetDigest: digestJson(originals), querySetDigest: digestJson([]), queryExamples: [], structureSpecification: 'test', migrationSpecification: 'test', limitations: [], unknowns: [], mapping: mapping('M1') };
  const candidate = { ...baseline, change: 'data_addition', proposalId: 'P2', reason: 'candidate' };
  
  take(await f.runtime.registerProposal(baseline));
  take(await f.runtime.registerProposal(candidate));
  
  // Compare should reject empty query plans
  reject(await f.runtime.compare(baseline, candidate), 'invalid_input');
  
  await f.store.close();
});

// Regression test for Finding 4: Stale conformance blocks later certification
test('L3 verified skips stale conformance and accepts newer records', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { ...plan, queries: [{ all: true }] } });
  await f.versions();
  
  // Certify with the original query
  const checks1 = take(await f.runtime.inspectMapping(mapping()));
  take(await f.runtime.recordConformance(mapping(), checks1.map(c => c.checkId)));
  
  // Verify store works
  take(await f.runtime.store('message-1', mapping()));
  
  // Now change the queries
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ messageId: 'message-1' }] } });
  
  // The old conformance record is now stale (wrong queries)
  // Before the fix, this would fail immediately
  // After the fix, we need to add a new conformance record
  const checks2 = take(await runtime2.inspectMapping(mapping()));
  take(await runtime2.recordConformance(mapping(), checks2.map(c => c.checkId)));
  
  // Now store should work with the new queries
  take(await runtime2.store('message-1', mapping()));
  
  await f.store.close();
});

// Additional test for Finding 4: Multiple conformance records
test('L3 verified finds the current conformance among multiple records', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { ...plan, queries: [{ all: true }] } });
  await f.versions();
  
  // Create first conformance
  const checks1 = take(await f.runtime.inspectMapping(mapping()));
  take(await f.runtime.recordConformance(mapping(), checks1.map(c => c.checkId)));
  
  // Change to a different query set
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ messageId: 'message-1' }] } });
  const checks2 = take(await runtime2.inspectMapping(mapping()));
  take(await runtime2.recordConformance(mapping(), checks2.map(c => c.checkId)));
  
  // Both should work with their respective runtimes
  take(await f.runtime.store('message-1', mapping()));
  take(await runtime2.store('message-1', mapping()));
  
  await f.store.close();
});

const planDigest = (comparison, originals) => digestJson({ queries: comparison.queries, expectedConditions: comparison.expectedConditions, originalIds: comparison.originalIds, originalSetDigest: digestJson(originals) });

test('empty original set cannot certify a mapping or authorise store', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { originalIds: [], queries: [{ all: true }], expectedConditions: { payloads: {} } } });
  await f.versions();
  reject(await f.runtime.inspectMapping(mapping()), 'invalid_input');
  assert.equal(rows(await f.snapshot(), 'storage.inspections').length, 0);
  reject(await f.runtime.store('message-1', mapping()), 'unavailable');
  await f.store.close();
});

test('recordConformance rejects a vacuous passing check for an empty original set', async () => {
  const queries = [{ all: true }];
  const expectedConditions = { payloads: {} };
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { originalIds: [], queries, expectedConditions } });
  await f.versions();
  const map = mapping();
  const originalInput = { originals: [], versions: map.versions, mappingDigest: digestJson(map) };
  const retrieved = { literals: {}, units: [], query: queries[0] };
  const criteriaDigest = f.options.comparison.criteriaDigest;
  const evaluatorVersion = f.options.comparison.evaluatorVersion;
  const inputDigest = digestJson({ original: originalInput, retrieved, expectedConditions, criteriaDigest, evaluatorVersion, scope: f.options.scope });
  const requestBody = { executionId: 'execution-empty-original', taskId: f.options.taskId, original: originalInput, retrieved, expectedConditions, inputDigest, evaluatorVersion, criteriaDigest, scope: f.options.scope };
  const check = { checkId: 'check-empty-original', mappingDigest: digestJson(map), originalSetDigest: digestJson([]), querySetDigest: digestJson(queries), request: requestBody, result: { executionId: requestBody.executionId, inputDigest, evaluatorVersion, criteriaDigest, scope: f.options.scope, literalRestoration: 'pass', meaningPreservation: 'pass', retrievalCorrectness: 'pass', evidenceIds: ['public-storage-oracle'], limitation: null }, evidenceKind: 'host_evaluation_port' };
  await f.append('storage.inspections', check.checkId, check);
  reject(await f.runtime.recordConformance(map, [check.checkId]), 'invalid_input');
  assert.equal(rows(await f.snapshot(), 'storage.conformance').length, 0);
  reject(await f.runtime.store('message-1', map), 'unavailable');
  await f.store.close();
});

test('compare rejects an empty original set instead of selecting a vacuous pass', async () => {
  const queries = [{ all: true }];
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { originalIds: [], queries, expectedConditions: { payloads: {} } } });
  await f.versions();
  const baseline = { proposalId: 'P1', baselineProposalId: 'P1', change: 'maintain', reason: 'baseline', budgetRef: 'synthetic-budget', languageVersionId: 'L1', originalSetDigest: digestJson([]), querySetDigest: digestJson(queries), queryExamples: queries, structureSpecification: 'test', migrationSpecification: 'test', limitations: [], unknowns: [], mapping: mapping('M1') };
  const candidate = { ...baseline, change: 'data_addition', proposalId: 'P2', reason: 'candidate' };
  take(await f.runtime.registerProposal(baseline));
  take(await f.runtime.registerProposal(candidate));
  reject(await f.runtime.compare(baseline, candidate), 'invalid_input');
  assert.equal(rows(await f.snapshot(), 'storage.comparisons').length, 0);
  assert.equal(rows(await f.snapshot(), 'storage.inspections').length, 0);
  await f.store.close();
});

test('standalone conformance does not authorise a different inspected original set', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan, seed: true });
  f.options.inspectionEligibility = undefined;
  const runtime1 = createStoragePlanner(f.options);
  await f.versions();
  const checks = take(await runtime1.inspectMapping(mapping()));
  take(await runtime1.recordConformance(mapping(), checks.map(c => c.checkId)));
  take(await runtime1.store('message-1', mapping()));
  await f.append('host.originals', 'message-2', original('message-2'));
  const otherIds = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, originalIds: ['message-1', 'message-2'] } });
  reject(await otherIds.store('message-1', mapping()), 'unavailable');
  reject(await otherIds.retrieve({ all: true }, mapping()), 'unavailable');
  const altered = original('message-1', { ...clausePayload, clauses: [] });
  const otherContent = createStoragePlanner({ ...f.options, references: { ...f.options.references, async readOriginal(s, id) {
    if (id === 'message-1') return { ok: true, value: altered };
    return f.options.references.readOriginal(s, id);
  } } });
  reject(await otherContent.retrieve({ all: true }, mapping()), 'unavailable');
  await f.store.close();
});

test('digest-less conformance does not authorise standalone store', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan });
  await f.versions();
  await f.append('storage.conformance', 'unbound', { mappingDigest: digestJson(mapping()), ids: ['not-a-real-check'], criteriaDigest: f.options.comparison.criteriaDigest, evaluatorVersion: f.options.comparison.evaluatorVersion });
  reject(await f.runtime.store('message-1', mapping()), 'unavailable');
  reject(await f.runtime.retrieve({ all: true }, mapping()), 'unavailable');
  await f.store.close();
});

test('shadow conformance stays bound to the inspection plan that produced it', async () => {
  const f = await migrationFixture();
  const prepared = take(await f.runtime.migration.prepare(await migrationRequest(f)));
  take(await f.runtime.migration.catchUp(prepared.migrationId, (await f.snapshot()).revision));
  take(await f.runtime.migration.switch({ migrationId: prepared.migrationId, expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  const bound = planDigest(f.options.comparison, [original()]);
  const targetDigest = digestJson(targetMapping);
  const targetRows = rows(await f.snapshot(), 'storage.conformance').filter(row => row.mappingDigest === targetDigest);
  assert.ok(targetRows.length > 1);
  assert.ok(targetRows.every(row => row.inspectionPlanDigest === bound));
  take(await f.runtime.retrieve({ all: true }, targetMapping));
  const otherQueries = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ messageId: 'message-1' }] } });
  reject(await otherQueries.retrieve({ messageId: 'message-1' }, targetMapping), 'unavailable');
  reject(await otherQueries.store('message-1', targetMapping), 'unavailable');
  const otherConditions = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, expectedConditions: { payloads: { 'message-1': { ...clausePayload, clauses: [] } } } } });
  reject(await otherConditions.retrieve({ all: true }, targetMapping), 'unavailable');
  await f.store.close();
});

test('recordConformance rejects checks collected under different expected conditions', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan });
  await f.versions();
  const checks = take(await f.runtime.inspectMapping(mapping()));
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, expectedConditions: { payloads: { 'message-1': { ...clausePayload, clauses: [] } } } } });
  reject(await runtime2.recordConformance(mapping(), checks.map(c => c.checkId)), 'invalid_input');
  reject(await runtime2.store('message-1', mapping()), 'unavailable');
  assert.equal(rows(await f.snapshot(), 'storage.conformance').length, 0);
  await f.store.close();
});

test('canonical eligibility recovers store after a stale conformance record', async () => {
  const f = await recordingFixture();
  await f.certify();
  take(await f.runtime.store('message-1', mapping()));
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ messageId: 'message-1' }] } });
  const checks = take(await runtime2.inspectMapping(mapping()));
  take(await runtime2.recordConformance(mapping(), checks.map(c => c.checkId)));
  take(await runtime2.store('message-1', mapping()));
  await f.store.close();
});

test('a live generation manifest does not block certification under a new query plan', async () => {
  const f = await recordingFixture();
  await f.certify();
  await f.certify(targetMapping);
  take(await f.runtime.store('message-1', mapping()));
  const prepared = take(await f.runtime.migration.prepare(await migrationRequest(f)));
  take(await f.runtime.migration.catchUp(prepared.migrationId, (await f.snapshot()).revision));
  take(await f.runtime.migration.switch({ migrationId: prepared.migrationId, expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  const runtime2 = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, queries: [{ messageId: 'message-1' }] } });
  const checks = take(await runtime2.inspectMapping(targetMapping));
  take(await runtime2.recordConformance(targetMapping, checks.map(c => c.checkId)));
  const selected = take(await runtime2.retrieve({ messageId: 'message-1' }, targetMapping));
  assert.deepEqual(selected.map(unit => unit.source.messageId), ['message-1']);
  await f.store.close();
});
