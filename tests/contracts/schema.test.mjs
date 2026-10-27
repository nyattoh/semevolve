import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';
import { validateAcceptance } from '../../scripts/check-acceptance.mjs';

const schema = JSON.parse(readFileSync(new URL('../../evaluation/manifests/acceptance.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
const unrun = JSON.parse(readFileSync(new URL('../support/acceptance-unrun.json', import.meta.url), 'utf8'));

test('acceptance schema refuses an empty ledger', () => {
  assert.equal(validate({}), false);
});
test('acceptance schema refuses a fabricated passing record without evidence', () => {
  assert.equal(validate({ schema_version: '0.1', stage: 'P0', visibility: 'public_synthetic', entries: [{ at_id: 'AT-01', mechanism_verdict: 'pass' }] }), false);
});

test('all 34 registered ATs remain unrun and match the authoritative names and owners', () => {
  assert.deepEqual(validateAcceptance(unrun), { valid: true, errors: [] });
  assert.equal(unrun.entries.filter((entry) => entry.mechanism_verdict === 'not_run').length, 34);
  const specification = readFileSync(new URL('../../04_EVALUATION.md', import.meta.url), 'utf8');
  const plan = readFileSync(new URL('../../docs/plan/P0.md', import.meta.url), 'utf8');
  for (const entry of unrun.entries) {
    assert.ok(specification.includes(`| ${entry.at_id} | ${entry.title} |`));
    assert.ok(plan.includes(`| ${entry.at_id} | ${entry.title} | ${entry.owners.join('、')} |`));
  }
});

test('ledger rejects missing and duplicate AT IDs', () => {
  const missing = structuredClone(unrun);
  missing.entries.pop();
  assert.equal(validateAcceptance(missing).valid, false);
  const duplicate = structuredClone(unrun);
  duplicate.entries[1] = duplicate.entries[0];
  assert.equal(validateAcceptance(duplicate).valid, false);
});

test('executed results require a head, a nonempty run and evidence hashes', () => {
  const run = structuredClone(unrun);
  Object.assign(run.entries[0], { mechanism_verdict: 'pass', head: 'a'.repeat(40), not_run_reason: null,
    evidence: { command: 'synthetic-test-only', exit_code: 0, test_count: 1,
      input_digest: 'b'.repeat(64), artifact: 'synthetic-example.json', artifact_digest: 'c'.repeat(64) } });
  assert.equal(validateAcceptance(run).valid, true);
  run.entries[0].evidence.test_count = 0;
  assert.equal(validateAcceptance(run).valid, false);
  run.entries[0].evidence.test_count = 1;
  run.entries[0].evidence.exit_code = 1;
  assert.equal(validateAcceptance(run).valid, false);
  run.entries[0].evidence.exit_code = 0;
  run.entries[0].head = null;
  assert.equal(validateAcceptance(run).valid, false);
});

test('AT-19 isolation is recorded separately from mechanism results', () => {
  const run = structuredClone(unrun);
  assert.equal(run.entries[18].isolation_verdict, 'unverified');
  run.entries[18].isolation_verdict = 'not_applicable';
  assert.equal(validateAcceptance(run).valid, false);
  run.entries[18].isolation_verdict = 'fail';
  assert.equal(validateAcceptance(run).valid, true);
  run.entries[0].isolation_verdict = 'pass';
  assert.equal(validateAcceptance(run).valid, false);
});

test('schema rejects arbitrary status, owner and additional fields', () => {
  for (const patch of [{ mechanism_verdict: 'skipped' }, { owners: ['AI'] }, { secret: 'public canary' }, { not_run_reason: '' }]) {
    const run = structuredClone(unrun);
    Object.assign(run.entries[0], patch);
    assert.equal(validateAcceptance(run).valid, false);
  }
});
