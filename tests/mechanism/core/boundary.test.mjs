import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as core from '@semevolve/core';

const at = '2026-01-01T00:00:00.000Z';
const deadline = '2026-01-01T01:00:00.000Z';
const envelope = () => ({
  protocol_version: '0.1', message_id: 'message-1', task_id: 'task-1', epoch_id: 'epoch-1',
  sender_id: 'peer-a', recipient_ids: ['peer-b'], kind: 'utterance', language_version_id: 'language-1',
  context_revision: 0, causation_ids: [], content_type: 'text/plain', payload: '否定、条件、unknownを保持。', created_at: at,
});
const context = () => ({
  taskId: 'task-1', recipientId: 'peer-b', authenticatedSenderId: 'peer-a', participantIds: ['peer-a', 'peer-b'],
  epoch: { epochId: 'epoch-1', taskId: 'task-1', language: { mode: 'bound', languageVersionId: 'language-1' },
    contextRevision: 0, openedAt: at, sendsClosedAt: null }, now: at, deadline, maxBytes: 4096,
});

test('canonical JSON sorts UTF-16 keys including integer-like keys and hashes UTF-8', () => {
  const input = { z: [-0, true, null, 'é'], '2': 2, '10': 10, '\ue000': 1, '😀': { b: 2, a: 1 } };
  const expected = '{"10":10,"2":2,"z":[0,true,null,"é"],"😀":{"a":1,"b":2},"\ue000":1}';
  assert.equal(core.canonicalJson(input), expected);
  assert.equal(core.hostIdentity.digest(input), createHash('sha256').update(expected, 'utf8').digest('hex'));
  assert.equal(core.hostIdentity.digest(null), '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b');
  assert.notEqual(core.hostIdentity.digest('é'), core.hostIdentity.digest('e\u0301'));
});

for (const [name, value] of [
  ['undefined', undefined], ['NaN', NaN], ['infinity', Infinity], ['bigint', 1n], ['function', () => 1],
  ['date', new Date(0)], ['map', new Map()], ['sparse', new Array(2)], ['nested undefined', { a: undefined }],
  ['symbol', Symbol('x')], ['symbol key', { [Symbol('x')]: 1 }],
  ['array property', Object.assign([1], { extra: 1 })], ['accessor', { get x() { throw Error('must not run'); } }],
  ['non-enumerable', Object.defineProperty({}, 'x', { value: 1 })],
]) test(`canonical JSON rejects ${name}`, () => assert.throws(() => core.canonicalJson(value), /JSON/u));

test('canonical JSON rejects cycles but permits repeated acyclic values', () => {
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => core.canonicalJson(cycle), /JSON/u);
  const shared = { x: 1 };
  assert.equal(core.canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
});

test('host produces distinct typed IDs and a real UTC timestamp', () => {
  const before = Date.now();
  const ids = Array.from({ length: 100 }, () => core.hostIdentity.newId('execution'));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^execution-[0-9a-f-]{36}$/u);
  const now = core.hostIdentity.now();
  assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.ok(Date.parse(now) >= before && Date.parse(now) <= Date.now());
});

test('Envelope accepts exact bytes, copies its input, and hashes every field', () => {
  const input = envelope();
  const wire = JSON.stringify(input);
  const c = { ...context(), maxBytes: Buffer.byteLength(wire) };
  const parsed = core.parseEnvelope(wire, c);
  assert.deepEqual(parsed, { ok: true, value: { envelope: input, digest: core.hostIdentity.digest(input) } });
  input.payload = 'changed';
  assert.notEqual(parsed.value.envelope.payload, input.payload);
  const next = core.parseEnvelope(JSON.stringify(input), context());
  assert.notEqual(next.value.digest, parsed.value.digest);
  assert.deepEqual(core.parseEnvelope(wire, { ...c, maxBytes: c.maxBytes - 1 }), { ok: false, error: 'oversize' });
});

for (const [name, patch, error] of [
  ['protocol', { protocol_version: '2' }, 'protocol_mismatch'], ['task', { task_id: 'other' }, 'task_mismatch'],
  ['recipient', { recipient_ids: ['peer-a'] }, 'recipient_mismatch'], ['sender', { sender_id: 'peer-b' }, 'sender_mismatch'],
  ['unregistered recipient', { recipient_ids: ['peer-b', 'intruder'] }, 'participant_denied'],
  ['epoch', { epoch_id: 'old' }, 'epoch_mismatch'], ['context', { context_revision: 1 }, 'context_mismatch'],
  ['language', { language_version_id: 'other' }, 'language_mismatch'], ['null language', { language_version_id: null }, 'language_mismatch'],
  ['empty recipients', { recipient_ids: [] }, 'invalid_format'], ['duplicate recipients', { recipient_ids: ['peer-b', 'peer-b'] }, 'invalid_format'],
  ['fractional revision', { context_revision: 0.5 }, 'invalid_format'], ['unsafe revision', { context_revision: 2 ** 53 }, 'invalid_format'],
  ['invalid date', { created_at: '2026-02-30T00:00:00.000Z' }, 'invalid_format'], ['offset date', { created_at: '2026-01-01T09:00:00+09:00' }, 'invalid_format'],
  ['future', { created_at: deadline }, 'invalid_format'], ['empty ID', { message_id: '' }, 'invalid_format'],
  ['unknown kind', { kind: 'execute' }, 'invalid_format'], ['unknown field', { authority: 'admin' }, 'invalid_format'],
]) test(`Envelope rejects ${name}`, () => {
  assert.deepEqual(core.parseEnvelope(JSON.stringify({ ...envelope(), ...patch }), context()), { ok: false, error });
});

test('Envelope rejects malformed input, invalid UTF-8, and missing fields', () => {
  for (const raw of ['{', 'null', '[]', '{}', Buffer.from([0xff])]) {
    assert.deepEqual(core.parseEnvelope(raw, context()), { ok: false, error: 'invalid_format' });
  }
});

for (const member of ['"task_id":"wrong"', '"payload":"wrong"', '"payload":"否定、条件、unknownを保持。"', '"ta\\u0073k_id":"wrong"']) {
  for (const bytes of [false, true]) test(`F2 rejects duplicate decoded member ${member}, bytes=${bytes}`, () => {
    const wire = `{${member},${JSON.stringify(envelope()).slice(1)}`;
    assert.deepEqual(core.parseEnvelope(bytes ? Buffer.from(wire) : wire, context()), { ok: false, error: 'invalid_format' });
  });
}

test('F2 accepts unique escaped names and JSON-looking payload strings', () => {
  const value = { ...envelope(), payload: '"task_id":"a", "task_id":"b"; braces {} [] and \\ slash' };
  const wire = JSON.stringify(value).replace('"task_id":', '"ta\\u0073k_id":');
  assert.deepEqual(core.parseEnvelope(wire, context()), { ok: true, value: { envelope: value, digest: core.digestJson(value) } });
});

test('F4 Envelope distinguishes digest mismatch from malformed input', () => {
  const input = envelope();
  const digest = core.digestJson(input);
  assert.equal(core.parseEnvelope(JSON.stringify(input), context(), digest).ok, true);
  assert.deepEqual(core.parseEnvelope(JSON.stringify({ ...input, payload: 'changed' }), context(), digest),
    { ok: false, error: 'digest_mismatch' });
  assert.deepEqual(core.parseEnvelope('{', context(), digest), { ok: false, error: 'invalid_format' });
  assert.deepEqual(core.parseEnvelope(`{"task_id":"wrong",${JSON.stringify(input).slice(1)}`, context(), digest),
    { ok: false, error: 'invalid_format' });
  assert.equal(core.parseEnvelope(JSON.stringify({ ...input, payload: 'changed' }), context()).ok, true);
});

test('Envelope enforces trusted task, participant, epoch, deadline and bootstrap context', () => {
  const input = JSON.stringify(envelope());
  assert.deepEqual(core.parseEnvelope(input, { ...context(), participantIds: ['peer-b'] }), { ok: false, error: 'participant_denied' });
  assert.deepEqual(core.parseEnvelope(input, { ...context(), now: deadline }), { ok: false, error: 'expired' });
  assert.deepEqual(core.parseEnvelope(input, { ...context(), epoch: { ...context().epoch, taskId: 'other' } }), { ok: false, error: 'task_mismatch' });
  assert.deepEqual(core.parseEnvelope(input, { ...context(), epoch: { ...context().epoch, sendsClosedAt: at } }), { ok: false, error: 'epoch_mismatch' });
  const bootstrap = { ...context(), epoch: { ...context().epoch, language: { mode: 'bootstrap', languageVersionId: null } } };
  const unbound = { ...envelope(), language_version_id: null };
  assert.equal(core.parseEnvelope(JSON.stringify(unbound), bootstrap).ok, true);
  assert.deepEqual(core.parseEnvelope(input, bootstrap), { ok: false, error: 'language_mismatch' });
});
