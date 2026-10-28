import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectFileStoreOwner, recoverFileStoreOwner } from '@semevolve/core';
import { input } from './support/fixture.mjs';
import { sdkOptions } from './support/sdk-fixture.mjs';

function launch(t, descriptor, point) {
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'RUNNER_TEMP', 'SEMEVOLVE_TOMBO_RUNTIME', 'SEMEVOLVE_E_EVIDENCE_ROOT']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = fork(new URL('./support/real-process.mjs', import.meta.url), [descriptor, point], { execPath: process.execPath, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 30000 });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const exited = once(child, 'exit');
  const message = new Promise(resolve => child.once('message', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  return { child, exited, message: Promise.race([message, exited.then(([code, signal]) => { throw new Error(`SDK child exited before evidence ${code}/${signal}: ${stderr}`); })]) };
}

for (const point of ['pending_committed', 'sdk_updated', 'result_committed']) test(`AT20 real SDK restart after ${point}`, { timeout: 30000 }, async t => {
  const sdk = await sdkOptions();
  const directory = await mkdtemp(join(sdk.options.allowedTaskRoot, 'semevolve-e-sdk-restart-'));
  const descriptorPath = join(directory, 'descriptor.json');
  await writeFile(descriptorPath, JSON.stringify({ directory, sdk: { taskDirectory: sdk.taskDirectory, startedAt: sdk.startedAt }, input: input() }), { flag: 'wx' });
  const first = launch(t, descriptorPath, point);
  const reached = await first.message;
  assert.equal(reached.kind, 'boundary');
  assert.equal(reached.point, point);
  assert.equal(reached.pid, first.child.pid);
  assert.equal(reached.snapshot.entries.filter(e => e.key.collection === 'tombo.pending').length, 1);
  const appDirectory = join(directory, 'app-store');
  const owner = inspectFileStoreOwner(appDirectory);
  assert.equal(owner.token, reached.owner.token);
  first.child.kill('SIGKILL');
  const [code, signal] = await first.exited;
  assert.ok(code !== 0 || signal !== null);
  recoverFileStoreOwner(appDirectory, owner.token);
  const second = launch(t, descriptorPath, 'resume');
  const complete = await second.message;
  assert.equal(complete.kind, 'complete');
  assert.notEqual(complete.pid, reached.pid);
  assert.equal(complete.result.kind, 'reconciled');
  assert.equal(complete.sdkState.session.binding.sessionId, reached.sdkState.session.binding.sessionId);
  assert.equal(complete.sdkState.state.startedAt, reached.sdkState.state.startedAt);
  assert.equal(complete.sdkState.state.appliedExecutions.length, 1);
  assert.equal(complete.sdkState.state.usage.toolCalls, 1);
  assert.equal(complete.sdkState.state.usage.costYen, null);
  assert.equal(complete.sdkState.session.pendingUpdates.length, 0);
  assert.equal(complete.snapshot.entries.filter(e => e.key.collection === 'tombo.reconciliation-results').length, 1);
  const [exit, exitSignal] = await second.exited;
  assert.equal(exit, 0); assert.equal(exitSignal, null);
  await writeFile(join(directory, 'restart-evidence.json'), JSON.stringify({ point, killed: { code, signal, pid: reached.pid }, restartedPid: complete.pid, before: reached, after: complete }, null, 2), { flag: 'wx' });
  t.diagnostic(JSON.stringify({ point, killedPid: reached.pid, restartedPid: complete.pid, code, signal, sdkRevision: complete.sdkState.state.revision, modelCalls: complete.sdkState.state.usage.modelCalls, snapshotDigest: complete.snapshot.digest }));
});
