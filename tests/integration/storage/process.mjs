import { openFileTaskStore, digestJson, inspectFileStoreOwner } from '@semevolve/core';
import { migrationFixture, migrationRequest, checkedMigration, targetMapping } from '../../mechanism/storage/migration-fixtures.mjs';
import { mapping, original, take } from '../../mechanism/storage/fixtures.mjs';
import { generations } from '../../mechanism/storage/generation-fixtures.mjs';
import { legacyBatch } from '../../mechanism/storage/legacy-pending-fixtures.mjs';

const directory = process.argv[2];
const options = JSON.parse(process.argv[3]);
let arm = null;
let currentBatch = null;
let legacyOperation = options.legacyOperation;
const store = await openFileTaskStore(directory, { mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'], async onBoundary(point) {
  if (!arm || point !== arm.point || !currentBatch?.events.some(e => e.kind === arm.kind)) return;
  const reached = arm; arm = null;
  process.send({ event: 'boundary', ...reached, pid: process.pid, transactionId: currentBatch.transactionId, batchDigest: digestJson(currentBatch), owner: inspectFileStoreOwner(directory) });
  await new Promise(() => {});
} });
const wrapped = { snapshot: () => store.snapshot(), close: () => store.close(), transact: batch => {
  if (legacyOperation && batch.events.some(e => e.kind === `storage.${legacyOperation}.intent`)) { legacyOperation = null; batch = legacyBatch(batch); }
  currentBatch = batch; return store.transact(batch);
} };
const f = await migrationFixture({ store: wrapped, seed: options.seed !== false });
process.on('message', async ({ id, action, input = {} }) => {
  try {
    let result;
    switch (action) {
      case 'snapshot': result = await f.snapshot(); break;
      case 'generations': result = await generations(f, input.oldLast); break;
      case 'head': result = await f.runtime.head(); break;
      case 'prepare': result = await f.runtime.migration.prepare(await migrationRequest(f)); break;
      case 'checked': result = await checkedMigration(f); break;
      case 'catchUp': result = await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision); break;
      case 'switch': result = await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }); break;
      case 'restore': result = await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' }); break;
      case 'reconcile': result = await f.runtime.migration.reconcile('migration-1'); break;
      case 'retrieve': result = await f.runtime.retrieve({ all: true }, input.mappingId === 'M2' ? targetMapping : mapping()); break;
      case 'write':
        await f.append('host.originals', 'message-2', original('message-2'));
        result = await f.runtime.store('message-2', take(await f.runtime.head()).mappingId === 'M2' ? targetMapping : mapping()); break;
      case 'arm': arm = input; result = true; break;
      case 'close': await store.close(); process.send({ id, result: true }, () => process.exit(0)); return;
      default: throw new Error('Unsupported storage process action');
    }
    process.send({ id, result });
  } catch (error) { process.send({ id, error: String(error) }); }
});
process.send({ event: 'ready', pid: process.pid });
