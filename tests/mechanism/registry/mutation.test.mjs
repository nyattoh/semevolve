import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { fixture, fingerprints, record, proof, scope, take, rejected, epoch, request } from './fixtures.mjs';

const root = new URL('../../../packages/language-registry/dist/', import.meta.url);
const registrySource = readFileSync(new URL('registry.js', root), 'utf8');
const inspectionSource = readFileSync(new URL('inspection.js', root), 'utf8');
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const link = source => source.replaceAll("'@semevolve/core'", JSON.stringify(import.meta.resolve('@semevolve/core')))
  .replaceAll("'./validation.js'", JSON.stringify(new URL('validation.js', root).href));
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, `Mutation anchor must occur once: ${before}`);
  return source.replace(before, after);
};

async function mutatedFactory(before, after, inspection = false) {
  const source = inspection ? registrySource : replaceOnce(registrySource, before, after);
  const inspectionUrl = inspection ? uri(link(replaceOnce(inspectionSource, before, after))) : new URL('inspection.js', root).href;
  return (await import(uri(link(source).replace("'./inspection.js'", JSON.stringify(inspectionUrl))))).createLanguageRegistry;
}

test('negative independent-evidence probe kills the independence mutant', async () => {
  const f = fixture(); await f.register(); const r = record(); const p = proof(r); p.independent = false;
  f.proofs.set(digestJson(r), p);
  const probe = async registry => rejected(await registry.recordConformance(r));
  await probe(f.registry);
  const create = await mutatedFactory('value.independent !== true', 'false', true);
  await assert.rejects(() => probe(create(f.options)), { code: 'ERR_ASSERTION' });
});

test('regression probe kills the latest-verdict mutant', async () => {
  const f = fixture(); const v = await f.activate(); await f.certify(record(v.version_id, fingerprints[0], 'fail', '-late'));
  const probe = async registry => rejected(await registry.selectHead(scope.scopeId, v.version_id, 0));
  await probe(f.registry);
  const create = await mutatedFactory("latest.verdict !== 'pass'", 'false');
  await assert.rejects(() => probe(create(f.options)), { code: 'ERR_ASSERTION' });
});

test('head CAS probe kills the expected-revision mutant', async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  const probe = async registry => rejected(await registry.selectHead(scope.scopeId, v.version_id, 0), 'revision_conflict');
  await probe(f.registry);
  const create = await mutatedFactory('actual !== revision', 'false');
  await assert.rejects(() => probe(create(f.options)), { code: 'ERR_ASSERTION' });
});

test('pending-delivery probe kills the unaccounted-delivery mutant', async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.registry.nextEpoch(request()));
  f.transition.change = p => ({ ...p, pendingMessageIds: ['message-pending'] });
  const probe = async registry => rejected(await registry.nextEpoch(request(epoch('epoch-2', v.version_id, 1), 'epoch-1', 1)));
  await probe(f.registry);
  const create = await mutatedFactory('!valid.same([...ready.pendingMessageIds].sort(), [...ready.heldMessageIds].sort())', 'false');
  await assert.rejects(() => probe(create(f.options)), { code: 'ERR_ASSERTION' });
});

test('context probe kills the stale-context mutant', async () => {
  const f = fixture(); const v = await f.activate(); take(await f.registry.selectHead(scope.scopeId, v.version_id, 0));
  take(await f.registry.nextEpoch(request(epoch('epoch-1', v.version_id, 1))));
  const input = { epochId: 'epoch-1', languageVersionId: v.version_id, contextRevision: 0, fingerprint: fingerprints[0], digest: v.digest };
  const probe = async registry => rejected(await registry.resolveLanguage(input));
  await probe(f.registry);
  const create = await mutatedFactory('epoch.contextRevision !== request.contextRevision', 'false');
  await assert.rejects(() => probe(create(f.options)), { code: 'ERR_ASSERTION' });
});
