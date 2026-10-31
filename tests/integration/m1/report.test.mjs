import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, manifest, value, measure, formation, event, timed, boundaries, request, understanding, permit, resultMessage } from './helpers.mjs';

test('C3 mandatory input stays missing; token and clock completeness are independent', t => {
  const f = setup(t);
  value(f.sender.captureM1(manifest()));
  measure(f, 'request-output');
  const partial = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.deepEqual(partial.withoutFormation.tokens, { observedSubtotal: 4, completeTotal: null });
  assert.equal(partial.missingObservations.some(r => r.id === 'request-input' && r.actorId === 'receiver@canary' && r.direction === 'input'), true);
  measure(f, 'request-input', { input: true });
  const full = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.deepEqual(full.withoutFormation.tokens, { observedSubtotal: 8, completeTotal: 8 });
  assert.equal(full.withoutFormation.time.grossMs, null);
  assert.equal(full.providerInternalContext, null);
  assert.equal(full.actualCost, null);
});

test('C5 task gross 30000, overlapping wait union 10000, inclusive union 40000 and span 50000', t => {
  const f = setup(t); formation(f);
  value(f.sender.captureM1(manifest({ formationManifestId: 'formation-manifest' })));
  boundaries(f, { prefix: 'formation', start: 0, end: 10, overrides: { manifestId: 'formation-manifest', runId: 'formation-run', languageVersion: 'synthetic-bootstrap' } });
  boundaries(f, { waits: ['approval', 'paste'] });
  timed(f, 'a-start', 'wait', { waitId: 'approval', edge: 'start' }, 25);
  timed(f, 'a-end', 'wait', { waitId: 'approval', edge: 'end' }, 30);
  timed(f, 'p-start', 'wait', { waitId: 'paste', edge: 'start' }, 28);
  timed(f, 'p-end', 'wait', { waitId: 'paste', edge: 'end' }, 35);
  const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.withoutFormation.time.grossMs, 30000);
  assert.equal(r.withoutFormation.time.waitUnionMs, 10000);
  assert.equal(r.withoutFormation.time.activeMs, 20000);
  assert.equal(r.withFormation.time.grossMs, 40000);
  assert.equal(r.withFormation.time.activeMs, 30000);
  assert.equal(r.withFormation.time.spanMs, 50000);
  assert.equal(r.withFormation.time.interphaseGapMs, 10000);
});

test('C6 open wait keeps gross known and active unknown', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  boundaries(f, { waits: ['approval'] });
  timed(f, 'w-start', 'wait', { waitId: 'approval', edge: 'start' }, 25);
  timed(f, 'w-end', 'wait', { waitId: 'approval', edge: 'end' }, null);
  const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.withoutFormation.time.grossMs, 30000);
  assert.equal(r.withoutFormation.time.activeMs, null);
  assert.equal(r.withoutFormation.time.missing.includes('run-1:wait:approval'), true);
});

test('C5 a wait spanning a phase boundary subtracts only the intersection', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  boundaries(f, { waits: ['approval'] });
  timed(f, 'w-start', 'wait', { waitId: 'approval', edge: 'start' }, 15);
  timed(f, 'w-end', 'wait', { waitId: 'approval', edge: 'end' }, 25);
  const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.withoutFormation.time.waitUnionMs, 5000);
  assert.equal(r.withoutFormation.time.activeMs, 25000);
});

for (const variant of ['missing-start', 'different-domain', 'backward', 'monotonic-jump']) {
  test('C6 clock uncertainty is preserved: ' + variant, t => {
    const f = setup(t); value(f.sender.captureM1(manifest()));
    timed(f, 'start', 'boundary', { stage: 'start' }, variant === 'missing-start' ? null : 20);
    const overrides = variant === 'different-domain' ? { clock: { host: 'linux', processRef: 'other', monotonicMs: 50000, utcSource: 'Date.toISOString', resolutionMs: 1, synchronisationRef: null } }
      : variant === 'monotonic-jump' ? { clock: { host: 'raytrek', processRef: 'synthetic-clock-process', monotonicMs: 80000, utcSource: 'Date.toISOString', resolutionMs: 1, synchronisationRef: null } } : {};
    timed(f, 'end', 'boundary', { stage: 'end' }, variant === 'backward' ? 10 : 50, overrides);
    const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
    assert.equal(r.withoutFormation.time.grossMs, null);
    assert.equal(r.withoutFormation.time.missing.includes('run-1:boundary_or_clock'), true);
  });
}

test('C7 power/cloud memory unavailable; boundary samples report observed RSS and heap separately', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  let r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.deepEqual(r.resources.power, { value: null, status: 'measurement-unavailable', label: '測定不能' });
  assert.equal(r.resources.cloudRAM.value, null);
  assert.equal(r.localMemory.observedMaxRssBytes, null);
  value(f.sender.captureM1(event('memory', 'memory', { target: 'm1-cli', samplingScheme: 'operation-boundaries', samplingIntervalMs: null, pid: 123, processRef: 'synthetic-process', processStartRef: 'synthetic-start', nodeVersion: 'v24.22.1', operation: 'capture', parentIncluded: false, childrenIncluded: false, samples: [100, 140, 120].map((rssBytes, i) => ({ boundary: ['before-open', 'after-open', 'before-close'][i], observedAt: new Date(Date.UTC(2026, 0, 1) + [0, 3, 10][i]).toISOString(), monotonicMs: [0, 3, 10][i], rssBytes, heapUsedBytes: [30, 40, 35][i] })) })));
  r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.localMemory.observedMaxRssBytes, 140);
  assert.equal(r.localMemory.observedMaxHeapUsedBytes, 40);
  assert.equal(r.localMemory.sampleCount, 3);
  assert.deepEqual(r.localMemory.processes[0].intervalsMs, [3, 7]);
  assert.equal(r.localMemory.processes[0].samplingIntervalMs, null);
  assert.equal(r.localMemory.truePeakBytes, null);
});

test('C7 direct resource readings retain sensor, scope, units and cannot become token estimates', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  value(f.sender.captureM1(event('boundary', 'power-reading', { stage: 'direct_resource', resource: 'power', method: 'direct', value: 12.5, unit: 'W', target: 'synthetic-meter-target', sensor: 'synthetic-meter', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z' })));
  const report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(report.resources.power.value, 12.5);
  assert.equal(report.resources.power.unit, 'W');
  assert.equal(report.resources.power.readings[0].sensor, 'synthetic-meter');
  assert.equal(report.resources.cloudRAM.value, null);
});

test('C4 requested translations have a separate subtotal and an inclusive total', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  measure(f, 'request-output'); measure(f, 'request-input', { input: true });
  measure(f, 'translation', { phase: 'human_translation', category: 'translation' });
  const report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(report.withoutFormation.tokens.completeTotal, 8);
  assert.equal(report.translationTokens.completeTotal, 4);
  assert.equal(report.withoutFormation.tokensIncludingTranslation.completeTotal, 12);
});

test('C8 literal mismatch overrides claimed success; missing intent stays unknown', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  request(f); understanding(f); permit(f); resultMessage(f);
  value(f.sender.captureM1(event('outcome', 'outcome', { status: 'success', resultId: 'result-event', evaluatorId: 'synthetic-operator', rubricHash: 'b'.repeat(64), literal: { expected: { answer: 5 }, observed: { answer: 4 }, evidenceRef: 'synthetic-result-interpretation' }, intentChecks: [], stopReason: null })));
  const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.outcome.status, 'failure');
  assert.equal(r.outcome.claimedStatus, 'success');
  assert.equal(r.outcome.intentStatus, 'unknown');
  assert.equal(r.outcome.assessment, 'operator_literal_evidence_only');
  assert.equal(r.protocol.offscreenDisclosure, 'unknown');
});

test('C8 incomplete preserves stopping reason and cannot become semantic pass', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  request(f); understanding(f); permit(f);
  value(f.sender.captureM1(event('outcome', 'outcome', { status: 'incomplete', resultId: null, evaluatorId: 'synthetic-operator', rubricHash: 'b'.repeat(64), literal: null, intentChecks: [], stopReason: 'Operator stopped before result.' })));
  const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.outcome.status, 'incomplete');
  assert.equal(r.outcome.stopReason, 'Operator stopped before result.');
});

test('C8 missing manifest intent criterion stays unknown despite one operator pass', t => {
  const f = setup(t); value(f.sender.captureM1(manifest({ intentCheckIds: ['one', 'two'] })));
  request(f); understanding(f); permit(f); resultMessage(f, '{"answer":5}');
  value(f.sender.captureM1(event('outcome', 'outcome', { status: 'success', resultId: 'result-event', evaluatorId: 'synthetic-operator', rubricHash: 'b'.repeat(64), literal: { expected: { answer: 5 }, observed: { answer: 5 }, evidenceRef: 'synthetic-interpretation' }, intentChecks: [{ id: 'one', status: 'pass', evidenceRef: 'synthetic-intent-observation', messageId: 'result-message' }], stopReason: null })));
  const r = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(r.outcome.status, 'unknown');
  assert.deepEqual(r.outcome.missingIntentChecks, ['two']);
});

test('C9 immutable close snapshot and hash survive later generic measurements', t => {
  const f = setup(t); value(f.sender.captureM1(manifest()));
  measure(f, 'request-output'); measure(f, 'request-input', { input: true });
  const closed = value(f.sender.captureM1({ kind: 'close', id: 'closed', manifestId: 'task-manifest', sourceRef: 'synthetic-close' }));
  assert.equal(closed.report.withoutFormation.tokens.completeTotal, 8);
  measure(f, 'later', { input: true });
  assert.deepEqual(value(f.sender.reportM1({ manifestId: 'task-manifest', snapshotId: 'closed' })), closed);
  assert.equal(value(f.sender.captureM1({ kind: 'close', id: 'closed', manifestId: 'task-manifest', sourceRef: 'synthetic-close' })).reportHash, closed.reportHash);
});

test('C4 fixed tokens 8/16; replay, reintroduction, re-paste and provider usage remain distinct', t => {
  const f = setup(t); formation(f);
  value(f.sender.captureM1(manifest({ formationManifestId: 'formation-manifest' })));
  measure(f, 'request-output'); measure(f, 'request-input', { input: true });
  let report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(report.withoutFormation.tokens.completeTotal, 8);
  assert.equal(report.withFormation.tokens.completeTotal, null);
  measure(f, 'request-output', { runId: 'formation-run', phase: 'v0_formation' });
  measure(f, 'request-input', { input: true, runId: 'formation-run', phase: 'v0_formation' });
  report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(report.withFormation.tokens.completeTotal, 16);
  measure(f, 'intro-input', { input: true, category: 'language_introduction', providerUsage: { inputTokens: 100, outputTokens: null, totalTokens: 100 } });
  measure(f, 'intro-input', { input: true, category: 'language_introduction', providerUsage: { inputTokens: 100, outputTokens: null, totalTokens: 100 } });
  report = value(f.sender.reportM1({ manifestId: 'task-manifest' }));
  assert.equal(report.withoutFormation.tokens.completeTotal, 12);
  assert.equal(report.withFormation.tokens.completeTotal, 20);
  measure(f, 'repaste-input', { input: true, category: 'language_introduction' });
  assert.equal(value(f.sender.reportM1({ manifestId: 'task-manifest' })).withFormation.tokens.completeTotal, 24);
});

test('C3 conditional absence needs an explicit reason; unknown text does not become zero', t => {
  const f = setup(t);
  const m = manifest();
  m.requiredObservations.push({ id: 'correction-input', type: 'measurement', actorId: 'receiver@canary', direction: 'input', category: 'correction', conditional: true });
  value(f.sender.captureM1(m));
  measure(f, 'request-output'); measure(f, 'request-input', { input: true });
  assert.equal(value(f.sender.reportM1({ manifestId: m.id })).withoutFormation.tokens.completeTotal, null);
  value(f.sender.captureM1(event('boundary', 'no-correction', { stage: 'not_applicable', requirementId: 'correction-input', reason: 'No correction observed in this synthetic run.' })));
  assert.equal(value(f.sender.reportM1({ manifestId: m.id })).withoutFormation.tokens.completeTotal, 8);
  measure(f, 'unknown-extra', { input: true, text: null });
  assert.deepEqual(value(f.sender.reportM1({ manifestId: m.id })).withoutFormation.tokens, { observedSubtotal: 8, completeTotal: null });
});
