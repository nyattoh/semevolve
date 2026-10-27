import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openFileTaskStore } from '@semevolve/core';
import { createLanguageRegistry, registryMutableCollections } from '@semevolve/language-registry';
import { fixture, language, scope, take, rejected } from '../../mechanism/registry/fixtures.mjs';

const directory = () => mkdtempSync(join(tmpdir(), 'semevolve-registry-test-'));

test('a new process reads identical versions, head, epochs and conformance history', () => {
  const path = directory();
  const run = mode => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./process.mjs', import.meta.url)), mode, path], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  const seed = run('seed');
  const restored = run('read');
  assert.notEqual(seed.pid, restored.pid);
  assert.deepEqual({ ...restored, pid: seed.pid }, seed);
});

test('two registry clients overlap durable head CAS with exactly one winner', async () => {
  const path = directory();
  const store = await openFileTaskStore(path, { mutableCollections: registryMutableCollections });
  const f = fixture(store); const v1 = await f.activate(); const v2 = await f.activate(language('language-v2'));
  const other = createLanguageRegistry(f.options);
  const results = await Promise.all([f.registry.selectHead(scope.scopeId, v1.version_id, 0), other.selectHead(scope.scopeId, v2.version_id, 0)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  rejected(results.find(r => !r.ok), 'revision_conflict');
  const winner = results.find(r => r.ok).value;
  await store.close();
  const reopened = await openFileTaskStore(path, { mutableCollections: registryMutableCollections });
  assert.deepEqual(take(await fixture(reopened).registry.head(scope.scopeId)), winner);
  await reopened.close();
});

test('a lost commit response stays unavailable until explicit reopen and reconciliation', async () => {
  const path = directory();
  const store = await openFileTaskStore(path, { mutableCollections: registryMutableCollections,
    async onBoundary(boundary) { if (boundary === 'journal_committed') throw new Error('Synthetic response loss'); } });
  const f = fixture(store); const version = language();
  rejected(await f.registry.register(version), 'unavailable');
  rejected(await f.registry.get(version.version_id), 'unavailable');
  await store.close();
  const reopened = await openFileTaskStore(path, { mutableCollections: registryMutableCollections });
  const registry = fixture(reopened).registry;
  assert.deepEqual(take(await registry.get(version.version_id)), version);
  assert.deepEqual(take(await registry.register(version)), version);
  await reopened.close();
});
