import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { setup, manifest, value, event, send, request, understanding, permit, resultMessage } from './helpers.mjs';
import { DatabaseSync } from 'node:sqlite';

test('C2 manifest is immutable, PM-only, cloned and retained on reopen', t => {
  const f = setup(t);
  const input = manifest();
  const saved = value(f.sender.captureM1(input));
  assert.equal(saved.id, 'task-manifest');
  saved.actors[0].sessionRef = 'mutated';
  assert.equal(value(f.sender.captureM1(input)).actors[0].sessionRef, 'session-s');
  assert.equal(f.sender.captureM1({ ...input, sourceRef: 'changed' }).error.code, 'conflict');
  assert.equal(f.receiver.captureM1(input).error.code, 'unauthorised');
  assert.equal(f.receiver.reportM1({ manifestId: input.id }).error.code, 'unauthorised');
  f.sender.close();
  const reopened = value(createHub(f.options[0]));
  t.after(() => reopened.close());
  assert.equal(value(reopened.captureM1(input)).actors[0].sessionRef, 'session-s');
});

test('C1 prior three-part understanding gates disclosure and outcome, without writes', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  request(f);
  value(f.receiver.ack({ messageId: 'request-message' }));
  const disclosure = event('disclosure', 'permit', { understandingId: 'understanding-event', purpose: 'execution_or_correction', privateAnswerIncluded: false });
  assert.equal(f.sender.captureM1(disclosure).error.code, 'm1_order_violation');
  assert.equal(f.sender.captureM1(event('outcome', 'outcome', {})).error.code, 'm1_order_violation');
  send(f, 'understanding-message', 'understanding', 'Compute sum. Read operands. No uncertainty.', true);
  const partial = event('understanding', 'understanding-event', { requestId: 'request-event', paraphrase: 'Compute sum.', firstAction: 'Read operands.', uncertaintyEvidence: 'No uncertainty.' }, { actorId: 'receiver@canary', messageId: 'understanding-message' });
  assert.equal(f.sender.captureM1(partial).error.code, 'm1_order_violation');
  const answer = value(f.sender.captureM1({ ...partial, data: { ...partial.data, uncertainties: [] } }));
  assert.deepEqual(answer.data.uncertainties, []);
  assert.equal(value(f.sender.captureM1(disclosure)).data.understandingId, 'understanding-event');
  assert.equal(value(f.sender.captureM1(disclosure)).id, 'permit');
  assert.equal(f.sender.captureM1({ ...disclosure, sourceRef: 'different' }).error.code, 'conflict');
  assert.equal(f.sender.captureM1({ ...disclosure, id: 'leak', data: { ...disclosure.data, privateAnswerIncluded: true } }).error.code, 'm1_order_violation');
  const db = new DatabaseSync(f.prepared.databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='m1_event'").get().n, 3);
  db.close();
});

test('C2 wrong actor/run/version and early generic results cannot establish valid stages', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  request(f);
  send(f, 'wrong', 'understanding', 'Compute sum. Read operands. None.');
  const input = event('understanding', 'u', { requestId: 'request-event', paraphrase: 'Compute sum.', firstAction: 'Read operands.', uncertainties: [], uncertaintyEvidence: 'None.' }, { actorId: 'receiver@canary', messageId: 'wrong' });
  assert.equal(f.sender.captureM1(input).error.code, 'source_mismatch');
  assert.equal(f.sender.captureM1({ ...input, runId: 'other-run' }).error.code, 'source_mismatch');
  assert.equal(f.sender.captureM1({ ...input, languageVersion: 'other-version' }).error.code, 'source_mismatch');
  understanding(f);
  send(f, 'early-result', 'result', '4', true);
  assert.equal(f.sender.captureM1(event('disclosure', 'permit', { understandingId: 'understanding-event', purpose: 'execution_or_correction', privateAnswerIncluded: false })).error.code, 'm1_order_violation');
});

test('C1 result requires an execution message persisted after the permit receipt', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  request(f); understanding(f);
  send(f, 'premature-execute', 'request', 'Execute.');
  permit(f);
  assert.equal(f.sender.captureM1(event('boundary', 'bad-execute', { stage: 'execution', disclosureId: 'permit' }, { messageId: 'premature-execute' })).error.code, 'm1_order_violation');
  assert.equal(resultMessage(f).data.executionId, 'execute-event');
});
