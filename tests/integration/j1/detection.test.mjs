import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compositionCases } from './composition-cases.mjs';
import { modes, validateCases, runCase, validateCaseResult, summariseMode } from './detection-runner.mjs';

const protectedFiles = ['tests/integration/j1/compose.mjs', 'packages/policy/src/runtime.ts', 'packages/policy/dist/runtime.js', 'tests/integration/j1/composition-cases.mjs'];
async function hashes() {
  return Promise.all(protectedFiles.map(async path => [path, createHash('sha256').update(await readFile(new URL(`../../../${path}`, import.meta.url))).digest('hex')]));
}
const before = await hashes();
let stopped = false;

for (const mode of modes) {
  const results = [];
  for (const c of validateCases(compositionCases)) {
    test(`J1 mechanism detection ${mode} ${c.id}`, { timeout: 30000 }, async t => {
      assert.equal(stopped, false, 'Detection stopped after an unexpected result');
      try {
        const result = await runCase(mode, c.id, { signal: t.signal, progress: event => console.log(JSON.stringify(event)) });
        const validated = validateCaseResult(result);
        results.push(validated);
        t.diagnostic(JSON.stringify({ phase: 'validated', mode, caseId: c.id, pid: result.pid, counts: validated.counts, failed: validated.failed }));
      } catch (error) {
        stopped = true;
        t.diagnostic(JSON.stringify({ phase: 'rejected', mode, caseId: c.id, reason: error.message }));
        throw error;
      }
    });
  }
  test(`J1 mechanism detection ${mode} coverage`, { timeout: 30000 }, async t => {
    assert.equal(stopped, false, 'Detection stopped after an unexpected result');
    try {
      const summary = summariseMode(mode, results);
      assert.deepEqual(await hashes(), before);
      t.diagnostic(JSON.stringify({ kind: 'mechanism_detection', ...summary }));
    } catch (error) {
      stopped = true;
      throw error;
    }
  });
}
