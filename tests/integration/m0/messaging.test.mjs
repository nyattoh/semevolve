import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { ready, value, message } from './helpers.mjs';

test('send stores the whole envelope once and rejects changed content without losing the original', t => {
  const f = ready(t);
  const saved = value(f.sender.send(message));
  assert.deepEqual(saved, { ...message, recipients: ['other@canary', 'receiver@canary'], sender: 'sender@canary' });
  assert.deepEqual(value(f.sender.send(message)), saved);
  for (const patch of [{ body: 'M0_SYNTHETIC_B' }, { recipients: ['receiver@canary'] }, { kind: 'result' }]) {
    assert.equal(f.sender.send({ ...message, ...patch }).error.code, 'conflict');
  }
  assert.equal(f.receiver.send(message).error.code, 'conflict');
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
  f.receiver.close();
  const reopened = value(createHub(f.options[1]));
  assert.deepEqual(value(reopened.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
  reopened.close();
});

test('inbox rejects another recipient even when empty', t => {
  const f = ready(t);
  assert.deepEqual(value(f.receiver.inbox()), []);
  assert.equal(f.sender.inbox({ recipientId: 'receiver@canary' }).error.code, 'unauthorised');
  value(f.sender.send(message));
  assert.deepEqual(value(f.sender.inbox()), []);
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.id), ['message-1']);
});

test('ack rejects unknown messages and third parties without mutating a delivery', t => {
  const f = ready(t);
  assert.equal(f.receiver.ack({ messageId: 'missing' }).error.code, 'unknown_message');
  value(f.sender.send(message));
  assert.equal(f.sender.ack({ messageId: 'message-1' }).error.code, 'unauthorised');
  assert.equal(f.sender.ack({ messageId: 'message-1', recipientId: 'receiver@canary' }).error.code, 'unauthorised');
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
});

test('ack belongs to one recipient and does not set applied, understanding or completion', t => {
  const f = ready(t);
  value(f.sender.send(message));
  const ack = value(f.receiver.ack({ messageId: 'message-1' }));
  assert.equal(ack.messageId, 'message-1');
  assert.equal(ack.recipientId, 'receiver@canary');
  assert.equal(ack.appliedAt, null);
  assert.equal(ack.understanding, null);
  assert.equal(ack.taskCompletion, null);
  assert.equal(ack.evaluation, null);
  assert.deepEqual(value(f.receiver.ack({ messageId: 'message-1' })), ack);
  assert.deepEqual(value(f.receiver.inbox()), []);
  assert.deepEqual(value(f.other.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
  assert.equal(value(f.sender.inspect()).runs[0].status, 'prepared');
});

test('leave retains pending deliveries across reopen and rejoins the same context', t => {
  const f = ready(t);
  value(f.sender.send(message));
  value(f.other.leave());
  assert.equal(f.other.inbox().error.code, 'not_joined');
  f.other.close();
  const reopened = value(createHub(f.options[2]));
  value(reopened.join());
  assert.deepEqual(value(reopened.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
  reopened.close();
});

test('invalid body and bind shapes, unknown actors and run versions leave inbox empty', t => {
  const f = ready(t);
  for (const patch of [{ body: null }, { body: {} }, { body: false }, { id: {} }, { recipients: [null] }]) {
    assert.equal(f.sender.send({ ...message, ...patch }).error.code, 'invalid_input');
  }
  assert.equal(f.sender.send({ ...message, recipients: ['unknown@canary'] }).error.code, 'unknown_actor');
  assert.equal(f.sender.send({ ...message, runId: 'missing' }).error.code, 'unknown_run');
  assert.equal(f.sender.send({ ...message, languageVersion: 'missing' }).error.code, 'language_mismatch');
  assert.equal(f.sender.send({ ...message, sender: 'other@canary' }).error.code, 'unauthorised');
  assert.deepEqual(value(f.receiver.inbox()), []);
  value(f.sender.send({ ...message, body: "literal '); DROP TABLE records; --" }));
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.body), ["literal '); DROP TABLE records; --"]);
});

test('a worker cannot increase the recipients fixed on its run', t => {
  const f = ready(t);
  value(f.sender.importRecords([{ kind: 'run', value: { id: 'restricted-run', taskId: 'restricted', condition: 'canary', languageVersion: 'synthetic-v1', actors: ['sender@canary', 'receiver@canary'], modelSettings: null, rerunOf: null, formationRunId: null } }]));
  assert.equal(f.receiver.send({ ...message, runId: 'restricted-run', recipients: ['other@canary'] }).error.code, 'unauthorised');
  assert.deepEqual(value(f.other.inbox()), []);
});
