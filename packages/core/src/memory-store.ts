import type { TaskStore } from './contracts/task-store.js';
import { copyBatch, invalidBatch, mutableCollections, StoreEngine, unavailable, type StoreOptions } from './store-engine.js';

export function createMemoryTaskStore(options: StoreOptions = {}): TaskStore {
  const engine = new StoreEngine(mutableCollections(options));
  let closed = false;
  return {
    async snapshot() { return closed ? unavailable('Store closed') : { ok: true, value: engine.snapshot() }; },
    async transact(input) {
      if (closed) return unavailable('Store closed');
      let batch;
      try { batch = copyBatch(input); } catch { return invalidBatch(); }
      return engine.commit(batch, engine.prepare(batch));
    },
    async close() { closed = true; },
  };
}
