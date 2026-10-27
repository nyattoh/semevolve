import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson, createMemoryTaskStore, hostIdentity } from '@semevolve/core';
import { createLanguageRegistry } from '@semevolve/language-registry';
import { fixture, language, record, proof, fingerprints, criteria, scope, take, rejected, epoch, request } from './fixtures.mjs';

test('immutable content, parents and scope are checked without rewriting the original', async () => {
  const f = fixture();
  const original = await f.register();
  for (const changes of [{ specification_text: 'Changed' }, { parent_ids: ['unknown'] }, { scope: { ...scope, purpose: 'Changed' } }]) {
    rejected(await f.registry.register(language(original.version_id, changes)), 'id_collision');
  }
  rejected(await f.registry.register(language('child', { parent_ids: ['unknown'] })));
  rejected(await f.registry.register({ ...language('bad-digest'), digest: digestJson('wrong') }));
  rejected(await f.registry.register(language('foreign-scope', { scope: { ...scope, participantIds: ['peer-c'] } })));
  take(await f.registry.register(language('child', { parent_ids: [original.version_id] })));
  assert.deepEqual(take(await f.registry.get(original.version_id)), original);
  assert.equal(take(await f.registry.get('unknown')), null);
});

test('independent conformance is recorded and replayed without duplicate history', async () => {
  const f = fixture(); await f.register();
  const r = record(); await f.certify(r);
  const before = take(await f.store.snapshot());
  take(await f.registry.recordConformance(r));
  assert.deepEqual(take(await f.store.snapshot()), before);
  assert.deepEqual(take(await f.registry.conformance(r.versionId, r.fingerprint, r.scopeId)), [r]);
});

for (const [name, corrupt] of [
  ['self report', () => null],
  ['agreement', p => ({ ...p, independent: false })],
  ['unfixed test set', p => ({ ...p, fixedBeforeRun: false })],
  ['record substitution', p => ({ ...p, record: { ...p.record, testSetDigest: digestJson('other') } })],
  ['unrelated check', p => { p.checks[0].result.languageVersionId = 'other'; return p; }],
  ['wrong scope', p => { p.checks[0].result.scope = 'other'; return p; }],
  ['wrong evaluator', p => { p.checks[0].result.evaluatorVersion = 'other'; return p; }],
  ['fact instead of transmission', p => { p.checks[0].result.dimension = 'factuality'; return p; }],
  ['model judgement', p => { p.checks[0].result.method = 'model_judgment'; return p; }],
  ['missing check', p => ({ ...p, checks: [] })],
  ['fail mislabelled pass', p => { p.checks[0].result.verdict = 'fail'; return p; }],
  ['inconclusive mislabelled pass', p => { p.checks[0].result.verdict = 'inconclusive'; return p; }],
  ['regression mislabelled pass', p => ({ ...p, regressionVerdict: 'fail' })],
]) test(`rejects ${name} as conformance evidence`, async () => {
  const f = fixture(); await f.register(); const r = record();
  f.proofs.set(digestJson(r), corrupt(proof(r)));
  rejected(await f.registry.recordConformance(r));
  assert.deepEqual(take(await f.registry.conformance(r.versionId, r.fingerprint, r.scopeId)), []);
  await f.certify(r);
  assert.deepEqual(take(await f.registry.conformance(r.versionId, r.fingerprint, r.scopeId)), [r]);
});

test('candidate, trial, active, quarantine, retirement and restoration append history', async () => {
  const f = fixture(); const v = await f.activate();
  take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.status(v.version_id, 'QUARANTINED'));
  rejected(await f.registry.selectHead(scope.scopeId, v.version_id, 1));
  take(await f.status(v.version_id, 'RETIRED'));
  take(await f.status(v.version_id, 'TRIAL', [], '-restore'));
  take(await f.status(v.version_id, 'ACTIVE', fingerprints.flatMap(p => record(v.version_id, p).checkIds), '-restore'));
  assert.deepEqual(take(await f.registry.selectHead(scope.scopeId, v.version_id, 1)), { scopeId: scope.scopeId, activeVersionId: v.version_id, revision: 2 });
  assert.deepEqual(take(await f.registry.statusEvents(v.version_id)).map(e => e.status), ['CANDIDATE', 'TRIAL', 'ACTIVE', 'QUARANTINED', 'RETIRED', 'TRIAL', 'ACTIVE']);
});

for (const verdict of ['fail', 'inconclusive']) test(`regression ${verdict} prevents adoption and preserves the previous head`, async () => {
  const f = fixture(); const old = await f.activate(); take(await f.registry.selectHead(scope.scopeId, old.version_id, 0));
  const v = await f.register(language('candidate', { parent_ids: [old.version_id] }));
  take(await f.status(v.version_id, 'CANDIDATE')); take(await f.status(v.version_id, 'TRIAL'));
  for (const fingerprint of fingerprints) await f.certify(record(v.version_id, fingerprint, verdict));
  rejected(await f.status(v.version_id, 'ACTIVE', fingerprints.flatMap(p => record(v.version_id, p, verdict).checkIds)));
  rejected(await f.registry.selectHead(scope.scopeId, v.version_id, 1));
  assert.equal(take(await f.registry.head(scope.scopeId)).activeVersionId, old.version_id);
  assert.equal(take(await f.registry.conformance(v.version_id, fingerprints[0], scope.scopeId))[0].verdict, verdict);
});

test('claims and check IDs alone cannot activate a candidate; long conforming content can', async () => {
  const f = fixture(); const v = await f.register(language('long', { specification_text: '必要な条件・否定・不確実性。'.repeat(1000) }));
  take(await f.status(v.version_id, 'CANDIDATE')); take(await f.status(v.version_id, 'TRIAL'));
  rejected(await f.status(v.version_id, 'ACTIVE', ['existing-check']));
  const records = fingerprints.map(p => record(v.version_id, p));
  for (const r of records) await f.certify(r);
  take(await f.status(v.version_id, 'ACTIVE', records.flatMap(r => r.checkIds)));
  take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  assert.equal(take(await f.registry.get(v.version_id)).specification_text, v.specification_text);
});

for (const field of ['modelId', 'cliVersion', 'settingsDigest', 'introductionDigest']) test(`changed ${field} cannot reuse prior conformance`, async () => {
  const f = fixture(); const v = await f.activate();
  const changed = { ...criteria, fingerprints: fingerprints.map(p => ({ ...p, [field]: field.endsWith('Digest') ? digestJson('changed') : 'changed' })) };
  const registry = createLanguageRegistry({ ...f.options, scopes: [changed] });
  rejected(await registry.selectHead(scope.scopeId, v.version_id, 0));
  assert.deepEqual(take(await registry.conformance(v.version_id, changed.fingerprints[0], scope.scopeId)), []);
});

test('expiry, test set and evaluator changes prevent reuse; later failure is not hidden by an older pass', async () => {
  const f = fixture(); const v = await f.activate();
  f.clock.value = '2026-10-28T00:00:00.000Z';
  rejected(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  f.clock.value = '2026-10-27T00:00:00.000Z';
  for (const changes of [{ testSetDigest: digestJson('new-suite') }, { evaluatorVersion: 'new-evaluator' }]) {
    const changed = createLanguageRegistry({ ...f.options, scopes: [{ ...criteria, ...changes }] });
    rejected(await changed.selectHead(scope.scopeId, v.version_id, 0));
  }
  await f.certify(record(v.version_id, fingerprints[0], 'fail', '-regression'));
  rejected(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  assert.deepEqual(take(await f.registry.conformance(v.version_id, fingerprints[0], scope.scopeId)).map(r => r.verdict), ['pass', 'fail']);
});

test('concurrent head CAS has one winner and a revision conflict, without implicit retries', async () => {
  const f = fixture(); const first = await f.activate(); const second = await f.activate(language('language-v2', { parent_ids: [first.version_id] }));
  const results = await Promise.all([f.registry.selectHead(scope.scopeId, first.version_id, 0), f.registry.selectHead(scope.scopeId, second.version_id, 0)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  rejected(results.find(r => !r.ok), 'revision_conflict');
  assert.equal(take(await f.registry.head(scope.scopeId)).revision, 1);
});

test('epoch switch fixes versions, closes old sends, retains held deliveries and rejects stale context', async () => {
  const f = fixture(); const v1 = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v1.version_id, 0));
  take(await f.registry.nextEpoch(request()));
  const v2 = await f.activate(language('language-v2', { parent_ids: [v1.version_id] })); take(await f.registry.selectHead(scope.scopeId, v2.version_id, 1));
  f.transition.change = p => ({ ...p, pendingMessageIds: ['message-old'], heldMessageIds: ['message-old'] });
  take(await f.registry.nextEpoch(request(epoch('epoch-2', v2.version_id, 1), 'epoch-1', 1)));
  assert.equal(take(await f.registry.getEpoch('epoch-1')).language.languageVersionId, v1.version_id);
  assert.notEqual(take(await f.registry.getEpoch('epoch-1')).sendsClosedAt, null);
  const old = await f.registry.resolveLanguage({ epochId: 'epoch-1', languageVersionId: v1.version_id, contextRevision: 0, fingerprint: fingerprints[0], digest: v1.digest });
  rejected(old);
  assert.deepEqual(take(await f.registry.resolveLanguage({ epochId: 'epoch-2', languageVersionId: v2.version_id, contextRevision: 1, fingerprint: fingerprints[0], digest: v2.digest })), v2);
  rejected(await f.registry.resolveLanguage({ epochId: 'epoch-2', languageVersionId: v2.version_id, contextRevision: 0, fingerprint: fingerprints[0], digest: v2.digest }));
  const snapshot = take(await f.store.snapshot());
  assert.deepEqual(snapshot.entries.find(e => e.key.collection === 'registry.epoch-closures').value.heldMessageIds, ['message-old']);
});

for (const [name, change] of [
  ['open sends', p => ({ ...p, previousSendsClosed: false })],
  ['unresolved pending delivery', p => ({ ...p, pendingMessageIds: ['message-old'] })],
  ['missing acquisition', p => ({ ...p, acquired: p.acquired.slice(1) })],
  ['wrong package digest', p => { p.acquired[0].digest = digestJson('wrong'); return p; }],
  ['stale inspection', p => ({ ...p, storeRevision: p.storeRevision - 1 })],
]) test(`epoch switch refuses ${name}`, async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.registry.nextEpoch(request())); f.transition.change = change;
  rejected(await f.registry.nextEpoch(request(epoch('epoch-2', v.version_id, 1), 'epoch-1', 1)));
  assert.equal(take(await f.registry.getEpoch('epoch-1')).sendsClosedAt, null);
  assert.equal(take(await f.registry.getEpoch('epoch-2')), null);
});

test('bad revision and missing conformance cannot switch an epoch', async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.registry.nextEpoch(request()));
  rejected(await f.registry.nextEpoch(request(epoch('epoch-2', v.version_id, 1), 'epoch-1', 0)), 'revision_conflict');
  f.clock.value = '2026-10-28T00:00:00.000Z';
  rejected(await f.registry.nextEpoch(request(epoch('epoch-2', v.version_id, 1), 'epoch-1', 1)));
});

test('closed stores and malformed stored versions fail closed', async () => {
  const f = fixture(); await f.register(); await f.store.close();
  rejected(await f.registry.get('language-v1'), 'unavailable');
  const store = createMemoryTaskStore(); const corrupt = fixture(store);
  take(await store.transact({ transactionId: hostIdentity.newId('transaction'), expectedRevision: 0, mutations: [{ kind: 'insert', entry: { key: { collection: 'registry.versions', id: 'language-v1' }, value: { wrong: true } } }], events: [] }));
  rejected(await corrupt.registry.get('language-v1'), 'unavailable');
});
