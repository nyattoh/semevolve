import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, original, mapping, clausePayload, graphPayload, now, taskId, scope, take, reject, rows } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';

export async function prepared(extra = {}) {
  const evaluator = extra.evaluator ?? evaluationDouble();
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator, plan: { expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': clausePayload, 'graph-1': graphPayload } } }, ...extra });
  await f.versions();
  return { ...f, evaluator };
}

test('L2 round trip has three independent checks, host CheckIds and idempotent storage', async () => {
  const f = await prepared();
  const checks = await f.certify();
  assert.deepEqual(checks.map(c => [c.result.literalRestoration, c.result.meaningPreservation, c.result.retrievalCorrectness]), [['pass', 'pass', 'pass']], 'L2_THREE_CHECKS');
  assert.equal(checks[0].request.inputDigest, checks[0].result.inputDigest);
  const units = take(await f.runtime.store('message-1', mapping()));
  assert.equal(units[0].source.digest, original().payloadDigest);
  assert.deepEqual(units[0].source.location, { kind: 'range', start: 0, end: original().message.envelope.payload.length, unit: 'utf16_code_unit' });
  assert.deepEqual(take(await f.runtime.retrieve({ all: true }, mapping())), units);
  const before = await f.snapshot();
  assert.deepEqual(take(await f.runtime.store('message-1', mapping())), units);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(take(await f.runtime.trace(units[0].unitId)).units, units);
  assert.equal(rows(before, 'storage.inspections').length, 1);
  assert.equal(f.evaluator.requests[0].scope, scope);
  await f.store.close();
});

for (const field of ['negation', 'condition', 'uncertainty', 'time', 'reference']) test(`L2 literal restoration does not excuse dropped ${field}`, async () => {
  const adapters = syntheticStorageAdapters();
  const base = adapters.find(a => a.id === 'clauses');
  const broken = { ...base, id: 'broken', async decompose(...args) { const r = await base.decompose(...args); if (r.ok) for (const u of r.value) for (const c of u.representation.meaning.clauses) delete c[field]; return r; } };
  const f = await prepared({ adapters: [...adapters, broken] });
  const bad = mapping('broken', 'L1', 'bad-rule', 'S1'); await f.versions(bad, 'broken');
  const checks = take(await f.runtime.inspectMapping(bad));
  assert.equal(checks[0].result.literalRestoration, 'pass');
  assert.equal(checks[0].result.meaningPreservation, 'fail', `L2_DROP_${field}`);
  reject(await f.runtime.recordConformance(bad, checks.map(c => c.checkId)), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), null);
  await f.store.close();
});

test('L2 directed graph retains direction and candidates without fixed SVO slots', async () => {
  const f = await prepared({ plan: { originalIds: ['graph-1'], queries: [{ all: true }], expectedConditions: { payloads: { 'graph-1': graphPayload } } } });
  await f.append('host.originals', 'graph-1', original('graph-1', graphPayload));
  const m = mapping('graph', 'L1', 'graph-rule', 'S2'); await f.versions(m, 'graph'); await f.certify(m);
  const units = take(await f.runtime.store('graph-1', m));
  assert.deepEqual(units[0].representation.meaning.edges, graphPayload.edges);
  assert.deepEqual(units[0].representation.meaning.nodes, ['A', 'B']);
  const base = syntheticStorageAdapters().find(a => a.id === 'graph');
  const broken = { ...base, id: 'reverse', async decompose(...args) { const r = await base.decompose(...args); if (r.ok) for (const u of r.value) for (const edge of u.representation.meaning.edges) [edge.from, edge.to] = [edge.to, edge.from]; return r; } };
  const g = await prepared({ adapters: [broken], plan: { originalIds: ['graph-1'], queries: [{ all: true }], expectedConditions: { payloads: { 'graph-1': graphPayload } } } });
  await g.append('host.originals', 'graph-1', original('graph-1', graphPayload));
  await g.versions(m, 'reverse');
  assert.equal(take(await g.runtime.inspectMapping(m))[0].result.meaningPreservation, 'fail');
  await f.store.close(); await g.store.close();
});

test('L2 preserves an erroneous success claim separately from a failed actual event and factuality', async () => {
  const f = await prepared();
  const o = original('message-2'); o.eventRefs = ['actual-failure']; o.checkRefs = ['factual-check']; o.interpretationRefs = ['interpretation-1'];
  const context = { taskId, messageId: 'message-2', languageVersionId: 'L1', scope };
  const interpretation = { messageId: 'message-2', receiverId: 'peer-b', inputSnapshot: 'success claim', inputDigest: digestJson('success claim'), answer: 'Sender claims success', recordedAt: now, expectedConditionsDisclosedAt: null };
  const execution = take(await f.evaluator.evaluate({ executionId: 'fact-execution', taskId, targetMessageId: 'message-2', languageVersionId: 'L1', dimension: 'factuality', interpretation, expectedConditions: {}, evidence: [], inputDigest: digestJson('actual failed event'), evaluatorVersion: 'synthetic-double-v1', criteriaDigest: digestJson('facts'), scope }));
  await f.append('host.checks', 'factual-check', { context, execution });
  await f.append('host.interpretations', 'interpretation-1', { id: 'interpretation-1', context, interpretation });
  await f.append('host.originals', 'message-2', o, [{ eventId: 'actual-failure', taskId, actor: 'host', kind: 'synthetic.actual-failure', occurredAt: now, data: { ...context, outcome: 'failure' } }]);
  await f.certify();
  const units = take(await f.runtime.store('message-2', mapping()));
  const trace = take(await f.runtime.trace('actual-failure'));
  assert.deepEqual(trace.units, units);
  assert.equal(trace.units[0].representation.meaning.clauses[1].claim, 'success');
  assert.equal(trace.events[0].data.outcome, 'failure');
  assert.equal(trace.checks[0].result.dimension, 'factuality');
  assert.equal(trace.checks[0].result.verdict, 'fail');
  assert.deepEqual(trace.interpretations, [interpretation]);
  assert.deepEqual(trace.unknowns, []);
  assert.equal(rows(await f.snapshot(), 'storage.inspections')[0].result.meaningPreservation, 'pass');
  await f.store.close();
});

for (const field of ['executionId', 'inputDigest', 'criteriaDigest', 'evaluatorVersion', 'scope']) test(`L2 refuses mismatched evaluator ${field}`, async () => {
  const f = await prepared({ evaluator: evaluationDouble(r => ({ ...r, [field]: field.endsWith('Digest') ? digestJson('other') : 'other' })) });
  reject(await f.runtime.inspectMapping(mapping()));
  assert.deepEqual(rows(await f.snapshot(), 'storage.inspections'), []);
  await f.store.close();
});
