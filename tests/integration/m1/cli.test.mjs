import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setup, manifest, event, value, request, understanding, permit, resultMessage } from './helpers.mjs';

function cli(f, command, input, worker = false) {
  const path = join(dirname(f.prepared.authorityPath), 'synthetic-cli-input.json');
  writeFileSync(path, JSON.stringify(input));
  const child = spawnSync(process.execPath, [resolve('apps/cli/dist/hub-m1-cli.js'), command, '--authority', f.options[0].authorityPath, '--context', f.options[worker ? 1 : 0].contextPath, '--input', path], { encoding: 'utf8', env: { ...process.env, PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH } });
  assert.equal(child.error, undefined);
  return { status: child.status, result: JSON.parse(child.stdout), stderr: child.stderr };
}

test('C9 child CLI captures, refuses premature disclosure, reopens snapshots and keeps worker private', t => {
  const f = setup(t);
  let r = cli(f, 'capture', manifest());
  assert.equal(r.status, 0);
  assert.equal(r.result.value.id, 'task-manifest');
  r = cli(f, 'capture', event('disclosure', 'early', { understandingId: 'absent', purpose: 'execution_or_correction', privateAnswerIncluded: false }));
  assert.equal(r.status, 2);
  assert.equal(r.result.error.code, 'm1_order_violation');
  request(f); understanding(f); permit(f); resultMessage(f);
  value(f.sender.captureM1(event('outcome', 'outcome', { status: 'success', resultId: 'result-event', evaluatorId: 'synthetic-operator', rubricHash: 'b'.repeat(64), literal: { expected: { answer: 5 }, observed: { answer: 4 }, evidenceRef: 'synthetic-result' }, intentChecks: [], stopReason: null })));
  r = cli(f, 'capture', { kind: 'close', id: 'closed', manifestId: 'task-manifest', sourceRef: 'synthetic-close' });
  assert.equal(r.status, 0);
  assert.equal(r.result.value.report.outcome.status, 'failure');
  const reopened = cli(f, 'report', { manifestId: 'task-manifest', snapshotId: 'closed' });
  assert.equal(reopened.status, 0);
  assert.deepEqual(reopened.result.value, r.result.value);
  assert.equal(reopened.result.value.report.missingObservations.some(m => m.id === 'request-input'), true);
  assert.equal(cli(f, 'report', { manifestId: 'task-manifest' }, true).result.error.code, 'unauthorised');
});

test('C7 actual CLI RSS samples have PID, process/window/Node source and are not silently persisted', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  const r = cli(f, 'report', { manifestId: 'task-manifest' });
  assert.equal(r.status, 0);
  const memory = r.result.localMemoryRaw;
  assert.equal(memory.target, 'm1-cli');
  assert.equal(memory.nodeVersion, process.version);
  assert.equal(memory.samplingScheme, 'operation-boundaries');
  assert.equal(memory.samplingIntervalMs, null);
  assert.equal(memory.parentIncluded, false);
  assert.equal(memory.childrenIncluded, false);
  assert.deepEqual(memory.samples.map(s => s.boundary), ['before-open', 'after-open', 'after-operation', 'before-close', 'after-close']);
  assert.equal(memory.samples.every(s => Number.isSafeInteger(s.rssBytes) && s.rssBytes > 0 && s.heapUsedBytes > 0), true);
  assert.equal(Number.isSafeInteger(memory.pid) && memory.pid !== process.pid, true);
  assert.equal(r.result.value.localMemory.sampleCount, 0);
  const { sourceRef, ...data } = memory;
  value(f.sender.captureM1(event('memory', 'raw-import', data, { sourceRef })));
  assert.equal(cli(f, 'report', { manifestId: 'task-manifest' }).result.value.localMemory.sampleCount, 5);
});

test('C9 malformed arguments and files return JSON exit 2', () => {
  const child = spawnSync(process.execPath, [resolve('apps/cli/dist/hub-m1-cli.js'), 'capture', '--input', 'relative'], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).error.code, 'invalid_input');
});
