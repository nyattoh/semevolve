import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../../apps/cli/dist/hub.js';
import { ready, value } from './helpers.mjs';

const requirements = {
  connection: ['grokModel', 'grokSettings', 'grokPermissions', 'grokQuota', 'grokHubProbe', 'agyModel', 'agySettings', 'agyPermissions', 'agyQuota', 'agyHubProbe', 'route', 'agmsgRoute', 'hostPlacement', 'workerToWorkerPlan'],
  sessions: ['grokFreshProcedure', 'agyFreshProcedure', 'worker2FreshProcedure', 'inputSeparation', 'isolationLimits'],
  tokenizer: ['name', 'version', 'encoding', 'specialTokens', 'countedTextScope', 'providerBillingSeparation', 'literalEncodeEvidence'],
  fixtures: ['assignmentEvidence', 'settingsEvidence', 'limitsEvidence', 'fixtureHashEvidence'],
  phases: ['formationEvidence', 'taskEvidence', 'revisionEvidence', 'humanTranslationEvidence', 'pasteWaitingEvidence', 'deduplicationEvidence', 'nullEvidence', 'intervalUnionEvidence'],
  storage: ['authorityPathEvidence', 'reopenEvidence', 'privateLogsEvidence', 'credentialSeparationEvidence', 'privateAnswersEvidence'],
};
function evidence(condition, patch = {}) {
  const facts = Object.fromEntries(requirements[condition].map(field => [field, 'synthetic observation']));
  if (condition === 'tokenizer') Object.assign(facts, { name: 'gpt-tokenizer', version: '4.1.0', encoding: 'cl100k_base', specialTokens: 'ordinary_text' });
  return { id: `evidence-${condition}`, condition, facts, evidenceRefs: ['synthetic-proof'], fixtureIds: [], sourceRef: 'synthetic-operator', observedAt: '2026-01-01T00:00:00.000Z', ...patch };
}

test('M0 check exposes all six SPEC conditions and preserves actual-route unknowns', t => {
  const f = ready(t);
  const report = value(f.sender.checkM0());
  assert.equal(report.M0ready, false);
  assert.equal(report.assessment, 'operator_evidence_only');
  assert.deepEqual(report.conditions.map(c => c.id), ['connection', 'sessions', 'tokenizer', 'fixtures', 'phases', 'storage']);
  assert.deepEqual(report.conditions.map(c => c.status), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(report.conditions[0].facts.grokModel, null);
  assert.equal(report.conditions[0].facts.agyHubProbe, null);
  assert.deepEqual(report.conditions[0].evidenceRefs, []);
  assert.match(report.conditions[0].requirement, /Grok Bot PMとAgy worker/u);
  assert.equal(f.receiver.checkM0().error.code, 'unauthorised');
});

test('reported evidence is immutable and unknown observations never become ready', t => {
  const f = ready(t);
  const input = evidence('connection');
  input.facts.grokModel = null;
  input.facts.grokQuota = null;
  assert.deepEqual(value(f.sender.recordReadiness(input)), input);
  assert.deepEqual(value(f.sender.recordReadiness(input)), input);
  assert.equal(f.sender.recordReadiness({ ...input, sourceRef: 'changed' }).error.code, 'conflict');
  assert.equal(f.receiver.recordReadiness(input).error.code, 'unauthorised');
  assert.equal(value(f.sender.checkM0()).M0ready, false);
  assert.deepEqual(value(f.sender.checkM0()).conditions[0].unknown, ['grokModel', 'grokQuota']);
  f.sender.close();
  const reopened = value(createHub(f.options[0]));
  assert.equal(value(reopened.checkM0()).conditions[0].facts.grokModel, null);
  reopened.close();
});

test('fixed tokenizer mismatches and missing evidence remain unknown', t => {
  const f = ready(t);
  const input = evidence('tokenizer');
  input.facts.encoding = 'not-the-fixed-encoding';
  value(f.sender.recordReadiness(input));
  assert.deepEqual(value(f.sender.checkM0()).conditions[2].unknown, ['tokenizer_mismatch']);
  value(f.sender.recordReadiness(evidence('tokenizer', { id: 'tokenizer-no-proof', evidenceRefs: [] })));
  assert.deepEqual(value(f.sender.checkM0()).conditions[2].unknown, ['evidenceRefs']);
  value(f.sender.recordReadiness(evidence('tokenizer', { id: 'tokenizer-checked' })));
  assert.equal(value(f.sender.checkM0()).conditions[2].status, 'confirmed');
  assert.equal(value(f.sender.checkM0()).M0ready, false);
});

test('six synthetic fixtures need complete settings and all evidence before readiness can be reported', t => {
  const f = ready(t);
  const fixtures = Array.from({ length: 6 }, (_, i) => ({
    kind: 'fixture', value: { id: `synthetic-${i}`, input: `Return synthetic label ${i}.`, successCriteria: [`Label ${i} only.`], intentChecks: ['literal label'], roles: { sender: i < 4 ? 'sender@canary' : 'receiver@canary', recipients: [i < 4 ? 'receiver@canary' : 'other@canary'] }, modelSettings: null, limits: { processingSeconds: 10, correctionRounds: 1 } },
  }));
  value(f.sender.importRecords(fixtures));
  for (const condition of Object.keys(requirements)) value(f.sender.recordReadiness(evidence(condition, condition === 'fixtures' ? { fixtureIds: fixtures.map(f => f.value.id) } : {})));
  assert.equal(value(f.sender.checkM0()).M0ready, false);
  assert.deepEqual(value(f.sender.checkM0()).conditions[3].unknown, ['fixture_settings']);
  const actors = Object.fromEntries(['sender@canary', 'receiver@canary', 'other@canary'].map(actor => [actor, { model: 'synthetic-model', settings: 'host_default', permissions: 'synthetic-only', quota: 'synthetic-quota', sourceRef: 'synthetic-observation' }]));
  const complete = fixtures.map(f => ({ kind: f.kind, value: { ...f.value, id: `complete-${f.value.id}`, modelSettings: actors } }));
  value(f.sender.importRecords(complete));
  value(f.sender.recordReadiness(evidence('fixtures', { id: 'complete-selection', fixtureIds: complete.map(f => f.value.id) })));
  const report = value(f.sender.checkM0());
  assert.equal(report.M0ready, true);
  assert.equal(report.assessment, 'operator_evidence_only');
  const unknown = evidence('connection', { id: 'route-now-unknown' });
  unknown.facts.agyHubProbe = null;
  value(f.sender.recordReadiness(unknown));
  assert.equal(value(f.sender.checkM0()).M0ready, false);
});

test('unknown conditions and malformed evidence are rejected without saving', t => {
  const f = ready(t);
  assert.equal(f.sender.recordReadiness(evidence('storage', { condition: 'made-up' })).error.code, 'invalid_input');
  assert.equal(f.sender.recordReadiness(evidence('storage', { facts: { authorityPathEvidence: {} } })).error.code, 'invalid_input');
  assert.equal(value(f.sender.checkM0()).conditions[5].status, 'unknown');
});
