import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = new URL('../../../packages/policy/dist/runtime.js', import.meta.url);
const baseline = readFileSync(file, 'utf8');
const cases = [
  { name: 'repeated invocation grants another start', from: 'if (!reserved.value.created)', to: 'if (false)', pattern: 'same invocation is started once' },
  { name: 'unknown upper bound is admitted', from: "if (upper === null)\n                return refused('unknown_upper_bound');", to: 'if (upper === null) continue;', pattern: 'strict budget rejects unknown' },
  { name: 'missing usage becomes a numeric total', from: "{ kind: 'partial', knownSubtotal, missingInvocationIds: [first, ...rest] }", to: "{ kind: 'complete', total: knownSubtotal }", pattern: 'AT-21 missing usage' },
  { name: 'host permission refusal is ignored', from: 'if (authorisation.allowed !== true || !integer(authorisation.policyRevision))', to: 'if (false)', pattern: 'AT-15/33 allow-list' },
];

for (const mutation of cases) {
  assert.equal(baseline.split(mutation.from).length, 2, `Mutation must have one target: ${mutation.name}`);
  try {
    writeFileSync(file, baseline.replace(mutation.from, mutation.to));
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mutation.pattern}`, 'tests/mechanism/policy/runtime.test.mjs'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, `${mutation.name}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /AssertionError/u);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_MODULE_NOT_EXPORTED/u);
    process.stdout.write(`Detected mutant: ${mutation.name}\n${result.stdout}\n`);
  } finally { writeFileSync(file, baseline); }
}
assert.equal(readFileSync(file, 'utf8'), baseline);
process.stdout.write('All four behavioural mutants were rejected. Build output restored.\n');
