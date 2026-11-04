import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFileTaskStore } from '@semevolve/core';
import { fixture, request, value } from './fixture.mjs';

const [directory, mode] = process.argv.slice(2);
const store = await openFileTaskStore(join(directory, 'store'));
const f = fixture({ store });
let req;
if (mode === 'first') {
  req = await request(f, 'transmission', { certainty: 'candidate' });
  await writeFile(join(directory, 'request.json'), JSON.stringify(req), { flag: 'wx' });
} else req = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
const execution = value(await f.runtime.evaluate(req));
const snapshot = value(await store.snapshot());
await store.close();
process.stdout.write(JSON.stringify({ pid: process.pid, execution, snapshot }));
