import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { mapping, take, rows } from './fixtures.mjs';
import { certifiedRecording } from './recording-evaluation-fixtures.mjs';

test('L-rem a stored-message replay refuses withdrawal during its final eligibility read', async t => {
  const f = await certifiedRecording(); t.after(() => f.store.close()); const before = await f.snapshot(); let reads = 0;
  const runtime = createStoragePlanner({ ...f.options, async inspectionEligibility(...args) {
    const result = await f.options.inspectionEligibility(...args);
    if (++reads === 2) await f.withdraw();
    return result;
  } });
  const result = await runtime.store('message-1', mapping());
  assert.equal(result.ok, false, 'L_REM_REPLAY_CURRENT_ELIGIBILITY');
  assert.equal(result.error.code, 'revision_conflict');
  assert.deepEqual(rows(await f.snapshot(), 'storage.heads'), rows(before, 'storage.heads'));
  assert.deepEqual(rows(await f.snapshot(), 'storage.derived'), rows(before, 'storage.derived'));
  assert.equal((await f.runtime.retrieve({ all: true }, mapping())).ok, false);
});
