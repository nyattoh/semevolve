import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareHub, createHub } from '../../../apps/cli/dist/hub.js';

const participants = [
  { id: 'sender@canary', role: 'pm', connectionRef: 'conn-a', sessionRef: 'session-a', capabilities: ['local_cli'], languageVersions: [] },
  { id: 'receiver@canary', role: 'worker', connectionRef: 'conn-b', sessionRef: 'session-b', capabilities: ['local_cli'], languageVersions: [] },
];
const directory = () => join(mkdtempSync(join(tmpdir(), 'semevolve-m0-storage-')), 'hub');
function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }

test('prepare creates a private SQLite authority, binds a session and reopens it', () => {
  const location = directory();
  const prepared = value(prepareHub({ directory: location, participants }));
  assert.equal(prepared.authorityPath, join(location, 'authority.json'));
  assert.equal(prepared.databasePath, join(location, 'hub.sqlite'));
  assert.deepEqual(prepared.contexts.map(c => c.actorId), ['sender@canary', 'receiver@canary']);
  const options = { authorityPath: prepared.authorityPath, contextPath: prepared.contexts[0].path };
  const hub = value(createHub(options));
  assert.deepEqual(hub.identity(), { actorId: 'sender@canary', role: 'pm', connectionRef: 'conn-a', sessionRef: 'session-a' });
  assert.equal(hub.close().ok, true);
  const reopened = value(createHub(options));
  assert.equal(reopened.identity().sessionRef, 'session-a');
  assert.equal(reopened.close().ok, true);
});

test('relative, repository, missing-parent and existing authority destinations do not get created or changed', () => {
  const missing = join(directory(), 'missing', 'hub');
  assert.equal(prepareHub({ directory: missing, participants }).error.code, 'invalid_path');
  assert.equal(existsSync(missing), false);
  assert.equal(prepareHub({ directory: 'relative-hub', participants }).error.code, 'invalid_path');
  const repoPath = resolve('m0-forbidden-private');
  assert.equal(prepareHub({ directory: repoPath, participants }).error.code, 'invalid_path');
  assert.equal(existsSync(repoPath), false);
  const existing = directory();
  mkdirSync(existing);
  writeFileSync(join(existing, 'keep'), 'KEEP');
  assert.equal(prepareHub({ directory: existing, participants }).error.code, 'path_exists');
  assert.equal(readFileSync(join(existing, 'keep'), 'utf8'), 'KEEP');
});

test('invalid participants are rejected before filesystem writes', () => {
  for (const bad of [null, [{ ...participants[0], id: 'no-host' }], [participants[0], participants[0]], [{ ...participants[0], connectionRef: {} }]]) {
    const location = directory();
    assert.equal(prepareHub({ directory: location, participants: bad }).error.code, 'invalid_input');
    assert.equal(existsSync(location), false);
  }
});

test('modified actor, session, OS owner and secret contexts cannot impersonate the provisioned actor', () => {
  const p = value(prepareHub({ directory: directory(), participants }));
  const path = p.contexts[0].path;
  const original = JSON.parse(readFileSync(path, 'utf8'));
  for (const patch of [{ actorId: 'unknown@canary' }, { actorId: 'receiver@canary' }, { sessionRef: 'different' }, { osBinding: 'different' }, { secret: 'different' }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...patch }));
    const result = createHub({ authorityPath: p.authorityPath, contextPath: path });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unauthorised');
  }
  writeFileSync(path, JSON.stringify(original));
  assert.equal(value(createHub({ authorityPath: p.authorityPath, contextPath: path })).close().ok, true);
});

test('unknown existing database schema is rejected without changing any bytes', () => {
  const p = value(prepareHub({ directory: directory(), participants }));
  const db = new DatabaseSync(p.databasePath);
  db.exec('CREATE TABLE foreign_data(body TEXT); INSERT INTO foreign_data VALUES (\'KEEP\')');
  db.close();
  const before = readFileSync(p.databasePath);
  const result = createHub({ authorityPath: p.authorityPath, contextPath: p.contexts[0].path });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown_schema');
  assert.deepEqual(readFileSync(p.databasePath), before);
});

test('authority cannot redirect to another database or accept a context from another authority', () => {
  const a = value(prepareHub({ directory: directory(), participants }));
  const b = value(prepareHub({ directory: directory(), participants }));
  assert.equal(createHub({ authorityPath: a.authorityPath, contextPath: b.contexts[0].path }).error.code, 'unauthorised');
  const authority = JSON.parse(readFileSync(a.authorityPath, 'utf8'));
  writeFileSync(a.authorityPath, JSON.stringify({ ...authority, databasePath: b.databasePath }));
  const before = readFileSync(b.databasePath);
  assert.equal(createHub({ authorityPath: a.authorityPath, contextPath: a.contexts[0].path }).error.code, 'invalid_path');
  assert.deepEqual(readFileSync(b.databasePath), before);
});
