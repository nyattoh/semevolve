import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { fixture, value } from './helpers.mjs';

test('join and leave persist their own participant state across reopen without implying completion', t => {
  const f = fixture(t);
  assert.deepEqual(value(f.sender.join()), { actorId: 'sender@canary', state: 'joined' });
  assert.deepEqual(value(f.sender.join()), { actorId: 'sender@canary', state: 'joined' });
  assert.deepEqual(value(f.sender.leave()), { actorId: 'sender@canary', state: 'left' });
  f.sender.close();
  const reopened = value(createHub(f.options[0]));
  assert.deepEqual(value(reopened.leave()), { actorId: 'sender@canary', state: 'left' });
  assert.deepEqual(value(reopened.join()), { actorId: 'sender@canary', state: 'joined' });
  reopened.close();
});

test('a bound session cannot join as another actor or connection', t => {
  const f = fixture(t);
  assert.equal(f.sender.join({ id: 'receiver@canary' }).error.code, 'unauthorised');
  assert.equal(f.sender.join({ id: 'sender@canary', connectionRef: 'different-connection' }).error.code, 'conflict');
  assert.equal(f.sender.join({ sessionRef: 'different-session' }).error.code, 'conflict');
  assert.equal(f.sender.join({ role: 'worker' }).error.code, 'invalid_input');
  assert.deepEqual(value(f.sender.join({ id: 'sender@canary', connectionRef: 'conn-s', sessionRef: 'session-s' })), { actorId: 'sender@canary', state: 'joined' });
});
