import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compositionCases } from './composition-cases.mjs';
import { expectedCaseIds, expectedCaseNames, validateCases, selectCase, runCase, parseCaseTap, validateCaseResult, summariseMode } from './detection-runner.mjs';

const successful = [];
const detected = new Map();

async function script(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.SEMEVOLVE_J1_MUTANT;
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    const observing = process.env.SEMEVOLVE_J1_DIAGNOSTIC === '1' && args.some(arg => arg.endsWith('composition.test.mjs'));
    const started = performance.now();
    const observe = (event, detail = {}) => {
      if (observing) process.stderr.write(`${JSON.stringify({ kind: 'j1-child-observation', event, at: new Date().toISOString(), parentPid: process.pid, childPid: child.pid, elapsedMs: performance.now() - started, ...detail })}\n`);
    };
    observe('spawn', { timeout: 30000, killSignal: 'SIGKILL' });
    child.stdout.on('data', chunk => { stdout += chunk; observe('stdout', { text: chunk.toString() }); });
    child.stderr.on('data', chunk => { stderr += chunk; observe('stderr', { text: chunk.toString() }); });
    child.on('error', error => { observe('error', { message: error.message }); reject(error); });
    child.on('exit', (code, signal) => observe('exit', { code, signal }));
    child.on('close', (code, signal) => { observe('close', { code, signal }); resolve({ code, signal, stdout, stderr }); });
  });
}

test('J1 partition selected entry registers exactly the requested case', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.SEMEVOLVE_J1_MUTANT;
  delete env.NODE_OPTIONS;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test-reporter=tap', fileURLToPath(new URL('./composition-case.mjs', import.meta.url)), 'J1-01'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(Number(result.stdout.match(/^# tests (\d+)$/mu)?.[1]), 1, 'Selected entry must register one real case');
  assert.deepEqual([...result.stdout.matchAll(/^ok \d+ - (.+)$/gmu)].map(match => match[1]), ['J1-01 real-port helper persists provider output as applied state']);
  successful.push(validateCaseResult({ ...result, mode: 'baseline', caseId: 'J1-01', closed: true, reason: null, spawnError: null }));
});

for (const caseId of expectedCaseIds.slice(1)) {
  test(`J1 partition selected entry executes ${caseId} alone`, { timeout: 30000 }, async () => {
    successful.push(validateCaseResult(await runCase('baseline', caseId)));
  });
}

test('J1 partition definitions import without registering or executing tests', { timeout: 30000 }, async () => {
  const url = new URL('./composition-cases.mjs', import.meta.url).href;
  const result = await script(['--input-type=module', '-e', `const {compositionCases} = await import(${JSON.stringify(url)}); console.log(JSON.stringify(compositionCases.map(c => c.id)));`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), JSON.stringify(expectedCaseIds));
});

test('J1 partition normal entry always executes all twelve cases', { timeout: 30000 }, async () => {
  const result = await script(['--test-reporter=tap', fileURLToPath(new URL('./composition.test.mjs', import.meta.url)), 'J1-01']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual([...result.stdout.matchAll(/^ok \d+ - (.+)$/gmu)].map(m => m[1]), expectedCaseNames);
  assert.match(result.stdout, /# tests 12\n# suites 0\n# pass 12\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n/u);
});

for (const args of [[], ['J1-00'], ['J1-13'], ['J1-01', 'J1-02']]) {
  test(`J1 partition selection rejects arguments ${JSON.stringify(args)}`, { timeout: 30000 }, async () => {
    assert.throws(() => selectCase(compositionCases, args));
    const result = await script(['--test-reporter=tap', fileURLToPath(new URL('./composition-case.mjs', import.meta.url)), ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.doesNotMatch(result.stdout, /^# Subtest:/mu);
    assert.match(result.stderr, /Exactly one case ID is required|Unknown composition case ID/u);
  });
}

const invalidCases = {
  missing: cases => cases.slice(1),
  duplicate: cases => [cases[0], ...cases.slice(0, -1)],
  unknown: cases => [{ ...cases[0], id: 'J1-13' }, ...cases.slice(1)],
  extra: cases => [...cases, cases[0]],
  name: cases => [{ ...cases[0], name: expectedCaseNames[1] }, ...cases.slice(1)],
  timeout: cases => [{ ...cases[0], options: { timeout: 30001 } }, ...cases.slice(1)],
};
for (const [name, change] of Object.entries(invalidCases)) {
  test(`J1 partition definition set rejects ${name}`, { timeout: 30000 }, () => {
    assert.throws(() => validateCases(change(compositionCases)));
  });
}

for (const [mode, caseId] of [['registry', 'J1-04'], ['registry', 'J1-06'], ['policy', 'J1-07'], ['replay', 'J1-02'], ['replay', 'J1-10']]) {
  test(`J1 partition real assertion result ${mode} ${caseId}`, { timeout: 30000 }, async () => {
    const result = validateCaseResult(await runCase(mode, caseId));
    assert.deepEqual(result.counts, { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
    detected.set(`${mode}/${caseId}`, result);
  });
}

const malformedTap = {
  'missing tests summary': s => s.replace('# tests 1\n', ''),
  'duplicate summary': s => s.replace('# pass 1\n', '# pass 1\n# pass 1\n'),
  'zero tests': s => s.replace('# tests 1\n', '# tests 0\n'),
  'extra result': s => s.replace('1..1\n', `ok 2 - ${expectedCaseNames[1]}\n1..2\n`),
  skip: s => s.replace('# skipped 0\n', '# skipped 1\n'),
  todo: s => s.replace('# todo 0\n', '# todo 1\n'),
  cancelled: s => s.replace('# cancelled 0\n', '# cancelled 1\n'),
  'skip directive': s => s.replace(`ok 1 - ${expectedCaseNames[0]}\n`, `ok 1 - ${expectedCaseNames[0]} # SKIP\n`),
  'wrong subtest name': s => s.replace(`# Subtest: ${expectedCaseNames[0]}`, `# Subtest: ${expectedCaseNames[1]}`),
  'wrong result name': s => s.replace(`ok 1 - ${expectedCaseNames[0]}`, `ok 1 - ${expectedCaseNames[1]}`),
  'wrong plan': s => s.replace('1..1\n', '1..2\n'),
  'duplicate plan': s => s.replace('1..1\n', '1..1\n1..1\n'),
  'incomplete output': s => s.slice(0, s.indexOf('# duration_ms')),
  'result count mismatch': s => s.replace('ok 1 - ', 'not ok 1 - '),
  'missing block end': s => s.replace('  ...\n', ''),
};
for (const key of ['pass', 'fail', 'cancelled', 'skipped', 'todo']) malformedTap[`missing ${key} summary`] = s => s.replace(new RegExp(`# ${key} \\d+\\n`, 'u'), '');
for (const [name, change] of Object.entries(malformedTap)) {
  test(`J1 partition parser rejects processed real TAP ${name}`, { timeout: 30000 }, () => {
    assert.ok(successful[0]);
    assert.throws(() => parseCaseTap(change(successful[0].stdout), 'J1-01'));
  });
}

const invalidResult = {
  'exit two': r => ({ ...r, code: 2 }),
  signal: r => ({ ...r, signal: 'SIGKILL' }),
  timeout: r => ({ ...r, reason: 'child_timeout' }),
  abort: r => ({ ...r, reason: 'parent_abort' }),
  'close unconfirmed': r => ({ ...r, closed: false }),
  'marker missing': r => ({ ...r, stderr: '' }),
  'marker duplicated': r => ({ ...r, stderr: r.stderr + r.stderr }),
  'marker wrong': r => ({ ...r, stderr: r.stderr.replace('registry', 'policy') }),
  'wrong assertion': r => ({ ...r, stdout: r.stdout.replace('ERR_ASSERTION', 'ERR_MODULE_NOT_FOUND') }),
  'wrong message': r => ({ ...r, stdout: r.stdout.replace('quarantine language must refuse reception', 'different failure') }),
  'wrong actual value': r => ({ ...r, stdout: r.stdout.replace('actual: true', 'actual: false') }),
  'anchor failure': r => ({ ...r, stdout: '', stderr: 'J1 mutant requires exactly one anchor', code: 1 }),
  'import failure': r => ({ ...r, stdout: '', stderr: 'ERR_MODULE_NOT_FOUND', code: 1 }),
};
for (const [name, change] of Object.entries(invalidResult)) {
  test(`J1 partition validator rejects processed real assertion ${name}`, { timeout: 30000 }, () => {
    const result = detected.get('registry/J1-04');
    assert.ok(result);
    assert.throws(() => validateCaseResult(change(result)));
  });
}

test('J1 partition mode sums observed children and rejects missing duplicate unknown or unvalidated results', { timeout: 30000 }, () => {
  assert.deepEqual(summariseMode('baseline', successful).counts, { tests: 12, pass: 12, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  for (const results of [successful.slice(1), [successful[0], ...successful.slice(0, -1)], [...successful, successful[0]], [{ ...successful[0], caseId: 'J1-13' }, ...successful.slice(1)], [{ ...successful[0], validated: false }, ...successful.slice(1)], [{ ...successful[0], mode: 'restored' }, ...successful.slice(1)]]) {
    assert.throws(() => summariseMode('baseline', results));
  }
});
