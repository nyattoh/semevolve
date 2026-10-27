import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cases = [
  ['collision', 'conformance.test.mjs', 'same ID with different content'],
  ['duplicate', 'conformance.test.mjs', 'concurrent duplicates'],
  ['acknowledgement', 'local.test.mjs', 'acknowledges only its recipient'],
];
for (const [mutant, file, name] of cases) {
  test(`counterexample detects the ${mutant} mutant by assertion`, () => {
    const env = { ...process.env, SEMEVOLVE_TRANSPORT_MUTANT: mutant };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--import', new URL('./mutant-register.mjs', import.meta.url).href,
      '--test', '--test-reporter=tap', `--test-name-pattern=${name}`, fileURLToPath(new URL(file, import.meta.url)),
    ], { encoding: 'utf8', timeout: 15000, env });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /ERR_ASSERTION/u);
    assert.doesNotMatch(result.stdout + result.stderr, /Mutation target not found|ERR_MODULE_NOT_FOUND|SyntaxError/u);
    assert.match(result.stdout, /# fail 1/u);
  });
}
