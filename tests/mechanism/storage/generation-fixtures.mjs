import assert from 'node:assert/strict';
import { digestJson } from '@semevolve/core';
import { mapping, original, take, rows, clausePayload } from './fixtures.mjs';
import { migrationRequest, targetMapping } from './migration-fixtures.mjs';

export async function generations(f, oldLast = true) {
  const old = 'synthetic-old-projection';
  const oldKey = digestJson([old, 'message-1', targetMapping]);
  const next = Array.from({ length: 100 }, (_, i) => `synthetic-new-projection-${i}`).find(id => {
    const keys = ['message-1', 'message-2'].map(message => digestJson([id, message, targetMapping]));
    return oldLast ? keys.every(key => key < oldKey) : keys.some(key => key > oldKey);
  });
  assert.ok(next, 'Finite deterministic generation fixture must satisfy the requested key order');
  const real = f.options.identity.newId;
  const ids = [old, next];
  f.options.identity.newId = kind => kind === 'storage-generation' && ids.length ? ids.shift() : real(kind);
  take(await f.runtime.migration.prepare(await migrationRequest(f)));
  await f.append('host.originals', 'message-2', original('message-2'));
  take(await f.runtime.store('message-2', mapping()));
  take(await f.runtime.migration.catchUp('migration-1', (await f.snapshot()).revision));
  const snapshot = await f.snapshot();
  const receipts = rows(snapshot, 'storage.operations').filter(r => r.kind === 'receipt' && ['copy', 'catch_up'].includes(r.operation));
  assert.equal(receipts.find(r => r.generation === old).pass, true);
  assert.equal(receipts.find(r => r.generation === next).pass, true);
  assert.ok(receipts.find(r => r.generation === old).revision < receipts.find(r => r.generation === next).revision);
  assert.equal(take(await f.runtime.head()).mappingId, 'M1');
  return { old, next, receipts };
}

export function assertLatest(result) {
  const units = take(result);
  assert.deepEqual(units.map(u => u.source.messageId).sort(), ['message-1', 'message-2'], 'B1_LATEST_CONFIRMED_GENERATION');
  for (const unit of units) {
    assert.deepEqual(unit.versions, targetMapping.versions);
    assert.deepEqual(unit.representation.meaning, clausePayload);
    assert.deepEqual(unit.eventRefs, []);
    assert.deepEqual(unit.interpretationRefs, []);
    assert.deepEqual(unit.checkRefs, []);
    assert.equal(unit.source.location.kind, 'range');
  }
  return units;
}
