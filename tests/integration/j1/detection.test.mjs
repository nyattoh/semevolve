import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const composition = fileURLToPath(new URL('./composition.test.mjs', import.meta.url));
const register = new URL('./mutant-register.mjs', import.meta.url).href;
const protectedFiles = ['tests/integration/j1/compose.mjs', 'packages/policy/src/runtime.ts', 'packages/policy/dist/runtime.js'];
async function hashes() {
  return Promise.all(protectedFiles.map(async path => [path, createHash('sha256').update(await readFile(new URL(`../../../${path}`, import.meta.url))).digest('hex')]));
}
function run(mutant) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.SEMEVOLVE_J1_MUTANT;
    if (mutant) env.SEMEVOLVE_J1_MUTANT = mutant;
    const args = [...(mutant ? ['--import', register] : []), '--test', '--test-reporter=tap', composition];
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('J1 mechanism detection distinguishes baseline, three assertion failures and restored baseline', { timeout: 30000 }, async t => {
  const before = await hashes();
  const baseline = await run();
  assert.equal(baseline.code, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /# pass 12\b/u);
  assert.match(baseline.stdout, /# skipped 0\b/u);
  for (const [mutant, target] of [['registry', 'J1-04'], ['policy', 'J1-07'], ['replay', 'J1-02']]) {
    const result = await run(mutant);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stderr + result.stdout, new RegExp(`\\[j1-mutant:${mutant}:injected-once\\]`, 'u'));
    const failure = result.stdout.match(new RegExp(`not ok \\d+ - ${target}[^]*?\\n  \\.\\.\\.`, 'u'))?.[0];
    assert.equal(typeof failure, 'string', result.stdout);
    assert.match(failure, /code: 'ERR_ASSERTION'/u);
    assert.match(result.stdout, /# tests 12\b/u);
    assert.match(result.stdout, /# skipped 0\b/u);
    assert.match(result.stdout, /# todo 0\b/u);
    if (mutant === 'registry') assert.match(failure, /quarantine language must refuse reception/u);
    if (mutant === 'replay') {
      assert.match(failure, /Replay must suppress a second real fixed-fake invocation/u);
      assert.match(failure, /expected: 1\s+actual: 2/u);
    }
    assert.deepEqual(await hashes(), before);
    t.diagnostic(JSON.stringify({ kind: 'mechanism_detection', mutant, target, exit: result.code, signal: result.signal, assertion: 'ERR_ASSERTION' }));
  }
  const restored = await run();
  assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /# pass 12\b/u);
  assert.deepEqual(await hashes(), before);
});
