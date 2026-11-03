import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTaskStore } from '@semevolve/core';
import { createTomboBridge, inspectionSteps } from '@semevolve/tombo-bridge';
import { input, value } from './support/fixture.mjs';
import { prepareFixedSdk } from './support/prepare-sdk.mjs';
import { sdkOptions } from './support/sdk-fixture.mjs';

async function ensureNpm() {
  const current = process.env.npm_execpath;
  if (current) {
    const version = spawnSync(process.execPath, [current, '--version'], { encoding: 'utf8' });
    if (version.status === 0 && version.stdout.trim() === '10.9.4') return;
  }
  const area = await mkdtemp(join(tmpdir(), 'semevolve-npm-'));
  const archive = join(area, 'npm.tgz');
  const response = await fetch('https://registry.npmjs.org/npm/-/npm-10.9.4.tgz');
  assert.equal(response.ok, true, `npm 10.9.4 HTTP ${response.status}`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', area], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  process.env.npm_execpath = join(area, 'package/bin/npm-cli.js');
}

const runtimeReady = (async () => {
  await ensureNpm();
  const runtime = await prepareFixedSdk();
  process.env.SEMEVOLVE_TOMBO_RUNTIME = runtime;
  return runtime;
})();

function crashOnce(step) {
  let pending = true;
  return async at => {
    if (pending && at === step) {
      pending = false;
      throw new Error(`crash after ${step}`);
    }
  };
}
async function commands(directory) {
  const rows = [];
  for (const name of await readdir(join(directory, 'command-evidence'))) rows.push(JSON.parse(await readFile(join(directory, 'command-evidence', name), 'utf8')));
  return rows;
}
const count = (rows, name) => rows.filter(row => row.command[2] === name).length;
const names = rows => rows.map(row => row.command[2]);

for (const step of ['activated', 'prepared', 'inspected']) test(`real managed session does not bind a partial inspection after ${step}`, { timeout: 180000 }, async () => {
  await runtimeReady;
  const sdk = await sdkOptions({ fault: crashOnce(step) });
  const store = createMemoryTaskStore();
  const bridge = createTomboBridge({ store, session: sdk.session, sdkCommit: sdk.commit });
  const inspection = input();
  const first = await bridge.inspect(inspection);
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.error.code, 'unavailable');
  assert.match(first.error.reason, new RegExp(`crash after ${step}`));
  const crashed = await commands(sdk.taskDirectory);
  assert.equal(count(crashed, 'activate'), 1, JSON.stringify(names(crashed)));
  assert.equal(count(crashed, 'inspect'), step === 'inspected' ? 1 : 0, JSON.stringify(names(crashed)));
  const open = value(await store.snapshot());
  assert.equal(open.entries.filter(entry => entry.key.collection === 'tombo.inspect-proofs').length, 0);
  assert.equal(open.entries.filter(entry => entry.key.collection === 'tombo.bindings').length, 0);
  const recovered = value(await bridge.inspect(structuredClone(inspection)));
  assert.equal(recovered.canReportCompletion, false);
  const finished = await commands(sdk.taskDirectory);
  assert.equal(count(finished, 'activate'), 1, JSON.stringify(names(finished)));
  assert.equal(count(finished, 'inspect'), 1, JSON.stringify(names(finished)));
  const proof = value(await store.snapshot()).entries.find(entry => entry.key.collection === 'tombo.inspect-proofs');
  assert.ok(proof);
  assert.deepEqual(proof.value.steps, [...inspectionSteps]);
  assert.equal(proof.value.identity.taskId, inspection.taskId);
  assert.equal(proof.value.identity.sdkCommit, sdk.commit);
  assert.equal(proof.value.actual.state.decision, 'needs_reflection');
  assert.equal(proof.value.actual.session.pendingOperation, null);
  assert.equal(proof.value.actual.session.accountingUncertain, false);
  value(await bridge.inspect(structuredClone(inspection)));
  assert.equal(count(await commands(sdk.taskDirectory), 'inspect'), 1);
  await store.close();
});

test('real managed session rejects a retrieved subset or duplicate of the evidence manifest', { timeout: 180000 }, async () => {
  await runtimeReady;
  const metadata = [
    { evidenceId: 'public-a', kind: 'document', sourceGroup: 'public-synthetic-source', version: null },
    { evidenceId: 'public-b', kind: 'document', sourceGroup: 'public-synthetic-source', version: null },
  ];
  const sdk = await sdkOptions({ evidenceMetadata: metadata });
  const inspection = input();
  inspection.evidence = [{ evidenceId: 'public-a', source: 'public', scope: 'public-synthetic', allowedReaders: ['evaluator'], content: { kind: 'retrieved', body: 'A', digest: 'ab'.repeat(32), retrievedAt: new Date().toISOString() } }];
  await assert.rejects(sdk.session.inspect(inspection), /expected manifest/);
  assert.equal(count(await commands(sdk.taskDirectory), 'activate'), 0);
  const duplicated = input();
  duplicated.evidence = [structuredClone(inspection.evidence[0]), structuredClone(inspection.evidence[0])];
  const single = await sdkOptions({ evidenceMetadata: [metadata[0]] });
  await assert.rejects(single.session.inspect(duplicated), /expected manifest/);
  assert.equal(count(await commands(single.taskDirectory), 'activate'), 0);
});
