import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner, syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, mapping, original, clausePayload, take, reject, rows } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';

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
