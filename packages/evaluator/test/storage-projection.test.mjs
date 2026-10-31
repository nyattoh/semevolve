import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { createEvaluator } from '@semevolve/evaluator';
import { fixture, identity, storageRequest, value } from './support/fixture.mjs';
import { policyHost } from './support/policy.mjs';
import { payloads, projectionFixture, projectionRequest, rehash, verdicts } from './support/storage-projection.mjs';

for (const query of [{ all: true }, { messageId: 'public-message' }, { messageId: 'graph-message' }, { messageId: 'absent' }]) {
  test(`projection compares L wrappers against the frozen query ${JSON.stringify(query)}`, { timeout: 30000 }, async () => {
    const host = await policyHost();
    const f = projectionFixture(host);
    const req = projectionRequest(f, query);
    const result = await f.runtime.evaluateStorage(req);
    assert.deepEqual(result.ok ? verdicts(result.value) : result.error, ['pass', 'pass', 'pass']);
    assert.deepEqual([result.value.executionId, result.value.inputDigest, result.value.criteriaDigest], [req.executionId, req.inputDigest, req.criteriaDigest]);
    const snapshot = value(await host.store.snapshot());
    const saved = snapshot.entries.find(e => e.key.collection === 'evaluator.requests').value;
    assert.deepEqual(saved.request, req);
    assert.equal(saved.requestDigest, digestJson({ runId: f.run.runId, kind: 'storage', request: req }));
    assert.equal(snapshot.entries.filter(e => e.key.collection === 'evaluator.storage-results').length, 1);
  });
}

const changes = [
  ['raw literal corruption', r => { r.retrieved.literals['public-message'] += '!'; }, ['fail', 'pass', 'pass']],
  ['literal unavailable', r => { r.retrieved.literals['public-message'] = null; }, ['inconclusive', 'pass', 'pass']],
  ['literal missing', r => { delete r.retrieved.literals['public-message']; }, ['inconclusive', 'pass', 'pass']],
  ['meaning observation missing', r => { delete r.retrieved.units[0].representation.meaning; }, ['pass', 'inconclusive', 'pass']],
  ['meaning explicitly null', r => { r.retrieved.units[0].representation.meaning = null; }, ['pass', 'fail', 'pass']],
  ['units missing', r => { delete r.retrieved.units; }, ['pass', 'inconclusive', 'inconclusive']],
  ['units explicitly malformed', r => { r.retrieved.units = {}; }, ['pass', 'fail', 'fail']],
  ['selected ID omitted', r => { r.retrieved.units.pop(); }, ['pass', 'pass', 'fail']],
  ['all selected IDs deleted', r => { r.retrieved.units = []; }, ['pass', 'pass', 'fail']],
  ['unknown query', r => { r.retrieved.query = { all: false }; }, ['pass', 'pass', 'inconclusive']],
  ['wrong query selection', r => { r.retrieved.query = { messageId: 'public-message' }; }, ['pass', 'pass', 'fail']],
  ['source ID fabricated', r => { r.retrieved.units[0].source.messageId = 'fabricated'; }, ['pass', 'fail', 'fail']],
  ['source digest corrupt', r => { r.retrieved.units[0].source.digest = 'a'.repeat(64); }, ['pass', 'fail', 'pass']],
  ['source range corrupt', r => { r.retrieved.units[0].source.location.end--; }, ['pass', 'fail', 'pass']],
  ['source location unknown', r => { r.retrieved.units[0].source.location = { kind: 'unknown', reason: 'Unobserved range' }; }, ['pass', 'inconclusive', 'pass']],
  ['version changed', r => { r.retrieved.units[0].versions.ruleVersionId = 'other'; }, ['pass', 'fail', 'pass']],
  ['event provenance removed', r => { r.retrieved.units[0].eventRefs = []; }, ['pass', 'fail', 'pass']],
  ['interpretation provenance fabricated', r => { r.retrieved.units[0].interpretationRefs = ['invented']; }, ['pass', 'fail', 'pass']],
  ['check provenance fabricated', r => { r.retrieved.units[0].checkRefs = ['invented']; }, ['pass', 'fail', 'pass']],
  ['ambiguity unresolved', r => { r.retrieved.units[0].ambiguities = ['Missing relation']; }, ['pass', 'inconclusive', 'pass']],
  ['semantic clause order changed', r => { r.retrieved.units[0].representation.meaning.clauses.reverse(); }, ['pass', 'fail', 'pass']],
  ['semantic graph nodes reordered', r => { r.retrieved.units[1].representation.meaning.nodes.reverse(); }, ['pass', 'fail', 'pass']],
  ['semantic graph candidates reordered', r => { r.retrieved.units[1].representation.meaning.edges[0].candidates.reverse(); }, ['pass', 'fail', 'pass']],
  ['graph direction reversed', r => { const edge = r.retrieved.units[1].representation.meaning.edges[0]; [edge.from, edge.to] = [edge.to, edge.from]; }, ['pass', 'fail', 'pass']],
];
for (const field of ['negation', 'condition', 'uncertainty', 'time', 'reference']) {
  for (const shape of ['clause', 'graph']) changes.push([`${shape} explicit deletion of ${field}`, r => { delete (shape === 'clause' ? r.retrieved.units[0].representation.meaning.clauses[0] : r.retrieved.units[1].representation.meaning.edges[0])[field]; }, ['pass', 'fail', 'pass']]);
}
for (const [name, change, expected] of changes) test(`projection ${name}`, { timeout: 30000 }, async () => {
  const f = projectionFixture();
  const req = projectionRequest(f);
  change(req);
  assert.deepEqual(verdicts(value(await f.runtime.evaluateStorage(rehash(req)))), expected);
});

test('projection requires the fixed full criteria, task, scope, evaluator and input digest', { timeout: 30000 }, async () => {
  for (const field of ['taskId', 'scope', 'criteriaDigest', 'evaluatorVersion', 'inputDigest', 'expectedConditions']) {
    const f = projectionFixture();
    const good = projectionRequest(f);
    assert.deepEqual(verdicts(value(await f.runtime.evaluateStorage(good))), ['pass', 'pass', 'pass']);
    const bad = { ...good, executionId: identity.newId('execution'), [field]: field.endsWith('Digest') ? digestJson('changed') : field === 'expectedConditions' ? { ...good.expectedConditions, payloads: { ...payloads, 'public-message': { kind: 'clause_sequence', clauses: [] } } } : 'changed' };
    assert.equal((await f.runtime.evaluateStorage(bad)).error.code, 'invalid_input');
  }
});

test('projection replay uses one real Policy reservation and a different ID performs a new check', { timeout: 30000 }, async () => {
  const host = await policyHost();
  const f = projectionFixture(host);
  const req = projectionRequest(f);
  const first = value(await f.runtime.evaluateStorage(req));
  const before = value(await host.store.snapshot());
  assert.deepEqual(value(await f.runtime.evaluateStorage(req)), first);
  assert.deepEqual(value(await host.store.snapshot()), before);
  const collision = rehash({ ...req, retrieved: { ...req.retrieved, query: { messageId: 'graph-message' } } });
  assert.equal((await f.runtime.evaluateStorage(collision)).error.code, 'id_collision');
  const next = value(await f.runtime.evaluateStorage({ ...req, executionId: identity.newId('execution') }));
  assert.notEqual(next.executionId, first.executionId);
  const saved = value(await host.store.snapshot());
  assert.equal(saved.entries.filter(e => e.key.collection === 'evaluator.requests').length, 2);
  assert.equal(saved.entries.filter(e => e.key.collection === 'evaluator.storage-results').length, 2);
  assert.equal(value(await host.policy.snapshot(host.task.taskId)).usage.invocations, 2);
});

test('projection and storage-v1 retain separate runs and immutable prior results', { timeout: 30000 }, async () => {
  const old = fixture();
  const data = { certainty: 'candidate', ids: ['record-a'] };
  const req = storageRequest(old, data, data);
  const prior = value(await old.runtime.evaluateStorage(req));
  const current = projectionFixture({ store: old.store });
  const projected = value(await current.runtime.evaluateStorage(projectionRequest(current)));
  assert.deepEqual(verdicts(projected), ['pass', 'pass', 'pass']);
  assert.deepEqual(value(await old.runtime.evaluateStorage(req)), prior);
  assert.equal(value(await old.store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.runs').length, 2);
});

test('projection profiles reject duplicate query digests, duplicate IDs and extra executable fields', { timeout: 30000 }, async () => {
  for (const change of [p => p.queries.push(structuredClone(p.queries[0])), p => p.queries[0].messageIds.push('public-message'), p => { p.script = 'never execute'; }]) {
    const f = projectionFixture();
    const expectedConditions = structuredClone(f.run.expectedConditions);
    change(expectedConditions.storage);
    assert.throws(() => createEvaluator({ store: f.store, run: { ...f.run, expectedConditions, criteriaDigest: digestJson(expectedConditions) } }), /Invalid evaluator configuration/);
  }
});
