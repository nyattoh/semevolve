import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { fixture, fingerprints, scope, take, rejected, epoch, request, language } from './fixtures.mjs';

test('language resolution rejects unknown versions, digest mismatch and unqualified participants', async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.registry.nextEpoch(request()));
  const input = { epochId: 'epoch-1', languageVersionId: v.version_id, contextRevision: 0, fingerprint: fingerprints[0], digest: v.digest };
  assert.deepEqual(take(await f.registry.resolveLanguage(input)), v);
  for (const changes of [{ languageVersionId: 'unknown' }, { digest: digestJson('wrong') }, { epochId: 'missing' },
    { fingerprint: { ...fingerprints[0], modelId: 'changed' } }, { fingerprint: { ...fingerprints[0], peerId: 'stranger' } }]) {
    rejected(await f.registry.resolveLanguage({ ...input, ...changes }));
  }
  assert.deepEqual(take(await f.registry.get(v.version_id)), v);
});

test('status replay is idempotent and event ID reuse cannot overwrite history', async () => {
  const f = fixture(); await f.register(); take(await f.status('language-v1', 'CANDIDATE'));
  const event = take(await f.registry.statusEvents('language-v1'))[0];
  const before = take(await f.store.snapshot()); take(await f.registry.appendStatus(event));
  assert.deepEqual(take(await f.store.snapshot()), before);
  rejected(await f.registry.appendStatus({ ...event, reason: 'Changed reason' }), 'id_collision');
  rejected(await f.status('language-v1', 'ACTIVE'));
  assert.deepEqual(take(await f.registry.statusEvents('language-v1')), [event]);
});

test('a readiness-port failure and a concurrent store change cannot partially switch epochs', async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.registry.nextEpoch(request()));
  const inspect = f.options.transitions.inspect;
  f.options.transitions.inspect = async () => { throw new Error('Synthetic failure'); };
  rejected(await f.registry.nextEpoch(request(epoch('epoch-2', v.version_id, 1), 'epoch-1', 1)), 'unavailable');
  assert.equal(take(await f.registry.getEpoch('epoch-2')), null);
  assert.equal(take(await f.registry.getEpoch('epoch-1')).sendsClosedAt, null);
  f.options.transitions.inspect = async (...args) => {
    const ready = await inspect(...args);
    take(await f.registry.register(language('concurrent-version')));
    return ready;
  };
  rejected(await f.registry.nextEpoch(request(epoch('epoch-2', v.version_id, 1), 'epoch-1', 1)), 'revision_conflict');
  assert.equal(take(await f.registry.getEpoch('epoch-2')), null);
  assert.equal(take(await f.registry.getEpoch('epoch-1')).sendsClosedAt, null);
});
