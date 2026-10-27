import assert from 'node:assert/strict';
import test from 'node:test';
import * as registryModule from '@semevolve/language-registry';
import { createMemoryTaskStore, digestJson } from '@semevolve/core';

test('register preserves an arbitrary language and makes identical registration idempotent', async () => {
  assert.equal(typeof registryModule.createLanguageRegistry, 'function', 'LanguageRegistry implementation is missing');
  const store = createMemoryTaskStore({ mutableCollections: ['registry.heads', 'registry.task-epochs'] });
  const scope = { scopeId: 'synthetic-scope', purpose: 'public mechanism fixture', taskRange: 'synthetic tasks', participantIds: ['peer-a'] };
  const fingerprint = { peerId: 'peer-a', provider: 'synthetic', modelId: 'fake-1', cliVersion: 'fake-cli-1', settingsDigest: digestJson({}), introductionDigest: digestJson('introduction') };
  const registry = registryModule.createLanguageRegistry({ store, scopes: [{ scope, fingerprints: [fingerprint], testSetDigest: digestJson('public-suite'), evaluatorVersion: 'fixed-1' }], inspection: { async readConformance() { return { ok: true, value: null }; } }, transitions: { async inspect() { return { ok: false, error: { code: 'unavailable', reason: 'No transition evidence' } }; } } });
  const content = { parent_ids: [], scope, specification_text: '任意の関係・否定・条件。固定SVOではない。', public_examples: [], change_reason: 'initial public synthetic fixture', compatibility_claims: ['unverified'] };
  const version = { ...content, version_id: 'language-v1', digest: digestJson(content) };
  assert.deepEqual(await registry.register(version), { ok: true, value: version });
  const before = await store.snapshot();
  assert.deepEqual(await registry.register(version), { ok: true, value: version });
  assert.deepEqual(await store.snapshot(), before);
  assert.deepEqual(await registry.get('language-v1'), { ok: true, value: version });
  await store.close();
});
