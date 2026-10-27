import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFileStoreOwner, recoverFileStoreOwner } from '@semevolve/core';

test('T-F1 receipt-only sender restart redelivers to separate durable receiver stores exactly once per recipient', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-receipt-recovery-'));
  const script = fileURLToPath(new URL('./receipt-process.mjs', import.meta.url));
  const sent = spawnSync(process.execPath, [script, 'send', directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(sent.status, 71, sent.stdout + sent.stderr);
  for (const peer of ['peer-a', 'peer-b', 'peer-c']) {
    const owner = inspectFileStoreOwner(join(directory, peer));
    assert.equal(owner.pid, sent.pid);
    recoverFileStoreOwner(join(directory, peer), owner.token);
  }
  const resumed = spawnSync(process.execPath, [script, 'resume', directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout), { calls: 4, recipients: ['peer-b', 'peer-c'], applicationsPerRecipient: 1 });
});
