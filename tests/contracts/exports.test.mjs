import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('all package exports satisfy the TypeScript consumer contract', () => {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tests/contracts/tsconfig.json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('all ten ESM workspaces load through package exports and hide their internals', async () => {
  const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(root.workspaces.length, 10);
  for (const path of root.workspaces) {
    const manifest = JSON.parse(readFileSync(new URL(`../../${path}/package.json`, import.meta.url), 'utf8'));
    const module = await import(manifest.name);
    assert.equal(typeof module, 'object');
    await assert.rejects(import(`${manifest.name}/src/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
