import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './client.mjs';
import { assertLatest } from '../../mechanism/storage/generation-fixtures.mjs';

for (const oldLast of [true, false]) test(`B1 confirmed generation survives process restart with oldLast=${oldLast}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-b1-'));
  const first = await start(t, directory);
  t.diagnostic(JSON.stringify(await first.call('generations', { oldLast })));
  const before = await first.call('snapshot');
  assertLatest(await first.call('retrieve', { mappingId: 'M2' }));
  await first.close();
  const second = await start(t, directory, { seed: false });
  assertLatest(await second.call('retrieve', { mappingId: 'M2' }));
  assert.deepEqual(await second.call('snapshot'), before);
  await second.close();
});
