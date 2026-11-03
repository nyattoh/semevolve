import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const targets = [
  ['negation', 'L6 negation loss cannot certify a combination', 'L6_NEGATION'],
  ['unverified', 'L6 unverified combinations cannot store', 'L6_UNVERIFIED'],
  ['cas', 'L6 stale expected revision cannot switch', 'L6_CAS'],
  ['pending', 'L6 unreceipted intent remains pending', 'L6_PENDING'],
  ['restore', 'L6 restoration retains post-switch writes', 'L6_RESTORE'],
];
for (const [id, name, marker] of targets) for (const mode of ['baseline', 'mutant', 'restored']) test(`L6 ${id} ${mode}`, { timeout: 30000 }, async t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.SEMEVOLVE_STORAGE_MUTANT;
  if (mode === 'mutant') env.SEMEVOLVE_STORAGE_MUTANT = id;
  const child = spawn(process.execPath, [...(mode === 'mutant' ? ['--import', new URL('./mutant-register.mjs', import.meta.url).href] : []), '--test-reporter=tap', fileURLToPath(new URL('./detection-case.mjs', import.meta.url)), id], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' });
  let stdout = '', stderr = '', error = null;
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; }); child.on('error', e => { error = String(e); });
  t.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  const [code, signal] = await new Promise(resolve => child.on('close', (c, s) => resolve([c, s])));
  const tap = stdout.replaceAll('\r\n', '\n'); const fail = mode === 'mutant';
  t.diagnostic(JSON.stringify({ id, mode, pid: child.pid, code, signal, error, stdout: tap, stderr }));
  assert.equal(error, null); assert.equal(signal, null); assert.equal(code, fail ? 1 : 0);
  assert.deepEqual([...tap.matchAll(/^# Subtest: (.+)$/gmu)].map(m => m[1]), [name]);
  assert.deepEqual([...tap.matchAll(/^(?:not )?ok \d+ - (.+)$/gmu)].map(m => m[1]), [name]);
  assert.deepEqual([...tap.matchAll(/^\d+\.\.\d+$/gmu)].map(m => m[0]), ['1..1']);
  for (const [key, expected] of Object.entries({ tests: 1, pass: fail ? 0 : 1, fail: fail ? 1 : 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const counts = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gmu'))]; assert.equal(counts.length, 1); assert.equal(Number(counts[0][1]), expected, key);
  }
  const markers = [...(stderr + stdout).matchAll(/\[storage-mutant:([^\]]+)\]/gu)].map(m => m[1]);
  assert.deepEqual(markers, fail ? [`${id}:injected-once`] : []);
  if (fail) { assert.match(tap, /code: 'ERR_ASSERTION'/u); assert.match(tap, /failureType: 'testCodeFailure'/u); assert.match(tap, /operator: 'strictEqual'/u); assert.ok(tap.includes(marker)); assert.match(tap, /detection-cases\.mjs/u); }
});
