import assert from 'node:assert/strict';
import test from 'node:test';
import { publicArtifactIssues } from '../../scripts/check-public-artifacts.mjs';

test('public artifact check distinguishes public synthetic data from private artifacts', () => {
  assert.deepEqual(publicArtifactIssues('tests/support/synthetic.json', '{"visibility":"public_synthetic"}'), []);
  for (const path of ['runs/p0/result.json', 'local.db', '.env', 'evaluation/hidden/oracle.json', 'logs/result.txt']) {
    assert.deepEqual(publicArtifactIssues(path, '{}'), ['private or generated file']);
  }
});

test('public artifact check rejects local paths and secret-shaped content without printing it', () => {
  const local = ['Z:', 'Users', 'synthetic', 'private'].join(String.fromCharCode(92));
  assert.deepEqual(publicArtifactIssues('docs/example.md', local), ['local absolute path']);
  const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  assert.deepEqual(publicArtifactIssues('docs/example.md', key), ['credential pattern']);
});
