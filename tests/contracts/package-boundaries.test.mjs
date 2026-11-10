import assert from 'node:assert/strict';
import test from 'node:test';
import { boundaryIssues, workspaceBoundaryIssues } from '../../scripts/check-package-boundaries.mjs';

const pkg = (name, deps = []) => ({ name, dependencies: Object.fromEntries(deps.map(d => [d, '0.0.0'])) });

test('packages may depend on core only; apps may depend on packages', () => {
  assert.deepEqual(boundaryIssues('packages/policy', pkg('@semevolve/policy', ['@semevolve/core'])), []);
  assert.deepEqual(boundaryIssues('apps/cli', pkg('@semevolve/cli', ['@semevolve/policy', 'gpt-tokenizer'])), []);
  assert.deepEqual(
    boundaryIssues('packages/policy', pkg('@semevolve/policy', ['@semevolve/registry-peer'])).length, 1);
  assert.deepEqual(boundaryIssues('packages/core', pkg('@semevolve/core', ['@semevolve/policy'])).length, 1);
});

test('nothing may depend on an app', () => {
  assert.equal(boundaryIssues('apps/local-ui', pkg('@semevolve/local-ui', ['@semevolve/cli'])).length, 1);
  assert.equal(boundaryIssues('packages/evaluator', pkg('@semevolve/evaluator', ['@semevolve/cli'])).length, 1);
});

test('source may not reach into another workspace by relative path', () => {
  assert.deepEqual(workspaceBoundaryIssues('packages/policy/src/a.ts', "import { x } from './b.js';"), []);
  assert.equal(workspaceBoundaryIssues('packages/policy/src/a.ts', "import { x } from '../../core/src/index.js';").length, 1);
  assert.equal(workspaceBoundaryIssues('apps/cli/src/a.ts', "export * from '../../../packages/core/src/x.js';").length, 1);
});
