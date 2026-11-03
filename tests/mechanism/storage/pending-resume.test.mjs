import assert from 'node:assert/strict';
import test from 'node:test';
import { mapping, take, rows } from './fixtures.mjs';
import { targetMapping } from './migration-fixtures.mjs';
import { pending, request } from './pending-fixtures.mjs';

for (const operation of ['switch', 'restore']) test(`B2 explicitly resumes the same ${operation} intent after response loss`, async t => {
  const f = await pending(operation); t.after(() => f.store.close());
  const before = await f.snapshot();
  const result = await f.runtime.migration[operation](request(f, operation, before.revision));
  assert.equal(result.ok, true, `B2_RESUME_${operation.toUpperCase()} ${JSON.stringify(result)}`);
  assert.equal(result.value.pendingOperation, null);
  const after = await f.snapshot();
  const state = rows(after, 'storage.migrations')[0];
  assert.equal(state.intent, f.pendingState.intent);
  assert.equal(state.phase, operation === 'switch' ? 'switched' : 'restored');
  assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'receipt' && r.executionId === state.intent).length, 1);
  const units = take(await f.runtime.retrieve({ all: true }, operation === 'switch' ? targetMapping : mapping()));
  assert.deepEqual(units.map(u => u.source.messageId).sort(), operation === 'switch' ? ['message-1'] : ['message-1', 'message-2']);
  assert.deepEqual(rows(after, 'host.tasks'), rows(before, 'host.tasks'));
  assert.deepEqual(take(await f.runtime.migration.reconcile('migration-1')), result.value);
  assert.deepEqual(await f.snapshot(), after);
});
