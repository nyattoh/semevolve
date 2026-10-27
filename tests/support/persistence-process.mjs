import * as core from '@semevolve/core';

const [directory, boundary] = process.argv.slice(2);
try {
  const store = await core.openFileTaskStore(directory, {
    mutableCollections: ['state'],
    onBoundary: async point => {
      if (point !== boundary) return;
      process.send({ type: 'boundary', point });
      await new Promise(() => {});
    },
  });
  process.on('message', async request => {
    try {
      let value;
      if (request.method === 'transact') value = await store.transact(request.argument);
      else if (request.method === 'snapshot') value = await store.snapshot();
      else if (request.method === 'checkpoint') value = await store.checkpoint();
      else if (request.method === 'backup') value = await store.backup(request.argument);
      else if (request.method === 'close') { await store.close(); process.send({ id: request.id, value: 'closed' }, () => process.disconnect()); return; }
      else throw Error('Unknown test request');
      process.send({ id: request.id, value });
    } catch (error) { process.send({ id: request.id, failure: error.message }); }
  });
  process.send({ type: 'ready', pid: process.pid, owner: core.inspectFileStoreOwner(directory) });
} catch (error) {
  process.send({ type: 'open_failed', failure: error.message }, () => process.disconnect());
  process.exitCode = 2;
}
