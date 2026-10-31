import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openFileTaskStore, inspectFileStoreOwner } from '@semevolve/core';
import { createTomboBridge } from '@semevolve/tombo-bridge';
import { sdkOptions } from './sdk-fixture.mjs';
import { update, value } from './fixture.mjs';

const [descriptorPath, point] = process.argv.slice(2);
try {
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const sdk = await sdkOptions(descriptor.sdk);
  const appDirectory = join(descriptor.directory, 'app-store');
  const store = await openFileTaskStore(appDirectory);
  const bridge = createTomboBridge({ store, session: sdk.session, sdkCommit: sdk.commit,
    async boundary(reached, req) {
      if (reached !== point) return;
      const snapshot = value(await store.snapshot());
      const sdkState = await sdk.session.status(req.taskId);
      process.send({ kind: 'boundary', point: reached, pid: process.pid, owner: inspectFileStoreOwner(appDirectory), snapshot, sdkState });
      await new Promise(() => {});
    },
  });
  const requestPath = join(descriptor.directory, 'request.json');
  let request;
  if (existsSync(requestPath)) request = JSON.parse(await readFile(requestPath, 'utf8'));
  else {
    const inspection = value(await bridge.inspect(descriptor.input));
    request = update(inspection.reference);
    await writeFile(requestPath, JSON.stringify(request), { flag: 'wx' });
  }
  value(await bridge.receive(request));
  const result = value(await bridge.reconcile(request));
  const sdkState = await sdk.session.status(request.taskId);
  const snapshot = value(await store.snapshot());
  await store.close();
  process.send({ kind: 'complete', pid: process.pid, result, sdkState, snapshot });
  process.disconnect();
} catch (error) { process.stderr.write(String(error.stack)); process.exitCode = 1; process.disconnect?.(); }
