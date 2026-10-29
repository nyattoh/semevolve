import assert from 'node:assert/strict';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { migrationFixture, migrationRequest } from './migration-fixtures.mjs';
import { take, reject, rows } from './fixtures.mjs';

export function projectionLegacyBatch(input, format) {
  const batch = structuredClone(input);
  for (const event of batch.events) if (['storage.copy.intent', 'storage.catch_up.intent'].includes(event.kind)) {
    delete event.data.head; delete event.data.stateDigest; delete event.data.intentDigest;
  }
  if (format === 'legacy') for (const m of batch.mutations) if (m.entry.key.collection === 'storage.operations' && m.entry.value.kind === 'intent') delete m.entry.value.inspectionDigest;
  return batch;
}
export async function projectionPending(operation, format = 'modern') {
  const f = await migrationFixture();
  if (operation === 'catch_up') take(await f.runtime.migration.prepare(await migrationRequest(f)));
  let armed = true;
  const store = { close: () => f.store.close(), snapshot: () => f.store.snapshot(), async transact(batch) {
    const hit = armed && batch.events.some(e => e.kind === `storage.${operation}.intent`);
    if (hit && format !== 'modern') batch = projectionLegacyBatch(batch, format);
    const result = await f.store.transact(batch);
    if (hit && result.ok) { armed = false; throw new Error('Synthetic response loss after projection intent'); }
    return result;
  } };
  const runtime = createStoragePlanner({ ...f.options, store });
  const result = operation === 'copy' ? await runtime.migration.prepare(await migrationRequest(f)) : await runtime.migration.catchUp('migration-1', (await f.snapshot()).revision);
  reject(result, 'unavailable'); const before = await f.snapshot(); const state = rows(before, 'storage.migrations')[0];
  assert.equal(state.phase, `${operation}_pending`);
  assert.deepEqual(take(await f.runtime.migration.reconcile('migration-1')), state.migration); assert.deepEqual(await f.snapshot(), before);
  return { ...f, pendingState: state, head: take(await f.runtime.head()) };
}
