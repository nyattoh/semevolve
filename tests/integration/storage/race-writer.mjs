import { createServer } from 'node:net';
import { openFileTaskStore } from '@semevolve/core';
import { migrationFixture, checkedMigration } from '../../mechanism/storage/migration-fixtures.mjs';
import { take } from '../../mechanism/storage/fixtures.mjs';

let armed = false;
let releaseCore;
let active = 0;
const admitted = [];
const held = [];
const results = [];
const store = await openFileTaskStore(process.argv[2], { mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'], async onBoundary(point) {
  if (!armed || point !== 'journal_before_append') return;
  armed = false;
  process.send({ event: 'overlap', pid: process.pid, unresolved: active, admitted: admitted.map(b => ({ transactionId: b.transactionId, expectedRevision: b.expectedRevision })) });
  await new Promise(resolve => { releaseCore = resolve; });
} });
const wrapped = { snapshot: () => store.snapshot(), close: () => store.close(), transact(batch) {
  if (batch.events.some(e => e.kind === 'storage.switch.intent') && held.length < 2) return new Promise(resolve => { held.push({ batch, resolve }); if (held.length === 2) process.send({ event: 'prepared', unresolved: 2 }); });
  return store.transact(batch);
} };
const f = await migrationFixture({ store: wrapped }); await checkedMigration(f);
const revision = (await f.snapshot()).revision;
const server = createServer(socket => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', async chunk => {
    buffer += chunk; if (!buffer.includes('\n')) return;
    const request = JSON.parse(buffer.trim()); buffer = '';
    const result = await f.runtime.migration.switch(request.input);
    results.push({ client: request.client, pid: request.pid, request: request.input, result });
    socket.end(JSON.stringify(result) + '\n');
    if (results.length === 2) {
      await f.append('host.race-results', 'results', results);
      process.send({ event: 'done', snapshot: await f.snapshot(), results });
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.on('message', async message => {
  if (message.action === 'releaseAdmission') {
    armed = true;
    for (const { batch, resolve } of held) { admitted.push(batch); active++; void store.transact(batch).then(result => { active--; resolve(result); }); }
  }
  if (message.action === 'releaseCore') releaseCore();
  if (message.action === 'close') { await new Promise(resolve => server.close(resolve)); await store.close(); process.exit(0); }
});
process.send({ event: 'ready', port: server.address().port, expectedRevision: revision, head: take(await f.runtime.head()), pid: process.pid });
