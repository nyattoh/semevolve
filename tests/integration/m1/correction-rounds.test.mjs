import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../../../apps/cli/dist/hub.js';
import { HubStore, canonical } from '../../../apps/cli/dist/hub-store.js';
import { participants, manifest, value, event, send, request, understanding, permit, resultMessage } from './helpers.mjs';

function memoryFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA database_list').get().file, '');
  db.exec(`
    CREATE TABLE metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE principals (id TEXT PRIMARY KEY, profile TEXT NOT NULL, secret_hash TEXT NOT NULL, os_binding TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('provisioned','joined','left'))) STRICT;
    CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT;
    CREATE TABLE deliveries (message_id TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES principals(id), acked_at TEXT, applied_at TEXT, PRIMARY KEY(message_id,recipient_id)) STRICT;
  `);
  for (const p of participants) db.prepare('INSERT INTO principals VALUES (?,?,?,?,?)').run(p.id, canonical(p), '-', '-', 'joined');
  const hubs = participants.map(p => new Hub(new HubStore(db, p)));
  const f = { db, sender: hubs[0], receiver: hubs[1], other: hubs[2] };
  value(f.sender.importRecords([
    { kind: 'language', value: { id: 'synthetic-v1', definition: 'Synthetic protocol canary.', sourceRef: 'synthetic' } },
    { kind: 'run', value: { id: 'run-1', taskId: 'synthetic-loop', condition: 'canary', languageVersion: 'synthetic-v1', actors: participants.map(p => p.id), modelSettings: null, rerunOf: null, formationRunId: null } },
  ]));
  value(f.sender.captureM1(manifest()));
  request(f); understanding(f); permit(f);
  return f;
}
function correctionInput(round, overrides = {}) {
  return event('boundary', 'correction-event-' + round, { stage: 'correction', disclosureId: 'permit' }, { messageId: 'correction-message-' + round, ...overrides });
}
function correction(f, round) {
  send(f, 'correction-message-' + round, 'correction', 'Revise the synthetic instruction.');
  return value(f.sender.captureM1(correctionInput(round)));
}
function echoInput(round, requestId, overrides = {}) {
  return event('understanding', 'echo-event-' + round, { requestId, paraphrase: 'Compute sum.', firstAction: 'Read operands.', uncertainties: [], uncertaintyEvidence: 'No uncertainty.' }, { actorId: 'receiver@canary', messageId: 'echo-message-' + round, ...overrides });
}
function echoMessage(f, round, receiver = true) {
  send(f, 'echo-message-' + round, 'understanding', 'Compute sum. Read operands. No uncertainty.', receiver);
}
function echo(f, round, requestId = 'correction-event-' + round) {
  echoMessage(f, round);
  return value(f.sender.captureM1(echoInput(round, requestId)));
}
function rounds(t, count) {
  const f = memoryFixture(t);
  for (let i = 1; i <= count; i++) { correction(f, i); echo(f, i); }
  return f;
}
function eventCount(f) { return Number(f.db.prepare("SELECT count(*) AS n FROM records WHERE kind='m1_event'").get().n); }
function refuses(f, input, code = 'm1_order_violation') {
  const before = eventCount(f);
  const attempt = f.sender.captureM1(input);
  assert.equal(attempt.ok, false, JSON.stringify(attempt));
  assert.equal(attempt.error.code, code);
  assert.equal(eventCount(f), before);
}

for (const count of [0, 1, 2]) {
  test('correction loop records every step with ' + count + ' corrections', t => {
    const f = rounds(t, count);
    resultMessage(f);
    const report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
    const expected = ['request-event', 'understanding-event', 'permit'];
    for (let i = 1; i <= count; i++) expected.push('correction-event-' + i, 'echo-event-' + i);
    expected.push('execute-event', 'result-event');
    assert.deepEqual(report.observationIds, expected);
    assert.equal(report.observations.filter(e => e.kind === 'understanding').length, count + 1);
    assert.equal(report.observations.filter(e => e.data.stage === 'correction').length, count);
    assert.deepEqual(report.protocol.violations, []);
    for (let i = 1; i <= count; i++) assert.equal(report.observations.find(e => e.id === 'echo-event-' + i).data.requestId, 'correction-event-' + i);
  });
  test('correction loop rejects a second understanding in round ' + count, t => {
    const f = rounds(t, count);
    echoMessage(f, 90);
    refuses(f, echoInput(90, count ? 'correction-event-' + count : 'request-event'));
  });
}

test('correction loop rejects a third correction without storing an event', t => {
  const f = rounds(t, 2);
  send(f, 'correction-message-3', 'correction', 'Third synthetic correction.');
  refuses(f, correctionInput(3));
});

test('correction loop requires understanding before the next correction', t => {
  const f = memoryFixture(t); correction(f, 1);
  send(f, 'correction-message-2', 'correction', 'Second synthetic correction.');
  refuses(f, correctionInput(2));
});

test('correction loop requires understanding before execution', t => {
  const f = memoryFixture(t); correction(f, 1);
  send(f, 'early-execute', 'request', 'Execute before the updated understanding.');
  refuses(f, event('boundary', 'early-execution', { stage: 'execution', disclosureId: 'permit' }, { messageId: 'early-execute' }));
});

test('correction loop rejects understanding linked to the stale initial request', t => {
  const f = memoryFixture(t); correction(f, 1); echoMessage(f, 1);
  refuses(f, echoInput(1, 'request-event'));
});

test('correction loop rejects understanding linked to the previous correction', t => {
  const f = rounds(t, 1); correction(f, 2); echoMessage(f, 2);
  refuses(f, echoInput(2, 'correction-event-1'));
});

test('correction loop rejects understanding sent before its correction receipt', t => {
  const f = memoryFixture(t);
  send(f, 'correction-message-1', 'correction', 'Synthetic correction.');
  echoMessage(f, 1);
  value(f.sender.captureM1(correctionInput(1)));
  refuses(f, echoInput(1, 'correction-event-1'));
});

test('correction loop rejects an execution message sent before the latest understanding', t => {
  const f = memoryFixture(t); correction(f, 1);
  send(f, 'premature-execute', 'request', 'Execute.');
  echo(f, 1);
  refuses(f, event('boundary', 'premature-execution', { stage: 'execution', disclosureId: 'permit' }, { messageId: 'premature-execute' }));
});

test('correction loop rejects a duplicate correction receipt under a distinct ID', t => {
  const f = rounds(t, 1);
  refuses(f, correctionInput(1, { id: 'duplicate-correction-receipt' }));
});

test('correction loop rejects a result before execution', t => {
  const f = memoryFixture(t);
  send(f, 'early-result', 'result', 'Synthetic early result.', true);
  refuses(f, event('boundary', 'early-result-receipt', { stage: 'result', executionId: 'missing-execution' }, { actorId: 'receiver@canary', messageId: 'early-result' }));
});

for (const stage of ['request', 'understanding', 'correction', 'execution', 'result']) {
  test('correction loop rejects protocol step after result: ' + stage, t => {
    const f = rounds(t, 0); resultMessage(f);
    if (stage === 'understanding') {
      echoMessage(f, 99); refuses(f, echoInput(99, 'request-event')); return;
    }
    const receiver = stage === 'result';
    send(f, 'after-result-message', stage === 'correction' ? 'correction' : receiver ? 'result' : 'request', 'Synthetic late step.', receiver);
    const data = stage === 'execution' || stage === 'correction' ? { stage, disclosureId: 'permit' } : stage === 'result' ? { stage, executionId: 'execute-event' } : { stage };
    refuses(f, event('boundary', 'after-result-event', data, { actorId: receiver ? 'receiver@canary' : 'sender@canary', messageId: 'after-result-message' }));
  });
}

test('correction loop preserves one disclosure and the private answer guard', t => {
  const f = rounds(t, 1);
  refuses(f, event('disclosure', 'duplicate-permit', { understandingId: 'echo-event-1', purpose: 'execution_or_correction', privateAnswerIncluded: false }));
  refuses(f, event('disclosure', 'private-permit', { understandingId: 'echo-event-1', purpose: 'execution_or_correction', privateAnswerIncluded: true }));
});

test('correction loop preserves source actor checks after a correction', t => {
  const f = memoryFixture(t); correction(f, 1); echoMessage(f, 1, false);
  refuses(f, echoInput(1, 'correction-event-1'), 'source_mismatch');
});

test('correction loop preserves exact ID replay after terminal result', t => {
  const f = rounds(t, 2); resultMessage(f);
  const before = eventCount(f);
  assert.equal(value(f.sender.captureM1(correctionInput(1))).id, 'correction-event-1');
  assert.equal(value(f.sender.captureM1(echoInput(2, 'correction-event-2'))).id, 'echo-event-2');
  assert.equal(eventCount(f), before);
});

test('correction loop still permits outcome audit after terminal result', t => {
  const f = rounds(t, 2); resultMessage(f);
  value(f.sender.captureM1(event('outcome', 'synthetic-outcome', { status: 'success', resultId: 'result-event', evaluatorId: 'synthetic-operator', rubricHash: 'b'.repeat(64), literal: { expected: { answer: 4 }, observed: { answer: 4 }, evidenceRef: 'synthetic-literal' }, intentChecks: [{ id: 'synthetic-intent', status: 'pass', evidenceRef: 'synthetic-check', messageId: 'result-message' }], stopReason: null })));
  assert.equal(value(f.sender.reportM1({ manifestId: 'task-manifest' })).outcome.status, 'success');
});
