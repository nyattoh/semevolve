import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, manifest, value, formation } from './helpers.mjs';

function record(f, id, actualCost, { runId = 'run-1', phase = 'task' } = {}) {
  return value(f.sender.recordMeasurement({ runId, eventId: id, occurrenceId: id, messageId: null, recipientId: null, phase, direction: 'output', category: 'request', text: null, textRef: null, providerUsage: null, startedAt: null, endedAt: null, actualCost, sourceRef: 'synthetic-cost-' + id }));
}
function cost(id, amount, currency, runId = 'run-1') {
  return { runId, eventId: id, sourceRef: 'synthetic-cost-' + id, amount, currency };
}

test('M1 actualCost is null only when selected cost evidence is absent', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  assert.equal(value(f.sender.reportM1({ manifestId: 'task-manifest' })).actualCost, null);
  record(f, 'unknown', null);
  assert.equal(value(f.sender.reportM1({ manifestId: 'task-manifest' })).actualCost, null);
  record(f, 'known', { amount: 1.25, currency: 'USD' });
  const report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.deepEqual(report.actualCost, [cost('known', 1.25, 'USD')]);
  assert.equal(report.measurements.find(e => e.eventId === 'unknown').actualCost, null);
  assert.equal(report.providerInternalContext, null);
});

test('M1 actualCost preserves known zero and separate currencies without conversion', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  record(f, 'zero', { amount: 0, currency: 'USD' });
  record(f, 'yen', { amount: 120, currency: 'JPY' });
  record(f, 'dollar', { amount: 0.5, currency: 'USD' });
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'task-manifest' })).actualCost, [cost('zero', 0, 'USD'), cost('yen', 120, 'JPY'), cost('dollar', 0.5, 'USD')]);
});

test('M1 actualCost selects linked formation once and excludes unrelated runs', t => {
  const f = setup(t);
  formation(f);
  value(f.sender.captureM1(manifest({ formationManifestId: 'formation-manifest' })));
  value(f.sender.importRecords([{ kind: 'run', value: { id: 'other-run', taskId: 'other-task', condition: 'internal', languageVersion: 'synthetic-v1', actors: ['sender@canary', 'receiver@canary'], modelSettings: null, rerunOf: null, formationRunId: null } }]));
  record(f, 'formation-cost', { amount: 2, currency: 'USD' }, { runId: 'formation-run', phase: 'v0_formation' });
  record(f, 'task-cost', { amount: 3, currency: 'USD' });
  record(f, 'task-cost', { amount: 3, currency: 'USD' });
  record(f, 'unrelated-cost', { amount: 999, currency: 'USD' }, { runId: 'other-run' });
  const expected = [cost('formation-cost', 2, 'USD', 'formation-run'), cost('task-cost', 3, 'USD')];
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'task-manifest' })).actualCost, expected);
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'task-manifest' })).actualCost, expected);
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'formation-manifest' })).actualCost, [cost('formation-cost', 2, 'USD', 'formation-run')]);
});

test('M1 saved report retains its recorded costs after later measurements', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  record(f, 'first', { amount: 4, currency: 'GBP' });
  const closed = value(f.sender.captureM1({ kind: 'close', id: 'closed-cost', manifestId: 'task-manifest', sourceRef: 'synthetic-close-cost' }));
  assert.deepEqual(closed.report.actualCost, [cost('first', 4, 'GBP')]);
  record(f, 'later', { amount: 6, currency: 'GBP' });
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'task-manifest', snapshotId: 'closed-cost' })), closed);
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'task-manifest' })).actualCost, [cost('first', 4, 'GBP'), cost('later', 6, 'GBP')]);
});
