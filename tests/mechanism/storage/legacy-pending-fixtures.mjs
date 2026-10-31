import { createMemoryTaskStore } from '@semevolve/core';
import { pending } from './pending-fixtures.mjs';

export function legacyBatch(input) {
  const batch = structuredClone(input);
  for (const mutation of batch.mutations) {
    if (mutation.entry.key.collection === 'storage.operations' && mutation.entry.value.kind === 'intent') delete mutation.entry.value.inspectionDigest;
  }
  for (const event of batch.events) {
    if (!['storage.switch.intent', 'storage.restore.intent'].includes(event.kind)) continue;
    delete event.data.stateDigest;
    delete event.data.intentDigest;
    if (event.kind === 'storage.switch.intent') delete event.data.head;
  }
  return batch;
}

export async function legacyPending(operation) {
  const store = createMemoryTaskStore({ mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.heads', 'storage.migrations'] });
  let legacy = true;
  const wrapped = { snapshot: () => store.snapshot(), close: () => store.close(), transact: b => {
    if (legacy && b.events.some(e => e.kind === `storage.${operation}.intent`)) { legacy = false; return store.transact(legacyBatch(b)); }
    return store.transact(b);
  } };
  return pending(operation, { store: wrapped });
}
