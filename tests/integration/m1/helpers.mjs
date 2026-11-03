import { ready, value, participants } from '../m0/helpers.mjs';
export { value, participants };
export function setup(t) { return ready(t); }
export function event(kind, id, data = {}, overrides = {}) {
  return { kind, id, manifestId: 'task-manifest', runId: 'run-1', languageVersion: 'synthetic-v1', actorId: 'sender@canary', messageId: null, sourceRef: 'synthetic-observation', observedAt: null, clock: null, unknownReason: 'Synthetic observation has no clock.', data, ...overrides };
}
export function send(f, id, kind, body, receiver = false) {
  return value((receiver ? f.receiver : f.sender).send({ id, kind, body, runId: 'run-1', languageVersion: 'synthetic-v1', recipients: [receiver ? 'sender@canary' : 'receiver@canary'] }));
}
export function request(f) {
  send(f, 'request-message', 'request', 'Return the synthetic sum.');
  return value(f.sender.captureM1(event('boundary', 'request-event', { stage: 'request' }, { messageId: 'request-message' })));
}
export function understanding(f) {
  send(f, 'understanding-message', 'understanding', 'Compute sum. Read operands. No uncertainty.', true);
  return value(f.sender.captureM1(event('understanding', 'understanding-event', { requestId: 'request-event', paraphrase: 'Compute sum.', firstAction: 'Read operands.', uncertainties: [], uncertaintyEvidence: 'No uncertainty.' }, { actorId: 'receiver@canary', messageId: 'understanding-message' })));
}
export function permit(f) {
  return value(f.sender.captureM1(event('disclosure', 'permit', { understandingId: 'understanding-event', purpose: 'execution_or_correction', privateAnswerIncluded: false })));
}
export function resultMessage(f, body = '{"answer":4}') {
  send(f, 'execute-message', 'request', 'Execute now.');
  value(f.sender.captureM1(event('boundary', 'execute-event', { stage: 'execution', disclosureId: 'permit' }, { messageId: 'execute-message' })));
  send(f, 'result-message', 'result', body, true);
  return value(f.sender.captureM1(event('boundary', 'result-event', { stage: 'result', executionId: 'execute-event' }, { actorId: 'receiver@canary', messageId: 'result-message' })));
}
export function manifest(overrides = {}) {
  return { kind: 'manifest', id: 'task-manifest', schema: 'semevolve-m1-1', experimentId: 'synthetic-experiment', runId: 'run-1', languageVersion: 'synthetic-v1', scope: 'task', formationManifestId: null,
    inputHash: 'a'.repeat(64), rubricHash: 'b'.repeat(64), intentCheckIds: ['synthetic-intent'], head: 'synthetic-head', sourceRef: 'synthetic-plan',
    actors: participants.map(({ id, connectionRef, sessionRef }) => ({ actorId: id, connectionRef, sessionRef })),
    requiredObservations: [{ id: 'request-output', type: 'measurement', actorId: 'sender@canary', direction: 'output', category: 'request', conditional: false }, { id: 'request-input', type: 'measurement', actorId: 'receiver@canary', direction: 'input', category: 'request', conditional: false }], ...overrides };
}
export function measure(f, id, { input = false, runId = 'run-1', phase = 'task', category = 'request', text = 'Hello, world!', providerUsage = null } = {}) {
  return value((input ? f.receiver : f.sender).recordMeasurement({ runId, eventId: id, occurrenceId: id, messageId: null, recipientId: null, phase, direction: input ? 'input' : 'output', category, text, textRef: 'synthetic-exact-text', providerUsage, startedAt: null, endedAt: null, actualCost: null, sourceRef: 'synthetic-log-' + id }));
}
export function formation(f) {
  value(f.sender.importRecords([{ kind: 'language', value: { id: 'synthetic-bootstrap', definition: 'Synthetic human-language negotiation.', sourceRef: 'synthetic' } }, { kind: 'run', value: { id: 'formation-run', taskId: 'formation', condition: 'formation', languageVersion: 'synthetic-bootstrap', actors: participants.map(p => p.id), modelSettings: null, rerunOf: null, formationRunId: null } }]));
  value(f.sender.captureM1(manifest({ id: 'formation-manifest', runId: 'formation-run', languageVersion: 'synthetic-bootstrap', scope: 'formation' })));
}
export function timed(f, id, kind, data, seconds, overrides = {}) {
  const observedAt = seconds === null ? null : new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  return value(f.sender.captureM1(event(kind, id, data, { observedAt, clock: seconds === null ? null : { host: 'raytrek', processRef: 'synthetic-clock-process', monotonicMs: seconds * 1000, utcSource: 'Date.toISOString', resolutionMs: 1, synchronisationRef: null }, ...overrides })));
}
export function boundaries(f, { prefix = 'task', start = 20, end = 50, waits = [], overrides = {} } = {}) {
  timed(f, prefix + '-start', 'boundary', { stage: 'start' }, start, overrides);
  timed(f, prefix + '-end', 'boundary', { stage: 'end' }, end, overrides);
  value(f.sender.captureM1(event('boundary', prefix + '-waits', { stage: 'wait_inventory', waitIds: waits }, overrides)));
}
