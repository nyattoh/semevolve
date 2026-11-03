import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './client.mjs';
import { rows, take } from '../../mechanism/storage/fixtures.mjs';

function processEvents(t, file, args) {
  const child = fork(new URL(file, import.meta.url), args, { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 30000 });
  const messages = []; const waiting = new Map(); let stderr = '';
  child.stdout.on('data', () => {}); child.stderr.on('data', d => { stderr += d; });
  const exited = once(child, 'exit');
  child.on('message', m => { messages.push(m); if (waiting.has(m.event)) waiting.get(m.event)(m); });
  const event = name => Promise.race([new Promise(resolve => { const message = messages.find(m => m.event === name); if (message) resolve(message); else waiting.set(name, resolve); }), exited.then(([code, signal]) => { throw new Error(`Child ended before ${name}: ${code}/${signal}: ${stderr}`); })]);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  return { child, event, exited };
}
test('L5 two independent socket clients overlap at one file-writer CAS and persist both outcomes', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-storage-race-'));
  const writer = processEvents(t, './race-writer.mjs', [directory]); const ready = await writer.event('ready');
  const clients = ['a', 'b'].map(id => processEvents(t, './race-client.mjs', [String(ready.port), String(ready.expectedRevision), id]));
  const sent = await Promise.all(clients.map(c => c.event('sent')));
  assert.notEqual(sent[0].pid, sent[1].pid); assert.ok(sent.every(c => c.pid !== ready.pid));
  const prepared = await writer.event('prepared'); assert.equal(prepared.unresolved, 2);
  writer.child.send({ action: 'releaseAdmission' });
  const overlap = await writer.event('overlap');
  assert.equal(overlap.unresolved, 2, 'L5_REAL_CAS_OVERLAP');
  assert.deepEqual(overlap.admitted.map(b => b.expectedRevision), [ready.expectedRevision, ready.expectedRevision]);
  assert.notEqual(overlap.admitted[0].transactionId, overlap.admitted[1].transactionId);
  t.diagnostic(JSON.stringify({ ...overlap, clients: sent }));
  writer.child.send({ action: 'releaseCore' });
  const outcomes = await Promise.all(clients.map(c => c.event('result'))); const done = await writer.event('done');
  assert.equal(outcomes.filter(o => o.result.ok).length, 1);
  assert.equal(outcomes.find(o => !o.result.ok).result.error.code, 'revision_conflict');
  for (const client of clients) { const [code, signal] = await client.exited; assert.equal(code, 0); assert.equal(signal, null); }
  writer.child.send({ action: 'close' }); const [code, signal] = await writer.exited; assert.equal(code, 0); assert.equal(signal, null);
  const reopened = await start(t, directory, { seed: false }); const snapshot = await reopened.call('snapshot');
  assert.deepEqual(snapshot, done.snapshot); assert.equal(take(await reopened.call('head')).mappingId, 'M2');
  const durable = rows(snapshot, 'host.race-results')[0];
  assert.equal(durable.filter(o => o.result.ok).length, 1); assert.equal(durable.find(o => !o.result.ok).result.error.code, 'revision_conflict');
  assert.equal(rows(snapshot, 'storage.operations').filter(o => o.kind === 'receipt' && o.operation === 'switch').length, 1);
  await reopened.close();
});
