import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { fixture, value } from './helpers.mjs';

const language = { kind: 'language', value: { id: 'synthetic-v1', definition: 'Synthetic transport canary only.', sourceRef: 'synthetic-source' } };
const run = { kind: 'run', value: { id: 'run-1', taskId: 'canary', condition: 'canary', languageVersion: 'synthetic-v1', actors: ['sender@canary', 'receiver@canary'], modelSettings: null, rerunOf: null, formationRunId: null } };

test('imports immutable language and run records, preserves missing metadata and reopens', t => {
  const f = fixture(t);
  value(f.sender.join());
  assert.deepEqual(value(f.sender.importRecords([language, run])), { imported: 2 });
  assert.deepEqual(value(f.sender.importRecords([language, run])), { imported: 2 });
  const view = value(f.sender.inspect());
  assert.deepEqual(view.languages, [language.value]);
  assert.deepEqual(view.runs, [{ ...run.value, status: 'prepared' }]);
  f.sender.close();
  const reopened = value(createHub(f.options[0]));
  assert.deepEqual(value(reopened.inspect()).runs, [{ ...run.value, status: 'prepared' }]);
  reopened.close();
});

test('batch import rolls back on unknown references, collisions or invalid bind shapes', t => {
  const f = fixture(t);
  value(f.sender.join());
  assert.equal(f.sender.importRecords([language, { ...run, value: { ...run.value, languageVersion: 'missing' } }]).error.code, 'unknown_language');
  assert.deepEqual(value(f.sender.inspect()).languages, []);
  value(f.sender.importRecords([language, run]));
  assert.equal(f.sender.importRecords([{ ...language, value: { ...language.value, definition: 'REPLACED' } }]).error.code, 'conflict');
  assert.equal(f.sender.importRecords([{ ...run, value: { ...run.value, languageVersion: 'other' } }]).ok, false);
  assert.equal(f.sender.importRecords([{ ...run, value: { ...run.value, id: { sql: 'x' } } }]).error.code, 'invalid_input');
  assert.equal(f.sender.importRecords([{ ...run, value: { ...run.value, id: 'unknown-actor', actors: ['unknown@canary'] } }]).error.code, 'unknown_actor');
  assert.equal(value(f.sender.inspect()).languages[0].definition, 'Synthetic transport canary only.');
  assert.equal(value(f.sender.inspect()).runs[0].languageVersion, 'synthetic-v1');
});

test('worker and unjoined sessions cannot import or expand run scope', t => {
  const f = fixture(t);
  assert.equal(f.sender.importRecords([language]).error.code, 'not_joined');
  value(f.receiver.join());
  assert.equal(f.receiver.importRecords([language]).error.code, 'unauthorised');
  assert.deepEqual(value(f.receiver.inspect()).fixtures, []);
});

test('generic private fixture import computes hashes and rejects altered claimed hashes', t => {
  const f = fixture(t);
  value(f.sender.join());
  const definition = { id: 'public-canary', input: 'Return the literal CANARY.', successCriteria: ['The response is CANARY.'], intentChecks: ['literal'], roles: { sender: 'sender@canary', recipients: ['receiver@canary'] }, modelSettings: null, limits: { processingSeconds: 12, correctionRounds: 1 } };
  assert.deepEqual(value(f.sender.importRecords([{ kind: 'fixture', value: definition }])), { imported: 1 });
  const saved = value(f.sender.inspect()).fixtures[0];
  assert.equal(saved.input, 'Return the literal CANARY.');
  assert.match(saved.inputHash, /^[a-f0-9]{64}$/u);
  assert.match(saved.successCriteriaHash, /^[a-f0-9]{64}$/u);
  assert.match(saved.fixtureHash, /^[a-f0-9]{64}$/u);
  assert.equal(f.sender.importRecords([{ kind: 'fixture', value: { ...definition, fixtureHash: '0'.repeat(64) } }]).error.code, 'hash_mismatch');
  value(f.receiver.join());
  assert.deepEqual(value(f.receiver.inspect()).fixtures, []);
});
