import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createEvaluator } from '@semevolve/evaluator';
import { fixture, identity, request, value } from './support/fixture.mjs';
import { projectionFixture, projectionRequest, rehash, verdicts } from './support/storage-projection.mjs';

async function referenced(change) {
  const f = projectionFixture();
  const checkRun = fixture({ store: f.store, run: { ...fixture().run, runId: 'public-reference-run' } });
  const body = '{"cause":"X"}';
  const evidence = change({ evidenceId: 'public-reference', source: 'public-synthetic', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'retrieved', body, digest: createHash('sha256').update(body).digest('hex'), retrievedAt: identity.now() } });
  const input = await request(checkRun, 'factuality', { cause: 'X' }, [evidence]);
  const check = value(await checkRun.runtime.evaluate(input));
  const req = projectionRequest(f);
  req.original.originals[0].checkRefs = [check.result.checkId];
  req.retrieved.units[0].checkRefs = [check.result.checkId];
  const canonical = rehash(req);
  const result = value(await f.runtime.evaluateStorage(canonical));
  assert.deepEqual(verdicts(result), ['pass', 'pass', 'pass']);
  return { f, checkRun, input, check, evidence, req: canonical, result };
}
const variations = [
  ['other scope', e => ({ ...e, scope: 'another-scope' })],
  ['other reader', e => ({ ...e, allowedReaders: ['another-reader'] })],
  ['body digest mismatch', e => ({ ...e, content: { ...e.content, digest: 'a'.repeat(64) } })],
];
for (const [name, change] of variations) test(`decision22 canonical inconclusive ${name} remains traceable through withdrawal and reconciliation`, { timeout: 30000 }, async () => {
  const x = await referenced(change);
  assert.equal(x.check.result.verdict, 'inconclusive');
  const own = value(await x.checkRun.runtime.readCheckEligibility(x.check.result.checkId));
  assert.deepEqual([own.eligible, own.recheckRequired], [false, false]);
  const before = value(await x.f.store.snapshot());
  const read = await x.f.runtime.readStorageCheckEligibility(x.req.executionId);
  assert.deepEqual(read.ok ? [read.value.eligible, read.value.recheckRequired, read.value.tomboInvalidationPending] : read.error, [true, false, false], 'DECISION22_CANONICAL_INCONCLUSIVE');
  assert.deepEqual(read.value.request, x.req); assert.deepEqual(read.value.result, x.result);
  assert.deepEqual(value(await x.f.store.snapshot()), before);
  const withdrawal = { evidenceId: x.evidence.evidenceId, reason: 'public evidence withdrawn', withdrawnAt: identity.now() };
  value(await x.checkRun.runtime.withdraw(withdrawal));
  const after = value(await x.f.runtime.readStorageCheckEligibility(x.req.executionId));
  assert.deepEqual([after.eligible, after.recheckRequired, after.tomboInvalidationPending], [false, true, true]);
  assert.deepEqual(after.result, x.result);
  const reopened = createEvaluator({ store: x.f.store, run: x.checkRun.run, async invalidateEvidence() { return { ok: true, value: undefined }; } });
  value(await reopened.withdraw(withdrawal));
  const reconciled = value(await x.f.runtime.readStorageCheckEligibility(x.req.executionId));
  assert.deepEqual([reconciled.eligible, reconciled.recheckRequired, reconciled.tomboInvalidationPending], [false, true, false]);
  for (const entry of before.entries) assert.deepEqual(value(await x.f.store.snapshot()).entries.find(e => e.key.collection === entry.key.collection && e.key.id === entry.key.id), entry);
  assert.deepEqual(value(await x.f.runtime.evaluateStorage(x.req)), x.result);
});
for (const damage of ['scope', 'reader', 'digest', 'supplied content']) test(`decision22 still rejects corrupt referenced ${damage}`, { timeout: 30000 }, async () => {
  const x = await referenced(e => e);
  assert.equal(x.check.result.verdict, 'pass');
  assert.equal(value(await x.f.runtime.readStorageCheckEligibility(x.req.executionId)).eligible, true);
  const store = { async snapshot() {
    const result = await x.f.store.snapshot();
    if (result.ok) {
      const id = damage === 'supplied content' ? x.evidence.evidenceId : `observation-${x.check.executionId}`;
      const evidence = result.value.entries.find(e => e.key.collection === 'evaluator.evidence' && e.key.id === id).value.evidence;
      if (damage === 'scope') evidence.scope = 'another-scope';
      if (damage === 'reader') evidence.allowedReaders = ['another-reader'];
      if (damage === 'digest') evidence.content.digest = 'a'.repeat(64);
      if (damage === 'supplied content') evidence.source = 'different source';
    }
    return result;
  }, transact: input => x.f.store.transact(input) };
  const runtime = createEvaluator({ store, run: x.f.run });
  assert.equal((await runtime.readStorageCheckEligibility(x.req.executionId)).error.code, 'unavailable');
  assert.equal(value(await x.f.runtime.readStorageCheckEligibility(x.req.executionId)).eligible, true);
});
