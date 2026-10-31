import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input, value } from './support/fixture.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileTaskStore } from '@semevolve/core';

test('capture commits a detached snapshot before the independent answer and disclosure', { timeout: 30000 }, async () => {
  const { runtime, store } = fixture();
  const source = input();
  const captured = await runtime.captureInput(source);
  const snapshot = value(await store.snapshot());
  assert.equal(snapshot.entries.filter(e => e.key.collection === 'evaluator.inputs').length, 1, 'capture must be durably recorded');
  const copy = value(captured);
  source.payload.text = 'mutated';
  source.sharedContext.current = 99;
  assert.equal(copy.payload.text, 'candidate');
  const answer = { certainty: 'candidate' };
  const interpretation = value(await runtime.recordAnswer({ messageId: source.messageId, receiverId: source.receiverId, answer }));
  answer.certainty = 'certain';
  assert.deepEqual(interpretation.answer, { certainty: 'candidate' });
  assert.equal(interpretation.expectedConditionsDisclosedAt, null);
  const disclosed = value(await runtime.recordDisclosure(source));
  assert.match(disclosed.expectedConditionsDisclosedAt, /Z$/);
  assert.equal((await runtime.recordAnswer({ ...source, answer: { certainty: 'certain' } })).error.code, 'invalid_input');
  const entries = value(await store.snapshot()).entries;
  assert.equal(entries.filter(e => e.key.collection === 'evaluator.answers').length, 1);
  assert.equal(entries.filter(e => e.key.collection === 'evaluator.disclosures').length, 1);
});

test('disclosure without an answer and caller-supplied chronology are rejected', { timeout: 30000 }, async () => {
  const { runtime } = fixture();
  assert.equal((await runtime.recordDisclosure(input())).error.code, 'invalid_input');
  value(await runtime.captureInput(input()));
  const a = value(await runtime.recordAnswer({ ...input(), answer: { certainty: 'candidate' }, recordedAt: '1900-01-01T00:00:00.000Z' }));
  assert.notEqual(a.recordedAt, '1900-01-01T00:00:00.000Z');
  assert.deepEqual(value(await runtime.recordAnswer({ ...input(), answer: a.answer })), a);
  assert.equal((await runtime.recordAnswer({ ...input(), answer: { certainty: 'certain' } })).error.code, 'id_collision');
});

test('input identity and payload are captured before the first await', { timeout: 30000 }, async () => {
  const { runtime, store } = fixture();
  const source = input();
  const waiting = runtime.captureInput(source);
  source.messageId = 'forged'; source.receiverId = 'forged'; source.payload.text = 'forged';
  assert.equal(value(await waiting).messageId, 'public-message');
  const request = { ...input(), answer: { certainty: 'candidate' } };
  const pending = runtime.recordAnswer(request);
  request.messageId = 'forged'; request.answer.certainty = 'certain';
  const saved = value(await pending);
  assert.equal(saved.messageId, 'public-message');
  assert.deepEqual(saved.answer, { certainty: 'candidate' });
  assert.equal(value(await store.snapshot()).entries.filter(e => e.key.collection === 'evaluator.answers').length, 1);
});

test('file reopen preserves the exact answer and refuses changed run configuration', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-e-input-'));
  const store = await openFileTaskStore(directory);
  const first = fixture({ store });
  value(await first.runtime.captureInput(input()));
  const answer = value(await first.runtime.recordAnswer({ ...input(), answer: { certainty: 'candidate' } }));
  await store.close();
  const reopened = await openFileTaskStore(directory);
  const second = fixture({ store: reopened });
  assert.deepEqual(value(await second.runtime.recordAnswer({ ...input(), answer: answer.answer })), answer);
  const changed = fixture({ store: reopened, run: { ...second.run, evaluatorVersion: 'changed' } });
  assert.equal((await changed.runtime.captureInput(input())).error.code, 'id_collision');
  await reopened.close();
});
