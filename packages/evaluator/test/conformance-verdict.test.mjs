import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLanguageRegistry } from '@semevolve/language-registry';
import { createRegistryInspectionAdapter } from '@semevolve/evaluator';
import { aggregateVerdict, classifyObservation } from '../dist/observation.js';
import { fixture, identity, request, value } from './support/fixture.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const dropsNonPass = /if\s*\([^)\n]*\.eligible[^)\n]*\)[^\n]*return ok\(null\)/;
const localAggregate = /includes\('fail'\)\s*\?\s*'fail'\s*:\s*[^;\n]*includes\('inconclusive'\)/;

function verdictGateViolations(source, file = 'sample.ts') {
  const violations = [];
  if (dropsNonPass.test(source)) violations.push(`${file} drops a non-pass result`);
  if (!file.endsWith('observation.ts') && localAggregate.test(source)) violations.push(`${file} aggregates verdicts outside the classifier`);
  return violations;
}

function sources(directory) {
  return readdirSync(directory, { recursive: true }).flatMap(name => {
    const path = join(directory, String(name));
    return String(name).endsWith('.ts') ? [[path.slice(root.length + 1), readFileSync(path, 'utf8')]] : [];
  });
}

test('fail and inconclusive stay visible while a withdrawn check needs re-check', () => {
  assert.deepEqual(classifyObservation({ recheckRequired: false, reason: 'Check did not pass', verdict: 'fail' }), { kind: 'observed', verdict: 'fail' });
  assert.deepEqual(classifyObservation({ recheckRequired: false, reason: 'Check did not pass', verdict: 'inconclusive' }), { kind: 'observed', verdict: 'inconclusive' });
  assert.deepEqual(classifyObservation({ recheckRequired: false, reason: null, verdict: 'pass' }), { kind: 'observed', verdict: 'pass' });
  assert.match(classifyObservation({ recheckRequired: true, reason: 'Evidence withdrawn; a new execution ID is required', verdict: 'pass' }).reason, /needs re-check|Evidence withdrawn/);
  assert.equal(classifyObservation({ recheckRequired: true, reason: null, verdict: 'fail' }).kind, 'recheck');
  assert.equal(aggregateVerdict(['pass', 'inconclusive']), 'inconclusive');
  assert.equal(aggregateVerdict(['inconclusive', 'fail']), 'fail');
  assert.equal(aggregateVerdict(['pass']), 'pass');
  assert.equal(aggregateVerdict([]), 'pass');
  const violations = ['packages/evaluator/src', 'packages/tombo-bridge/src'].flatMap(directory => sources(join(root, directory)).flatMap(([file, source]) => verdictGateViolations(source, file)));
  assert.deepEqual(violations, []);
  const adapter = readFileSync(join(root, 'packages/evaluator/src/registry-inspection.ts'), 'utf8');
  assert.match(adapter, /classifyObservation\(/);
  assert.match(adapter, /aggregateVerdict\(/);
  assert.doesNotMatch(adapter, /\.eligible/);
  assert.doesNotMatch(adapter, /regressionVerdict:\s*'pass'/);
  const sample = "if (!result.value.eligible) return ok(null);\nconst verdict = items.includes('fail') ? 'fail' : items.includes('inconclusive') ? 'inconclusive' : 'pass';";
  assert.deepEqual(verdictGateViolations(sample), ['sample.ts drops a non-pass result', 'sample.ts aggregates verdicts outside the classifier']);
});

const fingerprint = { peerId: 'peer-b', provider: 'synthetic', modelId: 'fixed', cliVersion: 'cli-1', settingsDigest: identity.digest({ temperature: 0 }), introductionDigest: identity.digest('public-intro') };

function registryFor(f) {
  const scope = { scopeId: f.run.scope, purpose: 'Synthetic registry consumer', taskRange: 'public-task', participantIds: ['peer-b'] };
  const inspection = createRegistryInspectionAdapter({ evaluator: f.runtime, testSetDigest: f.run.testSetDigest });
  const registry = createLanguageRegistry({ store: f.store, scopes: [{ scope, fingerprints: [fingerprint], testSetDigest: f.run.testSetDigest, evaluatorVersion: f.run.evaluatorVersion }], inspection, transitions: { async inspect() { return { ok: false, error: { code: 'unavailable', reason: 'Not part of this check' } }; } } });
  const content = { parent_ids: [], scope, specification_text: 'Synthetic conditional notation', public_examples: [{ expression: 'candidate', explanation: 'Public example', counterexample: false }], change_reason: 'Public consumer', compatibility_claims: [] };
  return { scope, inspection, registry, content };
}

async function prepare(f) {
  const host = registryFor(f);
  value(await host.registry.register({ ...host.content, version_id: f.run.languageVersionId, digest: identity.digest(host.content) }));
  for (const status of ['CANDIDATE', 'TRIAL']) value(await host.registry.appendStatus({ eventId: identity.newId('event'), versionId: f.run.languageVersionId, scopeId: f.run.scope, status, checkIds: [], reason: 'Synthetic transition', occurredAt: identity.now() }));
  return host;
}

async function adopt(host, f, checkId) {
  const accepted = conformance(f, checkId, 'pass', identity.now());
  value(await host.registry.recordConformance(accepted));
  value(await host.registry.appendStatus({ eventId: identity.newId('event'), versionId: f.run.languageVersionId, scopeId: f.run.scope, status: 'ACTIVE', checkIds: [checkId], reason: 'Synthetic adoption', occurredAt: identity.now() }));
  value(await host.registry.selectHead(f.run.scope, f.run.languageVersionId, 0));
  return accepted;
}

function conformance(f, checkId, verdict, checkedAt) {
  return { versionId: f.run.languageVersionId, fingerprint, scopeId: f.run.scope, testSetDigest: f.run.testSetDigest, evaluatorVersion: f.run.evaluatorVersion, checkIds: [checkId], verdict, checkedAt, expiresAt: null };
}

const capture = messageId => ({ messageId, receiverId: 'peer-b', payload: { text: 'candidate' }, sharedContext: { current: 1 }, fingerprint });

test('a later transmission failure makes the adopted version ineligible', { timeout: 30000 }, async () => {
  const f = fixture();
  const passed = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [], capture('public-pass'))));
  assert.equal(passed.result.verdict, 'pass');
  const host = await prepare(f);
  await adopt(host, f, passed.result.checkId);
  const failed = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'certain' }, [], capture('public-fail'))));
  assert.equal(failed.result.verdict, 'fail');
  const later = conformance(f, failed.result.checkId, 'fail', identity.now());
  const proof = value(await host.inspection.readConformance(later));
  assert.equal(proof.regressionVerdict, 'fail');
  assert.deepEqual(proof.checks.map(check => check.result.verdict), ['fail']);
  value(await host.registry.recordConformance(later));
  const refused = await host.registry.selectHead(f.run.scope, f.run.languageVersionId, 1);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error.code, 'invalid_input');
  assert.match(refused.error.issues.join('\n'), /Current independent conformance required/);
  assert.deepEqual(value(await host.registry.conformance(f.run.languageVersionId, fingerprint, f.run.scope)).map(record => record.verdict), ['pass', 'fail']);
});

test('a later inconclusive transmission is recorded and is not a pass', { timeout: 30000 }, async () => {
  const f = fixture();
  const passed = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [], capture('public-pass'))));
  const host = await prepare(f);
  await adopt(host, f, passed.result.checkId);
  const unknown = value(await f.runtime.evaluate(await request(f, 'transmission', {}, [], capture('public-unknown'))));
  assert.equal(unknown.result.verdict, 'inconclusive');
  const later = conformance(f, unknown.result.checkId, 'inconclusive', identity.now());
  const labelledPass = { ...later, verdict: 'pass' };
  const hidden = await host.registry.recordConformance(labelledPass);
  assert.equal(hidden.ok, false, JSON.stringify(hidden));
  const proof = value(await host.inspection.readConformance(later));
  assert.equal(proof.regressionVerdict, 'inconclusive');
  assert.notEqual(proof, null);
  value(await host.registry.recordConformance(later));
  const refused = await host.registry.selectHead(f.run.scope, f.run.languageVersionId, 1);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(refused.error.issues.join('\n'), /Current independent conformance required/);
  assert.deepEqual(value(await host.registry.conformance(f.run.languageVersionId, fingerprint, f.run.scope)).map(record => record.verdict), ['pass', 'inconclusive']);
});

test('a withdrawn check is rejected as needs re-check and is not recorded again', { timeout: 30000 }, async () => {
  const f = fixture();
  const evidence = { evidenceId: 'public-source', source: 'public-fixture', scope: f.run.scope, allowedReaders: ['evaluator'], content: { kind: 'reference_only' } };
  const passed = value(await f.runtime.evaluate(await request(f, 'transmission', { certainty: 'candidate' }, [evidence], capture('public-pass'))));
  const host = registryFor(f);
  value(await host.registry.register({ ...host.content, version_id: f.run.languageVersionId, digest: identity.digest(host.content) }));
  const accepted = conformance(f, passed.result.checkId, 'pass', identity.now());
  value(await host.registry.recordConformance(accepted));
  value(await f.runtime.withdraw({ evidenceId: evidence.evidenceId, reason: 'Synthetic withdrawal', withdrawnAt: identity.now() }));
  const proof = await host.inspection.readConformance(accepted);
  assert.equal(proof.ok, false, JSON.stringify(proof));
  assert.equal(proof.error.code, 'invalid_input');
  assert.match(proof.error.issues.join('\n'), /needs re-check/);
  const later = identity.now();
  for (const verdict of ['pass', 'fail']) {
    const refused = await host.registry.recordConformance({ ...accepted, verdict, checkedAt: later });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.error.issues.join('\n'), /needs re-check/);
  }
  assert.deepEqual(value(await host.registry.conformance(f.run.languageVersionId, fingerprint, f.run.scope)).map(record => record.verdict), ['pass']);
});
