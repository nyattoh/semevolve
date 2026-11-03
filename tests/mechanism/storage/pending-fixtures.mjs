import assert from 'node:assert/strict';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { take, reject, rows, original } from './fixtures.mjs';
import { checkedMigration, migrationFixture, targetMapping } from './migration-fixtures.mjs';

export function request(f, operation, revision) {
  return { migrationId: 'migration-1', expectedRevision: revision, authorisationRef: `grant-${operation}` };
}
export async function pending(operation, extra = {}) {
  const f = await migrationFixture(extra);
  await checkedMigration(f);
  if (operation === 'restore') {
    take(await f.runtime.migration.switch(request(f, 'switch', (await f.snapshot()).revision)));
    await f.append('host.originals', 'message-2', original('message-2'));
    take(await f.runtime.store('message-2', targetMapping));
  }
  const head = take(await f.runtime.head());
  let armed = true;
  const wrapped = { snapshot: () => f.store.snapshot(), close: () => f.store.close(), async transact(batch) {
    const result = await f.store.transact(batch);
    if (armed && result.ok && batch.events.some(e => e.kind === `storage.${operation}.intent`)) {
      armed = false;
      throw new Error('Synthetic response loss immediately after durable intent');
    }
    return result;
  } };
  const interrupted = createStoragePlanner({ ...f.options, store: wrapped });
  reject(await interrupted.migration[operation](request(f, operation, (await f.snapshot()).revision)), 'unavailable');
  const snapshot = await f.snapshot();
  const state = rows(snapshot, 'storage.migrations')[0];
  assert.equal(state.phase, `${operation}_pending`);
  assert.equal(state.migration.pendingOperation.executionId, state.intent);
  assert.equal(rows(snapshot, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === state.intent).length, 0);
  assert.deepEqual(take(await f.runtime.head()), head);
  const runtime = createStoragePlanner(f.options);
  assert.deepEqual(take(await runtime.migration.reconcile('migration-1')), state.migration);
  assert.deepEqual(await f.snapshot(), snapshot);
  return { ...f, runtime, head, pendingState: state };
}
