import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import * as ui from '@semevolve/local-ui';

test('CLI reports the incomplete P0 skeleton without running a provider', () => {
  const result = spawnSync(process.execPath, ['apps/cli/dist/index.js', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /P0.*機構未完了/u);
  assert.match(result.stdout, /AT.*0\/34/u);
});

test('CLI refuses unimplemented commands', () => {
  const result = spawnSync(process.execPath, ['apps/cli/dist/index.js', 'run'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未実装/u);
});

test('local UI serves only a P0 skeleton on loopback', async (t) => {
  assert.equal(typeof ui.createLocalUi, 'function');
  const server = ui.createLocalUi();
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/u);
  assert.match(await response.text(), /P0.*機構未完了/u);
  const missing = await fetch(`http://127.0.0.1:${address.port}/run`, { method: 'POST' });
  assert.equal(missing.status, 404);
});
