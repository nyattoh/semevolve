import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { ready, value, message } from './helpers.mjs';

const translation = { id: 'translation-1', sourceMessageId: 'message-1', runId: 'run-1', languageVersion: 'synthetic-v1', targetLanguage: 'ja', text: '合成の原文A', sourceRef: 'external-synthetic-text' };

test('provided translation preserves the original and all references across reopen', t => {
  const f = ready(t);
  value(f.sender.send(message));
  const expected = { ...translation, authorId: 'receiver@canary', meaningVerified: false };
  assert.deepEqual(value(f.receiver.translate(translation)), [expected]);
  assert.deepEqual(value(f.receiver.translate(translation)), [expected]);
  assert.deepEqual(value(f.sender.translate({ sourceMessageId: 'message-1' })), [expected]);
  assert.equal(f.receiver.translate({ ...translation, text: '別文' }).error.code, 'conflict');
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
  f.receiver.close();
  const reopened = value(createHub(f.options[1]));
  assert.deepEqual(value(reopened.translate({ sourceMessageId: 'message-1' })), [expected]);
  reopened.close();
});

test('unknown source and mismatched run or version cannot create translations', t => {
  const f = ready(t);
  assert.equal(f.receiver.translate(translation).error.code, 'unknown_message');
  value(f.sender.send(message));
  assert.equal(f.receiver.translate({ ...translation, runId: 'unknown' }).error.code, 'source_mismatch');
  assert.equal(f.receiver.translate({ ...translation, languageVersion: 'unknown' }).error.code, 'source_mismatch');
  assert.equal(f.receiver.translate({ ...translation, text: {} }).error.code, 'invalid_input');
  assert.deepEqual(value(f.receiver.translate({ sourceMessageId: 'message-1' })), []);
  assert.equal(value(f.receiver.inbox())[0].body, 'M0_SYNTHETIC_A');
});

test('translation and inspection do not expose messages to a third participant', t => {
  const f = ready(t);
  value(f.sender.send({ ...message, recipients: ['receiver@canary'] }));
  assert.equal(f.other.translate(translation).error.code, 'unauthorised');
  assert.equal(f.other.translate({ sourceMessageId: 'message-1' }).error.code, 'unauthorised');
  assert.deepEqual(value(f.other.inspect()).messages, []);
  assert.deepEqual(value(f.receiver.translate(translation)).map(x => x.meaningVerified), [false]);
});
