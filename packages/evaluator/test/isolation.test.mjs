import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRoleBoundary } from '@semevolve/evaluator';
import { fixture, value } from './support/fixture.mjs';

test('AT19 role and tool boundary refuses evaluator input and formal blind without OS isolation', { timeout: 30000 }, async () => {
  const f = fixture();
  const roles = createRoleBoundary({ taskId: f.run.taskId, store: f.store, documents: [{ id: 'public-input', body: { text: 'candidate' }, readers: ['receiver', 'sender'], evaluatorOnly: false }, { id: 'evaluation-data', body: { expected: 'candidate' }, readers: ['evaluator'], evaluatorOnly: true }], tools: { receiver: ['read'], sender: ['read'], evaluator: ['read'] }, isolation: { verdict: 'unverified', evidence: null } });
  const formal = await roles.requireFormalBlind();
  assert.equal(formal.ok ? 'allowed' : formal.error.code, 'invalid_input');
  assert.deepEqual(value(await roles.read('receiver', 'read', 'public-input')), { text: 'candidate' });
  assert.equal((await roles.read('receiver', 'read', 'evaluation-data')).error.code, 'invalid_input');
  assert.equal((await roles.read('receiver', 'shell', 'public-input')).error.code, 'invalid_input');
  assert.equal((await roles.read('receiver', 'read', '../evaluation-data')).error.code, 'invalid_input');
  assert.deepEqual(value(await roles.exportInput('receiver')), { role: 'receiver', documents: [{ id: 'public-input', body: { text: 'candidate' } }] });
  assert.equal(value(await f.store.snapshot()).events.filter(e => e.kind === 'evaluator.role_boundary').length, 6);
});

test('AT19 direct OS read is recorded separately and its failure verdict blocks formal blind', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(process.env.SEMEVOLVE_E_EVIDENCE_ROOT ?? tmpdir(), 'semevolve-e-isolation-'));
  const canary = join(directory, 'canary.txt');
  await writeFile(canary, 'PUBLIC-SYNTHETIC-CANARY-ONLY', { flag: 'wx' });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.argv[1],'utf8'));", canary], { encoding: 'utf8', timeout: 30000, env: {} });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'PUBLIC-SYNTHETIC-CANARY-ONLY');
  const record = { mechanism_verdict: 'pass', isolation_verdict: 'fail', reason: 'Same OS principal can directly read the public synthetic canary', childExit: child.status, formalBlind: false, isHiddenAnswer: false };
  const f = fixture();
  const boundary = createRoleBoundary({ taskId: f.run.taskId, store: f.store, documents: [], tools: {}, isolation: { verdict: record.isolation_verdict, evidence: 'Same-principal child read succeeded' } });
  await writeFile(join(directory, 'isolation-result.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  assert.equal((await boundary.requireFormalBlind()).error.code, 'invalid_input');
  assert.equal(record.isolation_verdict, 'fail');
});
