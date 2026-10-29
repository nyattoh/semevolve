import { openFileTaskStore, digestJson, inspectFileStoreOwner } from '@semevolve/core';
import { recordingFixture, comparisonProposal } from '../../mechanism/storage/recording-evaluation-fixtures.mjs';
import { take, mapping, rows, original, clausePayload } from '../../mechanism/storage/fixtures.mjs';
import { checkedMigration, migrationRequest, targetMapping } from '../../mechanism/storage/migration-fixtures.mjs';

const directory = process.argv[2], options = JSON.parse(process.argv[3]);
let arm = null, currentBatch = null;
const store = await openFileTaskStore(directory, { mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.migrations', 'storage.heads'], async onBoundary(point) {
  if (!arm || point !== arm.point || !(arm.kind === 'canonical' ? currentBatch?.mutations.some(m => m.entry.key.collection === 'synthetic.canonical-storage') : currentBatch?.events.some(e => e.kind === arm.kind))) return;
  const reached = arm; arm = null;
  process.send({ event: 'boundary', ...reached, pid: process.pid, transactionId: currentBatch.transactionId, batchDigest: digestJson(currentBatch), owner: inspectFileStoreOwner(directory) });
  await new Promise(() => {});
} });
const wrapped = { snapshot: () => store.snapshot(), close: () => store.close(), transact: batch => { currentBatch = batch; return store.transact(batch); } };
const f = await recordingFixture({ store: wrapped, seed: options.seed !== false });
process.on('message', async ({ id, action, input = {} }) => {
  try {
    let result;
    switch (action) {
      case 'arm': arm = input; result = true; break;
      case 'snapshot': result = await f.snapshot(); break;
      case 'inspect': result = await f.runtime.inspectMapping(mapping()); break;
      case 'certify': result = await f.certify(); break;
      case 'store': result = await f.runtime.store('message-1', mapping()); break;
      case 'retrieve': result = await f.runtime.retrieve({ all: true }, mapping()); break;
      case 'withdraw': await f.withdraw(); result = true; break;
      case 'head': result = await f.runtime.head(); break;
      case 'change-during-check': f.controls.after = async () => { await f.update('original', original('message-1', { ...clausePayload, literal: 'changed during evaluation' })); }; result = true; break;
      case 'compare':
        take(await f.runtime.registerProposal(comparisonProposal())); take(await f.runtime.registerProposal(comparisonProposal('candidate')));
        result = await f.runtime.compare(comparisonProposal(), comparisonProposal('candidate')); break;
      case 'migration':
        await f.certify(); await f.certify(targetMapping); take(await f.runtime.store('message-1', mapping()));
        await checkedMigration(f); take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
        await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', targetMapping));
        result = await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' }); break;
      case 'close': await store.close(); process.send({ id, result: true }, () => process.exit(0)); return;
      default: throw new Error('Unknown evaluation process action');
    }
    process.send({ id, result });
  } catch (error) { process.send({ id, error: String(error) }); }
});
process.send({ event: 'ready', pid: process.pid });
