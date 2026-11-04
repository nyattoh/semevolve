import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindIdentity, sameManifest, uniqueManifest } from '@semevolve/core';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const field = 'evaluatorId|testSetDigest|checkerId|requestDigest|criteriaDigest|evaluatorVersion|languageVersionId|sdkCommit|updateDigest';
const fieldAccess = new RegExp(`\\.(?:${field})\\s*(?:!==|===)`, 'g');
const fieldTarget = new RegExp(`(?:!==|===)\\s*[\\w$.]*\\.(?:${field})\\b`);

function comparesIdentity(line) {
  fieldAccess.lastIndex = 0;
  let match;
  while ((match = fieldAccess.exec(line))) {
    const rest = line.slice(match.index + match[0].length).trimStart();
    if (!rest.startsWith("'") && !rest.startsWith('"') && !rest.startsWith('`')) return true;
  }
  return fieldTarget.test(line);
}

export function boundComparisonViolations(source, file = 'sample.ts') {
  const violations = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (comparesIdentity(line)) violations.push(`${file}:${index + 1} compares an identity field by hand`);
    if (/identity\s*:\s*\{/.test(line)) violations.push(`${file}:${index + 1} builds an identity object by hand`);
  });
  const token = 'new Set(';
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf(token, from);
    if (start < 0) break;
    let depth = 1;
    let cursor = start + token.length;
    for (; cursor < source.length && depth > 0; cursor++) {
      if (source[cursor] === '(') depth += 1;
      else if (source[cursor] === ')') depth -= 1;
    }
    if (source.slice(cursor, cursor + 5) === '.size') violations.push(`${file}:${source.slice(0, start).split('\n').length} compares an id set by hand`);
    from = cursor;
  }
  return violations;
}

function sources(directory) {
  return readdirSync(directory, { recursive: true }).flatMap(name => {
    const path = join(directory, String(name));
    return String(name).endsWith('.ts') ? [[path, readFileSync(path, 'utf8')]] : [];
  });
}

test('identity and manifest comparisons go through the shared binding', () => {
  const violations = ['packages/evaluator/src', 'packages/tombo-bridge/src'].flatMap(directory => sources(join(root, directory)).flatMap(([path, source]) => boundComparisonViolations(source, path.slice(root.length + 1))));
  assert.deepEqual(violations, []);
  const execution = readFileSync(join(root, 'packages/evaluator/src/executions.ts'), 'utf8');
  const keysStart = execution.indexOf('executionIdentityKeys = [');
  const keys = execution.slice(keysStart, execution.indexOf('] as const', keysStart));
  for (const key of ['runId', 'taskId', 'evaluatorId', 'checkerId', 'testSetDigest', 'criteriaDigest', 'evaluatorVersion', 'languageVersionId', 'scope', 'executionId', 'kind', 'requestDigest', 'fingerprint']) {
    assert.ok(keys.includes(`'${key}'`), key);
  }
  assert.match(execution, /return bindIdentity\(executionIdentityKeys/);
  assert.match(readFileSync(join(root, 'packages/evaluator/src/storage-projection.ts'), 'utf8'), /sameManifest\(Object\.keys\(literals\)/);
  assert.match(readFileSync(join(root, 'packages/tombo-bridge/src/runtime.ts'), 'utf8'), /bindIdentity\(inspectIdentityKeys/);
  const sample = 'if (record.evaluatorId !== run.evaluatorId || new Set(record.checkIds).size !== record.checkIds.length) identity: { evaluatorId: record.evaluatorId }';
  assert.deepEqual(boundComparisonViolations(sample), [
    'sample.ts:1 compares an identity field by hand',
    'sample.ts:1 builds an identity object by hand',
    'sample.ts:1 compares an id set by hand',
  ]);
  assert.throws(() => bindIdentity(['evaluatorId', 'testSetDigest'], { evaluatorId: 'a' }), /Identity fields/);
  assert.throws(() => bindIdentity(['evaluatorId', 'testSetDigest'], { evaluatorId: 'a', testSetDigest: 'b', extra: true }), /Identity fields/);
  const exact = bindIdentity(['evaluatorId', 'testSetDigest'], { testSetDigest: 'b', evaluatorId: 'a' });
  assert.equal(exact.matches({ evaluatorId: 'a', testSetDigest: 'b' }), true);
  assert.equal(exact.matches({ evaluatorId: 'other', testSetDigest: 'b' }), false);
  assert.equal(exact.matches({ evaluatorId: 'a', testSetDigest: 'b', checkerId: 'conditions-v1' }), false);
  assert.equal(uniqueManifest(['public-message', 'public-message']), false);
  assert.equal(uniqueManifest(['public-message', 'graph-message']), true);
  assert.equal(sameManifest(['public-message'], ['public-message', 'extra-message']), false);
});
