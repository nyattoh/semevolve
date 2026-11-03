import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { createStoragePlanner, syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, mapping, original, clausePayload, now, taskId, scope, take, reject, rows } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';
import { migrationFixture, checkedMigration, targetMapping } from './migration-fixtures.mjs';

const plan = { expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': clausePayload } } };
for (const location of [
  { kind: 'range', start: -1, end: 1, unit: 'utf16_code_unit' },
  { kind: 'range', start: 2, end: 1, unit: 'utf16_code_unit' },
  { kind: 'range', start: 0, end: 99999, unit: 'utf16_code_unit' },
  { kind: 'range', start: 0.5, end: 1, unit: 'utf16_code_unit' },
  { kind: 'range', start: 0, end: 1, unit: 'byte' },
  { kind: 'unknown', reason: '' },
]) test(`L1 rejects invalid original range ${JSON.stringify(location)}`, async () => {
  const base = syntheticStorageAdapters()[0];
  const broken = { ...base, async decompose(...args) { const r = await base.decompose(...args); if (r.ok) r.value[0].source.location = location; return r; } };
  const f = await fixture({ adapters: [broken], evaluator: evaluationDouble(), plan }); await f.versions();
  reject(await f.runtime.inspectMapping(mapping())); assert.deepEqual(rows(await f.snapshot(), 'storage.inspections'), []); await f.store.close();
});

test('L1 unknown ranges and ambiguity survive without guessed positions', async () => {
  const base = syntheticStorageAdapters()[0];
  const unknown = { ...base, async decompose(...args) { const r = await base.decompose(...args); if (r.ok) { r.value[0].source.location = { kind: 'unknown', reason: 'Two possible source spans' }; r.value[0].ambiguities = ['Both spans remain possible']; } return r; } };
  const f = await fixture({ adapters: [unknown], evaluator: evaluationDouble(), plan }); await f.versions(); await f.certify();
  const units = take(await f.runtime.store('message-1', mapping()));
  assert.deepEqual(units[0].source.location, { kind: 'unknown', reason: 'Two possible source spans' });
  assert.deepEqual(take(await f.runtime.trace(units[0].unitId)).units[0].ambiguities, ['Both spans remain possible']); await f.store.close();
});

test('L1 three certified many-to-many combinations preserve their original versions', async () => {
  for (const m of [mapping(), mapping('M2', 'L1', 'R1', 'S2'), mapping('M3', 'L2', 'R2', 'S1')]) {
    const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan });
    if (m.versions.languageVersionId === 'L2') {
      await f.registerLanguage('L2');
      const read = f.options.references.readOriginal;
      f.options.references.readOriginal = async (s, id) => { const r = await read(s, id); if (r.ok && r.value) { r.value.message.envelope.language_version_id = 'L2'; r.value.message.digest = digestJson(r.value.message.envelope); } return r; };
    }
    await f.versions(m); await f.certify(m); const saved = take(await f.runtime.store('message-1', m));
    assert.deepEqual(take(await f.runtime.retrieve({ all: true }, m)).map(u => u.versions), saved.map(() => m.versions));
    reject(await f.runtime.store('message-1', mapping('unverified', 'L2', 'R1', 'S2')), 'unavailable'); await f.store.close();
  }
});

test('L2 insufficient independent information remains inconclusive and cannot certify', async () => {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { expectedConditions: { payloads: {} } } });
  await f.versions(); const checks = take(await f.runtime.inspectMapping(mapping()));
  assert.equal(checks[0].result.meaningPreservation, 'inconclusive'); reject(await f.runtime.recordConformance(mapping(), checks.map(c => c.checkId)), 'unavailable'); await f.store.close();
});

test('L1 a foreign-task check and dangling interpretation cannot become actual evidence', async () => {
  for (const ref of ['check', 'interpretation']) {
    const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan }); await f.versions();
    const o = original('message-2');
    if (ref === 'check') {
      o.checkRefs = ['foreign'];
      await f.append('host.checks', 'foreign', { context: { taskId: 'foreign-task', messageId: 'message-2', languageVersionId: 'L1', scope }, execution: { taskId: 'foreign-task', executionId: 'real-but-foreign', inputDigest: digestJson('foreign'), performedAt: now, result: { checkId: 'foreign', targetMessageId: 'message-2', languageVersionId: 'L1', scope, dimension: 'factuality', verdict: 'pass' } } });
    } else o.interpretationRefs = ['missing'];
    await f.append('host.originals', 'message-2', o); reject(await f.runtime.recordOriginal('message-2')); await f.store.close();
  }
});

test('L4 fresh related check withdrawal invalidates a checked migration and trace preserves unknown', async () => {
  let withdrawn = false;
  const check = { context: { taskId, messageId: 'message-2', languageVersionId: 'L1', scope }, execution: { taskId, executionId: 'actual-check', inputDigest: digestJson('actual'), performedAt: now, result: { checkId: 'actual-check', targetMessageId: 'message-2', languageVersionId: 'L1', scope, dimension: 'factuality', verdict: 'fail', method: 'deterministic_test', evidenceIds: ['actual-failure'], evaluatorVersion: 'public', limitation: 'synthetic' }, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: 0, source: 'unavailable' } } };
  const f = await migrationFixture({ referenceChanges: { async readCheck() { return { ok: true, value: withdrawn ? null : check }; } } });
  const o = original('message-2'); o.checkRefs = ['actual-check']; await f.append('host.originals', 'message-2', o); take(await f.runtime.store('message-2', mapping()));
  await checkedMigration(f); const head = take(await f.runtime.head()); withdrawn = true;
  const result = await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' });
  assert.equal(result.ok, false); assert.deepEqual(take(await f.runtime.head()), head);
  assert.equal(take(await f.runtime.trace('actual-check')).unknowns.length, 1); await f.store.close();
});

for (const field of ['taskId', 'target', 'name', 'revokedAt', 'policyRevision']) test(`L4 grant ${field} must match current host authority`, async () => {
  const f = await migrationFixture(); await checkedMigration(f); const before = take(await f.runtime.head());
  const read = f.options.references.readGrant;
  f.options.references.readGrant = async (s, ref) => { const r = await read(s, ref); if (r.ok && r.value) r.value[field] = field === 'policyRevision' ? 2 : field === 'revokedAt' ? now : 'foreign'; return r; };
  reject(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), before); await f.store.close();
});

test('L3 a new criterion uses a distinct execution and cannot reuse prior conformance', async () => {
  const f = await migrationFixture();
  const runtime = createStoragePlanner({ ...f.options, comparison: { ...f.options.comparison, criteriaDigest: digestJson('different-criterion') } });
  reject(await runtime.store('message-1', mapping()), 'unavailable');
  const checks = take(await runtime.inspectMapping(mapping())); assert.equal(checks[0].request.criteriaDigest, digestJson('different-criterion'));
  const inspections = rows(await f.snapshot(), 'storage.inspections');
  inspections.sort((left, right) => Number(right.request.criteriaDigest === digestJson('different-criterion')) - Number(left.request.criteriaDigest === digestJson('different-criterion')));
  assert.equal(inspections[0].request.criteriaDigest, digestJson('different-criterion'));
  const previous = inspections.filter(check => check.request.criteriaDigest === f.options.comparison.criteriaDigest);
  assert.ok(previous.length > 0, 'The old criterion inspection must exist');
  for (const old of previous) assert.notEqual(checks[0].request.executionId, old.request.executionId);
  await f.store.close();
});

test('L5 a write during restoration invalidates its inspection and preserves the live head', async () => {
  const f = await migrationFixture(); await checkedMigration(f); take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
  const head = take(await f.runtime.head());
  const evaluate = f.options.evaluator.evaluateStorage.bind(f.options.evaluator); let armed = true;
  f.options.evaluator.evaluateStorage = async request => { const result = await evaluate(request); if (armed) { armed = false; await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', targetMapping)); } return result; };
  reject(await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' }), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), head); const r = take(await f.runtime.migration.reconcile('migration-1'));
  assert.equal(r.restoration.verified, false); assert.equal(r.pendingOperation.operation, 'restore'); await f.store.close();
});
