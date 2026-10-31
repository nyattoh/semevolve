import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { ready, value } from './helpers.mjs';

const stamp = seconds => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
const run = (id, condition = 'canary', formationRunId = null) => ({ kind: 'run', value: { id, taskId: 'coverage-canary', condition, languageVersion: 'synthetic-v1', actors: ['sender@canary'], modelSettings: null, rerunOf: null, formationRunId } });
const event = (runId, patch = {}) => ({ runId, eventId: 'event', occurrenceId: 'occurrence', messageId: null, recipientId: null, phase: 'task', direction: 'output', category: 'request', text: 'Hello, world!', textRef: 'synthetic-literal', providerUsage: null, startedAt: stamp(10), endedAt: stamp(11), actualCost: null, sourceRef: 'synthetic-observation', ...patch });
const formation = id => event(id, { phase: 'v0_formation', category: 'language_introduction', startedAt: stamp(0), endedAt: stamp(1) });

test('missing referenced formation nulls inclusive totals but preserves measured task totals', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('formation', 'formation'), run('task', 'internal', 'formation')]));
  value(f.sender.recordMeasurement(event('task')));
  const report = value(f.sender.measurements({ runIds: ['task'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 4, tokensWithFormation: null, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: null });
  assert.deepEqual(report.phases.task, { occurrences: 1, tokens: 4, elapsedMs: 1000, mismatches: 0 });
  assert.deepEqual(report.phases.v0_formation, { occurrences: 0, tokens: null, elapsedMs: null, mismatches: 0 });
  assert.equal(report.elapsedUnionMs, null);
  assert.equal(report.processingMsWithoutPasteWaiting, null);
});

test('a missing selected task nulls affected totals without erasing other measured phases', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('formation', 'formation'), run('known', 'internal', 'formation'), run('missing')]));
  [formation('formation'), event('known'),
    event('known', { eventId: 'revision', occurrenceId: 'revision', phase: 'revision', category: 'correction', startedAt: stamp(20), endedAt: stamp(21) }),
    event('known', { eventId: 'translation', occurrenceId: 'translation', phase: 'human_translation', category: 'translation', startedAt: stamp(30), endedAt: stamp(31) }),
    event('known', { eventId: 'waiting', occurrenceId: 'waiting', phase: 'paste_waiting', category: 'waiting', direction: 'none', text: null, textRef: null, startedAt: stamp(40), endedAt: stamp(41) }),
  ].forEach(e => value(f.sender.recordMeasurement(e)));
  const report = value(f.sender.measurements({ runIds: ['known', 'missing', 'missing'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: null, tokensWithFormation: null, elapsedMsWithoutFormation: null, elapsedMsWithFormation: null });
  assert.deepEqual(report.phases.task, { occurrences: 1, tokens: null, elapsedMs: null, mismatches: 0 });
  assert.deepEqual(report.phases.v0_formation, { occurrences: 1, tokens: 4, elapsedMs: 1000, mismatches: 0 });
  assert.deepEqual(report.phases.revision, { occurrences: 1, tokens: 4, elapsedMs: 1000, mismatches: 0 });
  assert.deepEqual(report.phases.human_translation, { occurrences: 1, tokens: 4, elapsedMs: 1000, mismatches: 0 });
  assert.equal(report.phases.paste_waiting.elapsedMs, 1000);
  assert.equal(report.elapsedUnionMs, null);
  assert.equal(report.processingMsWithoutPasteWaiting, null);
});

test('one missing formation among two cannot disappear behind a known formation subtotal', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('known-formation', 'formation'), run('missing-formation', 'formation'), run('task-a', 'internal', 'known-formation'), run('task-b', 'internal', 'missing-formation')]));
  [formation('known-formation'), event('task-a'), event('task-b')].forEach(e => value(f.sender.recordMeasurement(e)));
  const report = value(f.sender.measurements({ runIds: ['task-a', 'task-b'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 8, tokensWithFormation: null, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: null });
  assert.deepEqual(report.phases.v0_formation, { occurrences: 1, tokens: null, elapsedMs: null, mismatches: 0 });
  assert.equal(report.phases.task.tokens, 8);
});

test('explicitly selected missing formation is also covered, without changing the task subtotal', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('formation', 'formation'), run('task')]));
  value(f.sender.recordMeasurement(event('task')));
  const report = value(f.sender.measurements({ runIds: ['task', 'formation'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 4, tokensWithFormation: null, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: null });
  assert.equal(report.phases.task.tokens, 4);
});

test('recorded zero tokens and zero duration remain known zero with duplicate selections', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('formation', 'formation'), run('task', 'internal', 'formation')]));
  const records = [formation('formation'), event('task')].map(e => ({ ...e, text: '', startedAt: stamp(0), endedAt: stamp(0) }));
  records.forEach(e => { value(f.sender.recordMeasurement(e)); value(f.sender.recordMeasurement(e)); });
  const report = value(f.sender.measurements({ runIds: ['task', 'formation', 'task'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 0, tokensWithFormation: 0, elapsedMsWithoutFormation: 0, elapsedMsWithFormation: 0 });
  assert.equal(report.elapsedUnionMs, 0);
  assert.equal(report.processingMsWithoutPasteWaiting, 0);
  assert.equal(report.phases.task.tokens, 0);
  assert.equal(report.phases.v0_formation.tokens, 0);
  assert.equal(report.events.length, 2);
});

test('complete coverage preserves union, phase separation and a formation counted once', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('formation', 'formation'), run('a', 'internal', 'formation'), run('b', 'internal', 'formation'), run('unselected')]));
  const records = [
    { ...formation('formation'), endedAt: stamp(3) },
    event('a', { startedAt: stamp(10), endedAt: stamp(20) }),
    event('b', { startedAt: stamp(15), endedAt: stamp(25) }),
    event('a', { eventId: 'revision', occurrenceId: 'revision', phase: 'revision', category: 'correction', startedAt: stamp(20), endedAt: stamp(30) }),
    event('a', { eventId: 'translation', occurrenceId: 'translation', phase: 'human_translation', category: 'translation', startedAt: stamp(30), endedAt: stamp(35) }),
    event('a', { eventId: 'waiting', occurrenceId: 'waiting', phase: 'paste_waiting', category: 'waiting', direction: 'none', text: null, textRef: null, startedAt: stamp(12), endedAt: stamp(18) }),
  ];
  records.forEach(e => { value(f.sender.recordMeasurement(e)); value(f.sender.recordMeasurement(e)); });
  const report = value(f.sender.measurements({ runIds: ['a', 'b', 'a', 'formation'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 12, tokensWithFormation: 16, elapsedMsWithoutFormation: 20000, elapsedMsWithFormation: 23000 });
  assert.deepEqual(report.formationRunIds, ['formation']);
  assert.equal(report.elapsedUnionMs, 28000);
  assert.equal(report.processingMsWithoutPasteWaiting, 22000);
  assert.equal(report.phases.human_translation.tokens, 4);
  assert.equal(report.phases.paste_waiting.elapsedMs, 6000);
  assert.equal(report.events.length, 6);
});

test('CLI and SQLite reopen retain missing coverage until a formation measurement is recorded', t => {
  const f = ready(t);
  value(f.sender.importRecords([run('formation', 'formation'), run('task', 'internal', 'formation')]));
  value(f.sender.recordMeasurement(event('task')));
  f.sender.close();
  const input = join(mkdtempSync(join(tmpdir(), 'semevolve-coverage-cli-')), 'selection.json');
  writeFileSync(input, JSON.stringify({ runIds: ['task'] }));
  const read = () => {
    const response = spawnSync(process.execPath, [resolve('apps/cli/dist/hub-cli.js'), 'measurements', '--authority', f.options[0].authorityPath, '--context', f.options[0].contextPath, '--input', input], { encoding: 'utf8' });
    assert.equal(response.status, 0, response.stderr + response.stdout);
    return value(JSON.parse(response.stdout));
  };
  assert.deepEqual(read().comparison, { tokensWithoutFormation: 4, tokensWithFormation: null, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: null });
  const reopened = value(createHub(f.options[0]));
  value(reopened.recordMeasurement(formation('formation')));
  reopened.close();
  assert.deepEqual(read().comparison, { tokensWithoutFormation: 4, tokensWithFormation: 8, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: 2000 });
});
