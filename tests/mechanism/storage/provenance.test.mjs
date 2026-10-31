import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '@semevolve/core';
import { fixture, original, mapping, rule, structure, take, reject, rows } from './fixtures.mjs';

test('L1 preserves the original Envelope, separate payload digest and immutable version definitions', async () => {
  const f = await fixture();
  await f.versions();
  const saved = take(await f.runtime.recordOriginal('message-1'));
  assert.deepEqual(saved, original(), 'L1_ORIGINAL_PRESERVED');
  assert.notEqual(saved.payloadDigest, saved.message.digest);
  assert.equal(saved.payloadDigest, digestJson(saved.message.envelope.payload));
  const before = await f.snapshot();
  take(await f.runtime.recordOriginal('message-1'));
  take(await f.runtime.registerRule(rule()));
  take(await f.runtime.registerMapping(mapping()));
  assert.deepEqual(await f.snapshot(), before);
  reject(await f.runtime.registerRule({ ...rule(), definition: { different: true } }), 'id_collision');
  reject(await f.runtime.registerStructure({ ...structure(), definition: 'different' }), 'id_collision');
  reject(await f.runtime.registerMapping({ ...mapping(), conformanceRefs: ['new-check'] }), 'id_collision');
  assert.deepEqual(rows(await f.snapshot(), 'storage.originals'), [saved]);
  assert.deepEqual(take(await f.runtime.trace('message-1')).originals, [saved]);
  await f.store.close();
});

test('L1 rejects tampered digests, foreign tasks and unresolved actual-event references', async () => {
  for (const change of [o => { o.payloadDigest = digestJson('wrong'); }, o => { o.message.digest = digestJson('wrong'); }, o => { o.message.envelope.task_id = 'other-task'; o.message.digest = digestJson(o.message.envelope); }, o => { o.eventRefs = ['missing-event']; }]) {
    const f = await fixture({ seed: false });
    const o = original(); change(o);
    await f.append('host.originals', 'message-1', o);
    reject(await f.runtime.recordOriginal('message-1'));
    assert.deepEqual(rows(await f.snapshot(), 'storage.originals'), []);
    await f.store.close();
  }
});

test('L1 keeps independent many-to-many version mappings without inferring conformance', async () => {
  const f = await fixture();
  await f.registerLanguage('L2');
  for (const m of [mapping(), mapping('M2', 'L1', 'R1', 'S2'), mapping('M3', 'L2', 'R2', 'S1')]) {
    await f.versions(m);
    reject(await f.runtime.store('message-1', m), 'unavailable');
  }
  assert.equal(rows(await f.snapshot(), 'storage.mappings').length, 3);
  reject(await f.runtime.registerMapping(mapping('bad', 'missing')), 'unavailable');
  assert.deepEqual(take(await f.runtime.head()), null);
  await f.store.close();
});
