import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@semevolve/core';
import { conformance } from '../../support/persistence-conformance.mjs';

conformance('file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-p0-'));
  let store;
  t.after(async () => { await store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await core.openFileTaskStore(directory, { mutableCollections: ['state'] });
  return store;
});
