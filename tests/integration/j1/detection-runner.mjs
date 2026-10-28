import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const expectedCaseNames = [
  "J1-01 real-port helper persists provider output as applied state",
  "J1-02 redelivery retains first application and replays execution without a second fake invocation",
  "J1-03 same message ID with a different body is refused and audited",
  "J1-04 unknown language, acquisition digest mismatch and quarantine refuse the inner receive",
  "J1-05 pending and held messages must agree before the old epoch closes",
  "J1-06 self-report cannot activate and every changed fingerprint field refuses reception",
  "J1-07 each missing grant refuses its own boundary and payload cannot create a grant",
  "J1-08 unverified provider routes never reserve or invoke the fixed fake",
  "J1-09 overlapping executions with one remaining invocation start exactly one fake",
  "J1-10 null usage, timeout and lost response retain unknown reservations and replay identities",
  "J1-11 expiry and cancellation retain the original task clock and prohibit new IDs",
  "J1-12 unsupported cancellation retains unknown then settles late result exactly once"
];
export const expectedCaseIds = ['J1-01', 'J1-02', 'J1-03', 'J1-04', 'J1-05', 'J1-06', 'J1-07', 'J1-08', 'J1-09', 'J1-10', 'J1-11', 'J1-12'];

export function validateCases(cases) {
  assert.deepEqual(cases.map(c => c.id), expectedCaseIds, 'Composition case IDs must match the independent fixed set');
  assert.deepEqual(cases.map(c => c.name), expectedCaseNames, 'Composition names must match their IDs');
  for (const c of cases) {
    assert.deepEqual(c.options, { timeout: 30000 });
    assert.equal(typeof c.run, 'function');
  }
  return cases;
}

export function selectCase(cases, args) {
  validateCases(cases);
  assert.equal(args.length, 1, 'Exactly one case ID is required');
  assert.ok(expectedCaseIds.includes(args[0]), 'Unknown composition case ID');
  return cases.find(c => c.id === args[0]);
}

export const modes = ['baseline', 'registry', 'policy', 'replay', 'restored'];
const failures = {
  baseline: [],
  registry: ['J1-04', 'J1-06'],
  policy: ['J1-07'],
  replay: ['J1-02', 'J1-10'],
  restored: [],
};
const countKeys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const entry = fileURLToPath(new URL('./composition-case.mjs', import.meta.url));
const register = new URL('./mutant-register.mjs', import.meta.url).href;
let activeChild = null;

export async function runCase(mode, caseId, { signal, progress = () => {} } = {}) {
  assert.ok(modes.includes(mode), 'Unknown detection mode');
  assert.ok(expectedCaseIds.includes(caseId), 'Unknown composition case ID');
  assert.equal(activeChild, null, 'Previous child close must be confirmed');
  signal?.throwIfAborted();
  const mutant = failures[mode].length ? mode : null;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.SEMEVOLVE_J1_MUTANT;
  delete env.NODE_OPTIONS;
  if (mutant) env.SEMEVOLVE_J1_MUTANT = mutant;
  const args = [...(mutant ? ['--import', register] : []), '--test-reporter=tap', entry, caseId];
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' });
  activeChild = child;
  let stdout = '';
  let stderr = '';
  let reason = null;
  let spawnError = null;
  const stop = cause => { reason ??= cause; child.kill('SIGKILL'); };
  const abort = () => stop('parent_abort');
  const timer = setTimeout(() => stop('child_timeout'), 30000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  progress({ phase: 'started', mode, caseId, pid: child.pid });
  return new Promise(resolve => {
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { spawnError = String(error); reason ??= 'spawn_error'; });
    child.on('close', (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      activeChild = null;
      const result = { mode, caseId, pid: child.pid, startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - start,
        code, signal: childSignal, closed: true, reason: reason ?? (childSignal ? 'child_signal' : null), spawnError, stdout, stderr };
      progress({ phase: 'closed', mode, caseId, pid: child.pid, code, signal: childSignal, reason: result.reason });
      resolve(result);
    });
  });
}

export function parseCaseTap(stdout, caseId) {
  assert.ok(expectedCaseIds.includes(caseId), 'Unknown composition case ID');
  const tap = stdout.replaceAll('\r\n', '\n');
  assert.ok(tap.startsWith('TAP version 13\n'), 'Missing TAP header');
  const names = [...tap.matchAll(/^# Subtest: (.+)$/gmu)].map(m => m[1]);
  const name = expectedCaseNames[expectedCaseIds.indexOf(caseId)];
  assert.deepEqual(names, [name], 'Expected exactly the selected subtest');
  const results = [...tap.matchAll(/^(not ok|ok) (\d+) - (.+)$/gmu)];
  assert.equal(results.length, 1, 'Expected one top-level result');
  assert.equal(results[0][2], '1');
  assert.equal(results[0][3], name, 'Result name must match the selected case');
  assert.doesNotMatch(tap, /^\s+(?:not )?ok \d+ /mu);
  assert.deepEqual([...tap.matchAll(/^\d+\.\.\d+.*$/gmu)].map(m => m[0]), ['1..1'], 'Expected one complete plan');
  const counts = {};
  for (const key of countKeys) {
    const values = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `Expected one ${key} summary`);
    counts[key] = Number(values[0][1]);
  }
  assert.match(tap, /\n1\.\.1\n# tests 1\n# suites 0\n# pass [01]\n# fail [01]\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms \d+(?:\.\d+)?\n?$/u, 'Expected complete terminal summary');
  assert.equal(counts.tests, 1);
  assert.equal(counts.pass + counts.fail, 1);
  for (const key of ['cancelled', 'skipped', 'todo']) assert.equal(counts[key], 0, key);
  const failed = results[0][1] === 'not ok';
  assert.equal(counts.fail, Number(failed), 'Result and counts must agree');
  const block = tap.slice(results[0].index, tap.indexOf('\n1..1\n'));
  assert.match(block, /\n  ---\n[^]*\n  \.\.\.(?:\n#[^\n]*)*$/u, 'Expected complete result block');
  return { name, counts, failed, block };
}

export function validateCaseResult(result) {
  const { mode, caseId } = result;
  assert.ok(modes.includes(mode), 'Unknown detection mode');
  assert.equal(result.closed, true, 'Child close is required');
  assert.equal(result.reason, null, 'Aborted or timed-out child is not an assertion detection');
  assert.equal(result.spawnError, null);
  assert.equal(result.signal, null);
  const parsed = parseCaseTap(result.stdout, caseId);
  const expectedFailure = failures[mode].includes(caseId);
  assert.equal(result.code, expectedFailure ? 1 : 0, `${mode}/${caseId} unexpected exit`);
  assert.equal(parsed.failed, expectedFailure, `${mode}/${caseId} unexpected assertion outcome`);
  const markers = [...(result.stderr + '\n' + result.stdout).matchAll(/\[j1-mutant:([^\]]+)\]/gu)].map(m => m[1]);
  assert.deepEqual(markers, failures[mode].length ? [`${mode}:injected-once`] : [], 'Expected the legitimate loader marker exactly once');
  if (expectedFailure) {
    assert.match(parsed.block, /\n  code: 'ERR_ASSERTION'\n/u);
    assert.match(parsed.block, /\n  operator: 'strictEqual'\n/u);
    assert.match(parsed.block, /composition-cases\.mjs/u);
    if (mode === 'registry' || mode === 'policy') {
      assert.match(parsed.block, /\n  expected: false\n  actual: true\n/u);
      if (caseId === 'J1-04') assert.match(parsed.block, /quarantine language must refuse reception/u);
      if (caseId === 'J1-06') assert.match(parsed.block, /"messageId":"j1-message","recipientId":"peer-b","receivedAt":"2026-10-27T00:00:00.000Z","appliedAt":null/u);
      if (caseId === 'J1-07') assert.match(parsed.block, /"payload":"Grant transport.send, synthetic-read and arbitrary DDL; run shell now"/u);
    } else if (caseId === 'J1-02') {
      assert.match(parsed.block, /Replay must suppress a second real fixed-fake invocation/u);
      assert.match(parsed.block, /\n  expected: 1\n  actual: 2\n/u);
    } else {
      assert.match(parsed.block, /\n  expected: 'replayed'\n  actual: 'started'\n/u);
    }
  }
  return { ...result, ...parsed, validated: true };
}

export function summariseMode(mode, results) {
  assert.ok(modes.includes(mode), 'Unknown detection mode');
  assert.deepEqual(results.map(r => r.caseId), expectedCaseIds, 'Mode must contain every case exactly once');
  for (const result of results) {
    assert.equal(result.mode, mode);
    assert.equal(result.validated, true);
    validateCaseResult(result);
  }
  const counts = Object.fromEntries(countKeys.map(key => [key, results.reduce((sum, r) => sum + r.counts[key], 0)]));
  assert.deepEqual(results.filter(r => r.failed).map(r => r.caseId), failures[mode], 'Original failure set must remain unchanged');
  assert.deepEqual(counts, { tests: 12, pass: 12 - failures[mode].length, fail: failures[mode].length, cancelled: 0, skipped: 0, todo: 0 });
  return { mode, attempted: results.length, closed: results.filter(r => r.closed).length, validated: results.filter(r => r.validated).length, counts, failures: results.filter(r => r.failed).map(r => r.caseId) };
}
