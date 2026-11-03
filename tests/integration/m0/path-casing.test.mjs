import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createHub, prepareHub } from '../../../apps/cli/dist/hub.js';
import { participants, value } from './helpers.mjs';

const windows = process.platform === 'win32';
const expectation = windows ? 'Windows accepts equivalent casing' : 'non-Windows preserves case-sensitive matching';
const prepare = () => value(prepareHub({ directory: join(mkdtempSync(join(tmpdir(), 'semevolve-Case-')), 'CaseHub'), participants }));
function check(result) {
  if (windows) {
    const hub = value(result);
    assert.equal(hub.identity().actorId, 'sender@canary');
    value(hub.close());
  } else {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_path');
  }
}

test(`authority directory path: ${expectation}`, () => {
  const p = prepare();
  for (const change of [s => s.toUpperCase(), s => s.toLowerCase()]) {
    const authorityPath = join(change(dirname(p.authorityPath)), basename(p.authorityPath));
    assert.notEqual(authorityPath, p.authorityPath);
    check(createHub({ authorityPath, contextPath: p.contexts[0].path }));
  }
});

test(`authority filename and context path: ${expectation}`, () => {
  const p = prepare();
  check(createHub({ authorityPath: p.authorityPath.toUpperCase(), contextPath: p.contexts[0].path.toUpperCase() }));
  check(createHub({ authorityPath: p.authorityPath.toLowerCase(), contextPath: p.contexts[0].path.toLowerCase() }));
});

test(`stored database path: ${expectation}`, () => {
  const p = prepare();
  const authority = JSON.parse(readFileSync(p.authorityPath, 'utf8'));
  for (const databasePath of [p.databasePath.toUpperCase(), p.databasePath.toLowerCase()]) {
    writeFileSync(p.authorityPath, JSON.stringify({ ...authority, databasePath }));
    check(createHub({ authorityPath: p.authorityPath, contextPath: p.contexts[0].path }));
  }
  writeFileSync(p.authorityPath, JSON.stringify(authority));
  const hub = value(createHub({ authorityPath: p.authorityPath, contextPath: p.contexts[0].path }));
  assert.equal(hub.identity().actorId, 'sender@canary');
  value(hub.close());
});

test('case handling never permits authority redirection to a different private hub', () => {
  const a = prepare();
  const b = prepare();
  const authority = JSON.parse(readFileSync(a.authorityPath, 'utf8'));
  const hash = () => createHash('sha256').update(readFileSync(b.databasePath)).digest('hex');
  const before = hash();
  writeFileSync(a.authorityPath, JSON.stringify({ ...authority, databasePath: windows ? b.databasePath.toUpperCase() : b.databasePath }));
  assert.equal(createHub({ authorityPath: a.authorityPath, contextPath: a.contexts[0].path }).error.code, 'invalid_path');
  assert.equal(hash(), before);
  const hub = value(createHub({ authorityPath: b.authorityPath, contextPath: b.contexts[0].path }));
  assert.equal(hub.identity().actorId, 'sender@canary');
  value(hub.close());
});
