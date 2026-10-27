import * as core from '@semevolve/core';
import { conformance } from '../../support/persistence-conformance.mjs';

conformance('memory', async t => {
  const store = core.createMemoryTaskStore({ mutableCollections: ['state'] });
  t.after(() => store.close());
  return store;
});
