import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hostIdentity } from '@semevolve/core';
import { createEvaluator } from '@semevolve/evaluator';
import { conditions, fixture, request, value } from './support/fixture.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const configuredDigest = value => createHash('sha256').update(`configured:${canonicalJson(value)}`, 'utf8').digest('hex');
const allowedDefaultDigest = new Set([
  'packages/evaluator/src/storage-projection.ts',
  'packages/tombo-bridge/src/managed-session.ts',
]);

function sources(directory) {
  return readdirSync(directory, { recursive: true }).flatMap(name => {
    const path = join(directory, String(name));
    return String(name).endsWith('.ts') ? [[path.slice(root.length + 1), readFileSync(path, 'utf8')]] : [];
  });
}

function digestBypass(source, file) {
  const violations = [];
  if (/hostIdentity\.digest/.test(source)) violations.push(`${file} recomputes with the global digest`);
  if (/digestJson\(/.test(source) && !allowedDefaultDigest.has(file)) violations.push(`${file} verifies with the default digest`);
  return violations;
}

test('persisted runs are rechecked with the configured digest', { timeout: 30000 }, async () => {
  const identity = { ...hostIdentity, digest: configuredDigest };
  assert.notEqual(identity.digest(conditions), hostIdentity.digest(conditions));
  const run = { ...fixture().run, criteriaDigest: identity.digest(conditions) };
  const f = fixture({ identity, run });
  const drafted = await request(f, 'transmission', { certainty: 'candidate' });
  const base = { taskId: drafted.taskId, targetMessageId: drafted.targetMessageId, languageVersionId: drafted.languageVersionId, dimension: drafted.dimension, interpretation: drafted.interpretation, evidence: drafted.evidence, scope: drafted.scope };
  const persisted = value(await f.runtime.evaluate({ ...drafted, inputDigest: identity.digest(base) }));
  assert.equal(persisted.result.verdict, 'pass');
  assert.equal(value(await f.runtime.readCheckEligibility(persisted.result.checkId)).eligible, true);
  const reopened = createEvaluator({ store: f.store, run: f.run, identity });
  assert.equal(value(await reopened.readCheckEligibility(persisted.result.checkId)).eligible, true);
  assert.throws(() => createEvaluator({ store: f.store, run: { ...f.run, criteriaDigest: hostIdentity.digest(conditions) }, identity }), /Invalid evaluator configuration/);
  const tampered = structuredClone(value(await f.store.snapshot()));
  const stored = tampered.entries.find(entry => entry.key.collection === 'evaluator.runs');
  stored.value.configuration.criteriaDigest = hostIdentity.digest(conditions);
  const reader = createEvaluator({
    store: { async snapshot() { return { ok: true, value: tampered }; }, transact: batch => f.store.transact(batch) },
    run: f.run,
    identity,
  });
  const rejected = await reader.readCheckEligibility(persisted.result.checkId);
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'unavailable');
  const runtime = readFileSync(join(root, 'packages/evaluator/src/runtime.ts'), 'utf8');
  assert.equal(runtime.match(/validRun\(configuration, identity\.digest\)/g)?.length, 2);
  const violations = ['packages/evaluator/src', 'packages/tombo-bridge/src'].flatMap(directory => sources(join(root, directory)).flatMap(([file, source]) => digestBypass(source, file)));
  assert.deepEqual(violations, []);
  assert.deepEqual(digestBypass('hostIdentity.digest(expected);\ndigestJson(payload);', 'sample.ts'), ['sample.ts recomputes with the global digest', 'sample.ts verifies with the default digest']);
});
