import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHub, prepareHub } from '../../../apps/cli/dist/hub.js';
import { participants, value } from './helpers.mjs';

const destination = () => join(fs.mkdtempSync(join(tmpdir(), 'semevolve-prepare-failure-')), 'hub');
function inject(t, stage, directory, foreign = false) {
  let fired = 0;
  let closed = 0;
  const write = fs.writeFileSync;
  const open = fs.openSync;
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  const fail = () => { fired += 1; throw Object.assign(new Error('Synthetic prepare write failure.'), { code: 'EIO' }); };
  t.mock.method(fs, 'openSync', function (path, ...args) {
    if (stage === 'database creation' && path === join(directory, 'hub.sqlite') && args[0] === 'wx') fail();
    return Reflect.apply(open, this, [path, ...args]);
  });
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (stage === 'schema creation' && sql.startsWith('CREATE TABLE principals')) fail();
    return Reflect.apply(exec, this, [sql]);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    const result = Reflect.apply(close, this, []);
    closed += 1;
    return result;
  });
  t.mock.method(fs, 'writeFileSync', function (path, data, ...args) {
    let content;
    try { content = JSON.parse(String(data)); } catch { content = null; }
    if (stage === 'context creation' && content?.actorId === 'receiver@canary') fail();
    if (stage === 'authority creation' && content?.schema === 'semevolve-m0-1') {
      Reflect.apply(write, this, [path, data, ...args]);
      if (foreign) write(join(directory, 'unrelated.txt'), 'KEEP_UNRELATED');
      fail();
    }
    return Reflect.apply(write, this, [path, data, ...args]);
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  return { restore, stats: () => ({ fired, closed }) };
}

for (const stage of ['database creation', 'schema creation', 'context creation', 'authority creation']) {
  test(`prepare failure during ${stage} closes handles, removes only its own attempt and permits retry`, t => {
    const directory = destination();
    assert.equal(isAbsolute(directory), true);
    const fault = inject(t, stage, directory);
    const failed = prepareHub({ directory, participants });
    fault.restore();
    assert.equal(failed.ok, false);
    assert.equal(fault.stats().fired, 1);
    assert.equal(fs.existsSync(directory), false, 'failed attempt must not strand a path_exists directory or session secrets');
    assert.equal(failed.error.code, 'prepare_failed');
    assert.equal(failed.error.message.includes(stage), true);
    assert.equal(fault.stats().closed, stage === 'database creation' ? 0 : 1);
    const prepared = value(prepareHub({ directory, participants }));
    const hub = value(createHub({ authorityPath: prepared.authorityPath, contextPath: prepared.contexts[0].path }));
    assert.equal(hub.identity().actorId, 'sender@canary');
    value(hub.close());
  });
}

test('failed prepare preserves another file and reports incomplete cleanup without retaining its session contexts', t => {
  const directory = destination();
  const fault = inject(t, 'authority creation', directory, true);
  const failed = prepareHub({ directory, participants });
  fault.restore();
  assert.equal(failed.ok, false);
  assert.equal(fault.stats().fired, 1);
  assert.equal(failed.error.code, 'prepare_cleanup_required');
  assert.equal(fs.readFileSync(join(directory, 'unrelated.txt'), 'utf8'), 'KEEP_UNRELATED');
  assert.deepEqual(fs.readdirSync(directory), ['unrelated.txt']);
  assert.equal(prepareHub({ directory, participants }).error.code, 'path_exists');
});

test('prepare on an existing private hub preserves database and context bytes', () => {
  const directory = destination();
  const prepared = value(prepareHub({ directory, participants }));
  const files = [prepared.databasePath, prepared.authorityPath, ...prepared.contexts.map(c => c.path)];
  const hashes = () => files.map(path => createHash('sha256').update(fs.readFileSync(path)).digest('hex'));
  const before = hashes();
  assert.equal(prepareHub({ directory, participants }).error.code, 'path_exists');
  assert.deepEqual(hashes(), before);
  const hub = value(createHub({ authorityPath: prepared.authorityPath, contextPath: prepared.contexts[0].path }));
  assert.equal(hub.identity().actorId, 'sender@canary');
  value(hub.close());
});
