import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ready, value } from './helpers.mjs';

const run = (id, actors, condition, formationRunId = null) => ({ kind: 'run', value: { id, taskId: 'privacy-canary', condition, languageVersion: 'synthetic-v1', actors, modelSettings: null, rerunOf: null, formationRunId } });
const event = (runId, patch = {}) => ({ runId, eventId: 'task-event', occurrenceId: 'task-occurrence', messageId: null, recipientId: null, phase: 'task', direction: 'output', category: 'request', text: 'Hello, world!', textRef: 'visible-task-text', providerUsage: null, startedAt: '2026-01-01T00:00:10.000Z', endedAt: '2026-01-01T00:00:11.000Z', actualCost: null, sourceRef: 'visible-task-observation', ...patch });
const hidden = () => event('private-formation', { eventId: 'HIDDEN_EVENT', occurrenceId: 'HIDDEN_OCCURRENCE', phase: 'v0_formation', category: 'language_introduction', text: 'HIDDEN_FORMATION_TEXT', textRef: 'HIDDEN_TEXT_REF', sourceRef: 'HIDDEN_SOURCE', providerUsage: { inputTokens: 900, outputTokens: 901, totalTokens: 1801 }, startedAt: '2026-02-02T00:00:00.000Z', endedAt: '2026-02-02T00:00:03.000Z' });
function fixture(t) {
  const f = ready(t);
  value(f.sender.importRecords([
    run('private-formation', ['sender@canary'], 'formation'),
    run('visible-task', ['receiver@canary'], 'internal', 'private-formation'),
  ]));
  value(f.receiver.recordMeasurement(event('visible-task')));
  return f;
}
function assertPrivate(report) {
  const json = JSON.stringify(report);
  for (const secret of ['HIDDEN_', 'sender@canary', '2026-02-02', '1801']) assert.equal(json.includes(secret), false);
  assert.deepEqual(report.events.map(e => e.runId), ['visible-task']);
}

test('authorised task totals remain available while referenced private formation stays unknown and undisclosed', t => {
  const f = fixture(t);
  value(f.sender.recordMeasurement(hidden()));
  const report = value(f.receiver.measurements({ runIds: ['visible-task'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 4, tokensWithFormation: null, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: null });
  assert.equal(report.phases.task.tokens, 4);
  assert.deepEqual(report.phases.v0_formation, { occurrences: 0, tokens: null, elapsedMs: null, mismatches: 0 });
  assert.equal(report.elapsedUnionMs, null);
  assert.equal(report.processingMsWithoutPasteWaiting, null);
  assertPrivate(report);
});

test('a private formation with and without measurements produces the same visible report', t => {
  const f = fixture(t);
  const before = value(f.receiver.measurements({ runIds: ['visible-task'] }));
  value(f.sender.recordMeasurement(hidden()));
  const after = value(f.receiver.measurements({ runIds: ['visible-task', 'visible-task'] }));
  assert.deepEqual(after, before);
  assertPrivate(after);
});

test('directly selected unauthorised runs remain rejected, including mixed selections', t => {
  const f = fixture(t);
  value(f.sender.recordMeasurement(hidden()));
  assert.equal(f.receiver.measurements({ runIds: ['private-formation'] }).error.code, 'unauthorised');
  assert.equal(f.receiver.measurements({ runIds: ['visible-task', 'private-formation'] }).error.code, 'unauthorised');
  assert.equal(f.other.measurements({ runIds: ['visible-task'] }).error.code, 'unauthorised');
  assert.equal(value(f.receiver.measurements({ runIds: ['visible-task'] })).comparison.tokensWithoutFormation, 4);
});

test('mixed visible and private formation preserves known zero, deduplication and privacy', t => {
  const f = ready(t);
  value(f.sender.importRecords([
    run('private-formation', ['sender@canary'], 'formation'),
    run('public-formation', ['receiver@canary'], 'formation'),
    run('task-a', ['receiver@canary'], 'internal', 'public-formation'),
    run('task-b', ['receiver@canary'], 'internal', 'private-formation'),
  ]));
  value(f.sender.recordMeasurement(hidden()));
  for (const id of ['public-formation', 'task-a', 'task-b']) {
    const item = event(id, { text: '', phase: id === 'public-formation' ? 'v0_formation' : 'task', category: id === 'public-formation' ? 'language_introduction' : 'request', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.000Z' });
    value(f.receiver.recordMeasurement(item));
    value(f.receiver.recordMeasurement(item));
  }
  const report = value(f.receiver.measurements({ runIds: ['task-a', 'task-b', 'task-a'] }));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 0, tokensWithFormation: null, elapsedMsWithoutFormation: 0, elapsedMsWithFormation: null });
  assert.equal(report.events.length, 3);
  assert.equal(JSON.stringify(report).includes('HIDDEN_'), false);
  assert.deepEqual(value(f.receiver.measurements({ runIds: ['task-a'] })).comparison, { tokensWithoutFormation: 0, tokensWithFormation: 0, elapsedMsWithoutFormation: 0, elapsedMsWithFormation: 0 });
});

test('CLI returns task-only aggregates without admitting a direct private run selection', t => {
  const f = fixture(t);
  value(f.sender.recordMeasurement(hidden()));
  const input = join(mkdtempSync(join(tmpdir(), 'semevolve-private-formation-cli-')), 'selection.json');
  const read = (runIds, exit) => {
    writeFileSync(input, JSON.stringify({ runIds }));
    const response = spawnSync(process.execPath, [resolve('apps/cli/dist/hub-cli.js'), 'measurements', '--authority', f.options[1].authorityPath, '--context', f.options[1].contextPath, '--input', input], { encoding: 'utf8' });
    assert.equal(response.status, exit, response.stderr + response.stdout);
    return JSON.parse(response.stdout);
  };
  const report = value(read(['visible-task'], 0));
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 4, tokensWithFormation: null, elapsedMsWithoutFormation: 1000, elapsedMsWithFormation: null });
  assertPrivate(report);
  assert.equal(read(['private-formation'], 2).error.code, 'unauthorised');
});
