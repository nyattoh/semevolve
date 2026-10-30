import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub, tokenise } from '../../../apps/cli/dist/hub.js';
import { ready, value, message } from './helpers.mjs';

const stamp = seconds => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
const event = { runId: 'run-1', eventId: 'event-1', occurrenceId: 'occurrence-1', messageId: null, recipientId: null, phase: 'task', direction: 'output', category: 'request', text: 'Hello, world!', textRef: 'synthetic-literal', providerUsage: null, startedAt: stamp(0), endedAt: stamp(10), actualCost: null, sourceRef: 'synthetic-observation' };

test('fixed cl100k_base encodes literal Unicode text, not character counts or provider usage', () => {
  assert.deepEqual(value(tokenise('Hello, world!')).tokenIds, [9906, 11, 1917, 0]);
  assert.deepEqual(value(tokenise('日本語')).tokenIds, [9080, 22656, 45918, 252]);
  assert.deepEqual(value(tokenise('M0_SYNTHETIC_A')).tokenIds, [44, 15, 76762, 3701, 1372, 1341, 1596]);
  assert.equal(value(tokenise('日本語')).tokens, 4);
  assert.equal(value(tokenise('')).tokens, 0);
  assert.equal(tokenise({ text: 'wrong' }).error.code, 'invalid_input');
});

test('measurement IDs and occurrences deduplicate, distinct occurrences count, provider usage stays separate', t => {
  const f = ready(t);
  const first = value(f.sender.recordMeasurement(event));
  assert.equal(first.tokens, 4);
  assert.equal(first.providerUsage, null);
  assert.equal(first.actualCost, null);
  assert.deepEqual(value(f.sender.recordMeasurement(event)), first);
  assert.deepEqual(value(f.sender.recordMeasurement({ ...event, eventId: 'duplicate-import' })), first);
  assert.equal(f.sender.recordMeasurement({ ...event, text: 'different' }).error.code, 'conflict');
  assert.equal(f.sender.recordMeasurement({ ...event, eventId: 'other-event', text: 'different' }).error.code, 'conflict');
  const second = { ...event, eventId: 'event-2', occurrenceId: 'occurrence-2', providerUsage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }, startedAt: stamp(5), endedAt: stamp(15) };
  value(f.sender.recordMeasurement(second));
  const report = value(f.sender.measurements({ runIds: ['run-1', 'run-1'] }));
  assert.equal(report.events.length, 2);
  assert.deepEqual(report.phases.task, { occurrences: 2, tokens: 8, elapsedMs: 15000, mismatches: 0 });
  assert.equal(report.events[1].providerUsage.totalTokens, 300);
  f.sender.close();
  const reopened = value(createHub(f.options[0]));
  assert.equal(value(reopened.measurements({ runIds: ['run-1'] })).events.length, 2);
  reopened.close();
});

test('input measurement and recipient application commit once without setting an ack', t => {
  const f = ready(t);
  value(f.sender.send(message));
  const input = { ...event, direction: 'input', messageId: 'message-1', recipientId: 'receiver@canary', text: 'M0_SYNTHETIC_A' };
  assert.equal(f.sender.recordMeasurement(input).error.code, 'unauthorised');
  assert.equal(f.receiver.recordMeasurement({ ...input, text: 'wrong text' }).error.code, 'source_mismatch');
  assert.equal(value(f.receiver.inspect()).deliveries[0].appliedAt, null);
  const saved = value(f.receiver.recordMeasurement(input));
  assert.equal(saved.tokens, 7);
  assert.deepEqual(value(f.receiver.recordMeasurement(input)), saved);
  const applied = value(f.receiver.inspect()).deliveries[0];
  assert.equal(applied.ackedAt, null);
  assert.equal(applied.understanding, null);
  assert.equal(typeof applied.appliedAt, 'string');
  assert.equal(value(f.receiver.measurements({ runIds: ['run-1'] })).events.length, 1);
  assert.equal(value(f.receiver.inbox()).length, 1);
});

test('missing values remain null; distinct mismatch events count independently', t => {
  const f = ready(t);
  const unknown = { ...event, text: null, textRef: null, startedAt: null, endedAt: null, direction: 'none', category: 'mismatch' };
  assert.equal(value(f.sender.recordMeasurement(unknown)).tokens, null);
  value(f.sender.recordMeasurement(unknown));
  value(f.sender.recordMeasurement({ ...unknown, eventId: 'event-2', occurrenceId: 'occurrence-2' }));
  const report = value(f.sender.measurements({ runIds: ['run-1'] }));
  assert.deepEqual(report.phases.task, { occurrences: 2, tokens: null, elapsedMs: null, mismatches: 2 });
  assert.equal(report.phases.revision.tokens, null);
  assert.equal(report.phases.revision.elapsedMs, null);
});

test('five phases stay separate, interval union excludes overlapping paste waiting, formation is added once', t => {
  const f = ready(t);
  const run = (id, condition, formationRunId) => ({ kind: 'run', value: { id, taskId: 'synthetic-phases', condition, languageVersion: 'synthetic-v1', actors: ['sender@canary', 'receiver@canary'], modelSettings: null, rerunOf: null, formationRunId } });
  value(f.sender.importRecords([run('formation', 'formation', null), run('internal-1', 'internal', 'formation'), run('internal-2', 'internal', 'formation')]));
  assert.equal(f.sender.recordMeasurement({ ...event, phase: 'v0_formation' }).error.code, 'phase_mismatch');
  const records = [
    { ...event, runId: 'formation', phase: 'v0_formation', category: 'language_introduction', startedAt: stamp(0), endedAt: stamp(3) },
    { ...event, runId: 'internal-1', startedAt: stamp(10), endedAt: stamp(20) },
    { ...event, runId: 'internal-2', startedAt: stamp(15), endedAt: stamp(25) },
    { ...event, runId: 'internal-1', eventId: 'rev', occurrenceId: 'rev', phase: 'revision', category: 'correction', startedAt: stamp(20), endedAt: stamp(30) },
    { ...event, runId: 'internal-1', eventId: 'human', occurrenceId: 'human', phase: 'human_translation', category: 'translation', startedAt: stamp(30), endedAt: stamp(35) },
    { ...event, runId: 'internal-1', eventId: 'wait', occurrenceId: 'wait', phase: 'paste_waiting', direction: 'none', category: 'waiting', text: null, textRef: null, startedAt: stamp(12), endedAt: stamp(18) },
  ];
  records.forEach(r => value(f.sender.recordMeasurement(r)));
  const report = value(f.sender.measurements({ runIds: ['internal-1', 'internal-2', 'internal-1'] }));
  assert.deepEqual(report.formationRunIds, ['formation']);
  assert.deepEqual(report.comparison, { tokensWithoutFormation: 12, tokensWithFormation: 16, elapsedMsWithoutFormation: 20000, elapsedMsWithFormation: 23000 });
  assert.equal(report.phases.task.elapsedMs, 15000);
  assert.equal(report.phases.revision.tokens, 4);
  assert.equal(report.phases.human_translation.tokens, 4);
  assert.equal(report.phases.paste_waiting.elapsedMs, 6000);
  assert.equal(report.processingMsWithoutPasteWaiting, 22000);
  assert.equal(report.elapsedUnionMs, 28000);
});

test('invalid timing, SQL bind values and unknown measurement references leave no events', t => {
  const f = ready(t);
  for (const patch of [{ text: {} }, { eventId: [] }, { endedAt: stamp(0), startedAt: stamp(1) }, { providerUsage: { totalTokens: -1 } }, { phase: 'unknown' }]) {
    assert.equal(f.sender.recordMeasurement({ ...event, ...patch }).error.code, 'invalid_input');
  }
  assert.equal(f.sender.recordMeasurement({ ...event, runId: 'missing' }).error.code, 'unknown_run');
  assert.equal(f.sender.recordMeasurement({ ...event, messageId: 'missing' }).error.code, 'unknown_message');
  assert.deepEqual(value(f.sender.measurements({ runIds: ['run-1'] })).events, []);
});
