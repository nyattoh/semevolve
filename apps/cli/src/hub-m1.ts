import { canonical, demand, digest, identifier, keys, object, string, strings } from './hub-store.js';
import type { HubStore } from './hub-store.js';
import type { Run, Message } from './hub-data.js';
import { tokenizer } from './hub-measurement.js';
import type { Measurement } from './hub-measurement.js';

interface Requirement {
  id: string; type: 'measurement' | 'event'; actorId: string;
  direction: 'input' | 'output' | 'none'; category: string; conditional: boolean;
}
export interface Manifest {
  kind: 'manifest'; schema: 'semevolve-m1-1'; id: string; experimentId: string;
  runId: string; languageVersion: string; scope: 'formation' | 'task'; formationManifestId: string | null;
  inputHash: string; rubricHash: string; intentCheckIds: string[]; head: string; sourceRef: string;
  actors: { actorId: string; connectionRef: string; sessionRef: string }[];
  requiredObservations: Requirement[];
}
interface Clock {
  host: string; processRef: string; monotonicMs: number; utcSource: string;
  resolutionMs: number; synchronisationRef: string | null;
}
interface MemorySample { boundary: string; observedAt: string; monotonicMs: number; rssBytes: number; heapUsedBytes: number }
interface MemoryData {
  target: 'm1-cli'; samplingScheme: 'operation-boundaries'; samplingIntervalMs: null;
  pid: number; processRef: string; processStartRef: string; nodeVersion: string; operation: string;
  parentIncluded: false; childrenIncluded: false; samples: MemorySample[];
}
export interface Observation {
  kind: 'boundary' | 'wait' | 'understanding' | 'disclosure' | 'outcome' | 'memory';
  id: string; manifestId: string; runId: string; languageVersion: string; actorId: string;
  messageId: string | null; sourceRef: string; observedAt: string | null; clock: Clock | null;
  unknownReason: string | null; data: Record<string, unknown>; recordedAt: string; payloadHash: string;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const text = string(value);
  demand(Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text);
  return text;
}
function finite(value: unknown): number {
  demand(typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return value;
}
function clockValue(value: unknown): Clock | null {
  if (value === null) return null;
  const c = object(value);
  keys(c, ['host', 'processRef', 'monotonicMs', 'utcSource', 'resolutionMs', 'synchronisationRef']);
  return { host: identifier(c.host), processRef: identifier(c.processRef), monotonicMs: finite(c.monotonicMs), utcSource: identifier(c.utcSource), resolutionMs: finite(c.resolutionMs), synchronisationRef: c.synchronisationRef === null ? null : identifier(c.synchronisationRef) };
}
function rowNumber(store: HubStore, kind: string, id: string): number {
  const row = store.db.prepare('SELECT rowid FROM records WHERE kind=? AND id=?').get(kind, id);
  demand(row, 'm1_order_violation');
  return Number(row.rowid);
}
function prior(store: HubStore, manifest: Manifest, id: unknown, kind: Observation['kind'], stage?: string): Observation {
  const event = store.get<Observation>('m1_event', identifier(id));
  demand(event && event.manifestId === manifest.id && event.kind === kind && (stage === undefined || event.data.stage === stage), 'm1_order_violation');
  return event;
}
function sourceMessage(store: HubStore, event: Observation): Message {
  const message = event.messageId === null ? undefined : store.get<Message>('message', event.messageId);
  demand(message && message.runId === event.runId && message.languageVersion === event.languageVersion && message.sender === event.actorId, 'source_mismatch');
  demand(message.sender === store.actor.id || message.recipients.includes(store.actor.id), 'unauthorised');
  return message;
}
function laterMessage(store: HubStore, message: Message, event: Observation): void {
  demand(rowNumber(store, 'message', message.id) > rowNumber(store, 'm1_event', event.id), 'm1_order_violation');
}
function validateProtocol(store: HubStore, manifest: Manifest, event: Observation): void {
  const d = event.data;
  const events = store.list<Observation>('m1_event').filter(e => e.manifestId === manifest.id);
  const messages = store.list<Message>('message').filter(m => m.runId === manifest.runId);
  if (event.kind === 'understanding') {
    const request = prior(store, manifest, d.requestId, 'boundary', 'request');
    const message = sourceMessage(store, event);
    const original = sourceMessage(store, request);
    demand(message.kind === 'understanding' && original.recipients.includes(message.sender) && message.sender !== original.sender, 'source_mismatch');
    laterMessage(store, message, request);
    demand(!messages.some(m => m.kind === 'correction' || m.kind === 'result'), 'm1_order_violation');
    demand(typeof d.paraphrase === 'string' && d.paraphrase.length > 0 && typeof d.firstAction === 'string' && d.firstAction.length > 0 && Array.isArray(d.uncertainties), 'm1_order_violation');
    keys(d, ['requestId', 'paraphrase', 'firstAction', 'uncertainties', 'uncertaintyEvidence']);
    const snippets = [d.paraphrase, d.firstAction, string(d.uncertaintyEvidence), ...d.uncertainties.map(x => string(x))];
    demand(snippets.every(s => message.body.includes(s)), 'source_mismatch');
  } else if (event.kind === 'disclosure') {
    prior(store, manifest, d.understandingId, 'understanding');
    keys(d, ['understandingId', 'purpose', 'privateAnswerIncluded']);
    demand(d.purpose === 'execution_or_correction' && d.privateAnswerIncluded === false && event.actorId === store.actor.id && event.messageId === null, 'm1_order_violation');
    demand(!events.some(e => e.kind === 'disclosure') && !messages.some(m => m.kind === 'correction' || m.kind === 'result'), 'm1_order_violation');
  } else if (event.kind === 'boundary') {
    const stage = string(d.stage);
    if (stage === 'request') {
      keys(d, ['stage']);
      const message = sourceMessage(store, event);
      demand(message.kind === 'request' && message.sender === store.actor.id, 'source_mismatch');
      demand(!events.some(e => e.data.stage === 'request') && !messages.some(m => ['understanding', 'correction', 'result'].includes(m.kind)), 'm1_order_violation');
    } else if (stage === 'execution' || stage === 'correction') {
      keys(d, ['stage', 'disclosureId']);
      const disclosure = prior(store, manifest, d.disclosureId, 'disclosure');
      const message = sourceMessage(store, event);
      demand(message.sender === store.actor.id && message.kind === (stage === 'execution' ? 'request' : 'correction'), 'source_mismatch');
      demand(!events.some(e => e.data.stage === stage) && !messages.some(m => m.kind === 'result'), 'm1_order_violation');
      laterMessage(store, message, disclosure);
    } else if (stage === 'result') {
      keys(d, ['stage', 'executionId']);
      const execution = prior(store, manifest, d.executionId, 'boundary', 'execution');
      const message = sourceMessage(store, event);
      const instruction = sourceMessage(store, execution);
      demand(message.kind === 'result' && instruction.recipients.includes(message.sender) && message.sender !== instruction.sender, 'source_mismatch');
      demand(!events.some(e => e.data.stage === 'result'), 'm1_order_violation');
      laterMessage(store, message, execution);
    } else if (stage === 'not_applicable') {
      keys(d, ['stage', 'requirementId', 'reason']);
      demand(manifest.requiredObservations.some(r => r.id === d.requirementId && r.conditional), 'source_mismatch');
      string(d.reason);
      demand(event.messageId === null && event.actorId === store.actor.id);
    } else if (stage === 'start' || stage === 'end') {
      keys(d, ['stage']);
      demand(event.messageId === null && !events.some(e => e.kind === 'boundary' && e.data.stage === stage), 'conflict');
    } else if (stage === 'wait_inventory') {
      keys(d, ['stage', 'waitIds']);
      demand(Array.isArray(d.waitIds) && new Set(d.waitIds.map(identifier)).size === d.waitIds.length);
      demand(event.messageId === null && !events.some(e => e.data.stage === stage), 'conflict');
    } else if (stage === 'session') {
      keys(d, ['stage', 'connectionRef', 'sessionRef', 'actualConversationId', 'fresh', 'evidenceRef']);
      const actor = manifest.actors.find(a => a.actorId === event.actorId);
      demand(actor && actor.connectionRef === d.connectionRef && actor.sessionRef === d.sessionRef, 'source_mismatch');
      demand(d.actualConversationId === null || typeof d.actualConversationId === 'string');
      demand(d.fresh === null || typeof d.fresh === 'boolean');
      identifier(d.evidenceRef);
    } else if (stage === 'offscreen') {
      keys(d, ['stage', 'status', 'evidenceRef']);
      demand(['unknown', 'not_disclosed', 'disclosed_before_result'].includes(String(d.status)));
      identifier(d.evidenceRef);
      if (d.status === 'not_disclosed') demand(events.some(e => e.data.stage === 'result'), 'm1_order_violation');
    } else if (stage === 'direct_resource') {
      keys(d, ['stage', 'resource', 'method', 'value', 'unit', 'target', 'sensor', 'startedAt', 'endedAt']);
      demand(['power', 'cloudRAM', 'cloudGPU', 'cloudKV'].includes(String(d.resource)) && d.method === 'direct');
      finite(d.value); identifier(d.unit); identifier(d.target); identifier(d.sensor);
      const start = timestamp(d.startedAt), end = timestamp(d.endedAt);
      demand(start !== null && end !== null && Date.parse(end) >= Date.parse(start));
    } else demand(false, 'not_implemented');
  } else if (event.kind === 'wait') {
    keys(d, ['waitId', 'edge']);
    identifier(d.waitId);
    demand(d.edge === 'start' || d.edge === 'end');
    demand(event.messageId === null && !events.some(e => e.kind === 'wait' && e.data.waitId === d.waitId && e.data.edge === d.edge), 'conflict');
  } else if (event.kind === 'outcome') {
    demand(events.some(e => e.kind === 'understanding') && events.some(e => e.kind === 'disclosure'), 'm1_order_violation');
    keys(d, ['status', 'resultId', 'evaluatorId', 'rubricHash', 'literal', 'intentChecks', 'stopReason']);
    demand(['success', 'failure', 'incomplete', 'unknown'].includes(String(d.status)));
    demand(d.rubricHash === manifest.rubricHash, 'source_mismatch');
    identifier(d.evaluatorId);
    demand(event.actorId === store.actor.id && event.messageId === null, 'unauthorised');
    demand(!events.some(e => e.kind === 'outcome'), 'conflict');
    if (d.resultId !== null) prior(store, manifest, d.resultId, 'boundary', 'result');
    else demand(d.status === 'incomplete' || d.status === 'unknown', 'm1_order_violation');
    if (d.literal !== null) {
      demand(d.resultId !== null, 'm1_order_violation');
      const literal = object(d.literal);
      keys(literal, ['expected', 'observed', 'evidenceRef']);
      canonical(literal.expected); canonical(literal.observed); identifier(literal.evidenceRef);
    }
    demand(Array.isArray(d.intentChecks));
    const ids: string[] = [];
    for (const raw of d.intentChecks) {
      const check = object(raw);
      keys(check, ['id', 'status', 'evidenceRef', 'messageId']);
      ids.push(identifier(check.id));
      demand(manifest.intentCheckIds.includes(String(check.id)), 'source_mismatch');
      demand(['pass', 'fail', 'unknown'].includes(String(check.status)));
      if (check.status !== 'unknown') {
        identifier(check.evidenceRef);
        const message = store.get<Message>('message', identifier(check.messageId));
        demand(message && message.runId === event.runId && message.languageVersion === event.languageVersion && (message.sender === store.actor.id || message.recipients.includes(store.actor.id)), 'source_mismatch');
      } else { demand(check.evidenceRef === null && check.messageId === null); }
    }
    demand(new Set(ids).size === ids.length);
    demand(d.stopReason === null || typeof d.stopReason === 'string');
    if (d.status === 'incomplete') string(d.stopReason);
  } else if (event.kind === 'memory') {
    parseMemory(d);
    demand(event.messageId === null);
  }
}
function parseMemory(d: Record<string, unknown>): MemoryData {
  keys(d, ['target', 'samplingScheme', 'samplingIntervalMs', 'pid', 'processRef', 'processStartRef', 'nodeVersion', 'operation', 'parentIncluded', 'childrenIncluded', 'samples']);
  demand(d.target === 'm1-cli' && d.samplingScheme === 'operation-boundaries' && d.samplingIntervalMs === null && d.parentIncluded === false && d.childrenIncluded === false);
  const pid = finite(d.pid); demand(Number.isSafeInteger(pid) && pid > 0);
  demand(Array.isArray(d.samples));
  const samples = d.samples.map(raw => {
    const s = object(raw);
    keys(s, ['boundary', 'observedAt', 'monotonicMs', 'rssBytes', 'heapUsedBytes']);
    const observedAt = timestamp(s.observedAt); demand(observedAt !== null);
    const rssBytes = finite(s.rssBytes), heapUsedBytes = finite(s.heapUsedBytes);
    demand(Number.isSafeInteger(rssBytes) && Number.isSafeInteger(heapUsedBytes));
    return { boundary: identifier(s.boundary), observedAt, monotonicMs: finite(s.monotonicMs), rssBytes, heapUsedBytes };
  });
  demand(samples.every((s, i) => i === 0 || s.monotonicMs >= samples[i - 1]!.monotonicMs));
  return { target: d.target, samplingScheme: d.samplingScheme, samplingIntervalMs: null, pid, processRef: identifier(d.processRef), processStartRef: identifier(d.processStartRef), nodeVersion: identifier(d.nodeVersion), operation: identifier(d.operation), parentIncluded: false, childrenIncluded: false, samples };
}
function accessibleRun(store: HubStore, id: string): Run {
  const run = store.get<Run>('run', id);
  demand(run, 'unknown_run');
  demand(run.actors.includes(store.actor.id), 'unauthorised');
  return run;
}
function manifestFor(store: HubStore, id: string): Manifest {
  const manifest = store.get<Manifest>('m1_manifest', id);
  demand(manifest, 'unknown_manifest');
  accessibleRun(store, manifest.runId);
  return manifest;
}
function hash(value: unknown): string {
  const text = string(value);
  demand(/^[a-f0-9]{64}$/u.test(text));
  return text;
}
function parseManifest(store: HubStore, v: Record<string, unknown>): Manifest {
  keys(v, ['kind', 'schema', 'id', 'experimentId', 'runId', 'languageVersion', 'scope', 'formationManifestId', 'inputHash', 'rubricHash', 'intentCheckIds', 'head', 'sourceRef', 'actors', 'requiredObservations']);
  demand(v.schema === 'semevolve-m1-1' && (v.scope === 'formation' || v.scope === 'task'));
  const run = accessibleRun(store, identifier(v.runId));
  demand(v.languageVersion === run.languageVersion, 'language_mismatch');
  demand((v.scope === 'formation') === (run.condition === 'formation'), 'phase_mismatch');
  demand(Array.isArray(v.actors) && v.actors.length === run.actors.length);
  const actors = v.actors.map(raw => {
    const a = object(raw);
    keys(a, ['actorId', 'connectionRef', 'sessionRef']);
    const actorId = identifier(a.actorId);
    demand(run.actors.includes(actorId), 'unauthorised');
    const row = store.db.prepare('SELECT profile FROM principals WHERE id=?').get(actorId);
    demand(row, 'unknown_actor');
    const profile = object(JSON.parse(String(row.profile)));
    demand(a.connectionRef === profile.connectionRef && a.sessionRef === profile.sessionRef, 'source_mismatch');
    return { actorId, connectionRef: identifier(a.connectionRef), sessionRef: identifier(a.sessionRef) };
  });
  demand(new Set(actors.map(a => a.actorId)).size === actors.length);
  demand(Array.isArray(v.requiredObservations) && v.requiredObservations.length > 0);
  const requiredObservations = v.requiredObservations.map((raw): Requirement => {
    const r = object(raw);
    keys(r, ['id', 'type', 'actorId', 'direction', 'category', 'conditional']);
    demand(r.type === 'measurement' || r.type === 'event');
    demand(r.direction === 'input' || r.direction === 'output' || r.direction === 'none');
    demand(typeof r.conditional === 'boolean');
    const actorId = identifier(r.actorId);
    demand(run.actors.includes(actorId), 'unauthorised');
    return { id: identifier(r.id), type: r.type, actorId, direction: r.direction, category: identifier(r.category), conditional: r.conditional };
  });
  demand(new Set(requiredObservations.map(r => r.id)).size === requiredObservations.length);
  const formationManifestId = v.formationManifestId === null ? null : identifier(v.formationManifestId);
  if (formationManifestId !== null) {
    const formation = manifestFor(store, formationManifestId);
    demand(v.scope === 'task' && formation.scope === 'formation' && formation.experimentId === v.experimentId && formation.runId !== run.id, 'source_mismatch');
  }
  return { kind: 'manifest', schema: v.schema, id: identifier(v.id), experimentId: identifier(v.experimentId), runId: run.id, languageVersion: run.languageVersion, scope: v.scope, formationManifestId,
    inputHash: hash(v.inputHash), rubricHash: hash(v.rubricHash), intentCheckIds: strings(v.intentCheckIds), head: identifier(v.head), sourceRef: identifier(v.sourceRef), actors, requiredObservations };
}
export function captureM1(store: HubStore, input: unknown): unknown {
  const v = object(JSON.parse(canonical(input)));
  if (v.kind === 'close') {
    keys(v, ['kind', 'id', 'manifestId', 'sourceRef']);
    const manifest = manifestFor(store, identifier(v.manifestId));
    const id = identifier(v.id), sourceRef = identifier(v.sourceRef);
    const previous = store.get<Snapshot>('m1_report', id);
    if (previous) {
      demand(previous.manifestId === manifest.id && previous.sourceRef === sourceRef, 'conflict');
      return previous;
    }
    const report = buildReport(store, manifest);
    return store.put('m1_report', id, { id, manifestId: manifest.id, sourceRef, recordedAt: new Date().toISOString(), reportHash: digest(canonical(report)), report });
  }
  if (v.kind === 'manifest') {
    const manifest = parseManifest(store, v);
    const previous = store.get<Manifest>('m1_manifest', manifest.id);
    if (previous) return store.put('m1_manifest', manifest.id, manifest);
    demand(!store.list<Manifest>('m1_manifest').some(m => m.runId === manifest.runId), 'conflict');
    demand(!store.list<Message>('message').some(m => m.runId === manifest.runId), 'm1_order_violation');
    return store.put('m1_manifest', manifest.id, manifest);
  }
  keys(v, ['kind', 'id', 'manifestId', 'runId', 'languageVersion', 'actorId', 'messageId', 'sourceRef', 'observedAt', 'clock', 'unknownReason', 'data']);
  demand(v.kind === 'boundary' || v.kind === 'wait' || v.kind === 'understanding' || v.kind === 'disclosure' || v.kind === 'outcome' || v.kind === 'memory');
  const manifest = manifestFor(store, identifier(v.manifestId));
  demand(v.runId === manifest.runId && v.languageVersion === manifest.languageVersion, 'source_mismatch');
  demand(manifest.actors.some(a => a.actorId === v.actorId), 'source_mismatch');
  const event: Observation = { kind: v.kind, id: identifier(v.id), manifestId: manifest.id, runId: manifest.runId, languageVersion: manifest.languageVersion, actorId: identifier(v.actorId), messageId: v.messageId === null ? null : identifier(v.messageId), sourceRef: identifier(v.sourceRef), observedAt: timestamp(v.observedAt), clock: clockValue(v.clock), unknownReason: v.unknownReason === null ? null : string(v.unknownReason), data: object(v.data), recordedAt: new Date().toISOString(), payloadHash: digest(canonical(v)) };
  demand((event.observedAt !== null && event.clock !== null) || event.unknownReason !== null);
  const previous = store.get<Observation>('m1_event', event.id);
  if (previous) {
    demand(previous.payloadHash === event.payloadHash, 'conflict');
    return previous;
  }
  validateProtocol(store, manifest, event);
  return store.put('m1_event', event.id, event);
}
export interface Missing extends Requirement { runId: string; reason: string }
function coverage(manifest: Manifest, measurements: Measurement[], events: Observation[]): Missing[] {
  return manifest.requiredObservations.flatMap(r => {
    const candidates = r.type === 'measurement'
      ? measurements.filter(e => e.occurrenceId === r.id && e.actorId === r.actorId && e.direction === r.direction && e.category === r.category)
      : events.filter(e => e.id === r.id && e.actorId === r.actorId && (e.kind === r.category || e.data.stage === r.category));
    if (candidates.length > 0) return [];
    if (r.conditional && events.some(e => e.kind === 'boundary' && e.data.stage === 'not_applicable' && e.data.requirementId === r.id)) return [];
    return [{ ...r, runId: manifest.runId, reason: 'required_observation_missing' }];
  });
}
function tokenTotals(measurements: Measurement[], missing: Missing[], includeTranslation = false) {
  const counted = measurements.filter(e => e.direction !== 'none' && (includeTranslation || e.phase !== 'human_translation'));
  const observedSubtotal = counted.reduce((n, e) => n + (e.tokens ?? 0), 0);
  return { observedSubtotal, completeTotal: counted.length === 0 || counted.some(e => e.tokens === null) || missing.some(r => r.type === 'measurement' && (includeTranslation || r.category !== 'translation')) ? null : observedSubtotal };
}
type Interval = [number, number];
function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [start, end] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}
const duration = (intervals: Interval[]): number => union(intervals).reduce((n, [start, end]) => n + end - start, 0);
function sameClock(a: Observation, b: Observation): boolean {
  return a.clock !== null && b.clock !== null && a.clock.host === 'raytrek' && b.clock.host === a.clock.host && a.clock.processRef === b.clock.processRef && a.clock.utcSource === b.clock.utcSource;
}
function interval(a: Observation | undefined, b: Observation | undefined): Interval | null {
  if (!a || !b || a.observedAt === null || b.observedAt === null || !sameClock(a, b) || !a.clock || !b.clock) return null;
  const start = Date.parse(a.observedAt), end = Date.parse(b.observedAt);
  const mono = b.clock.monotonicMs - a.clock.monotonicMs;
  if (end < start || mono < 0 || Math.abs(end - start - mono) > a.clock.resolutionMs + b.clock.resolutionMs) return null;
  return [start, end];
}
function timeTotals(manifests: Manifest[], events: Observation[]) {
  const missing: string[] = [];
  const phases: Interval[] = [];
  const waits: Interval[] = [];
  const anchors: Observation[] = [];
  let waitsComplete = true;
  for (const m of manifests) {
    const selected = events.filter(e => e.manifestId === m.id);
    const start = selected.find(e => e.kind === 'boundary' && e.data.stage === 'start');
    const end = selected.find(e => e.kind === 'boundary' && e.data.stage === 'end');
    const range = interval(start, end);
    if (range && start) { phases.push(range); anchors.push(start); }
    else missing.push(m.runId + ':boundary_or_clock');
    const inventory = selected.find(e => e.kind === 'boundary' && e.data.stage === 'wait_inventory');
    const waitIds = new Set(selected.filter(e => e.kind === 'wait').map(e => String(e.data.waitId)));
    if (inventory) for (const id of inventory.data.waitIds as string[]) waitIds.add(id);
    else { waitsComplete = false; missing.push(m.runId + ':wait_inventory'); }
    for (const id of waitIds) {
      const first = selected.find(e => e.kind === 'wait' && e.data.waitId === id && e.data.edge === 'start');
      const last = selected.find(e => e.kind === 'wait' && e.data.waitId === id && e.data.edge === 'end');
      const wait = interval(first, last);
      if (wait && start && first && sameClock(start, first) && (interval(start, first) || interval(first, start)) && inventory && (inventory.data.waitIds as string[]).includes(id)) waits.push(wait);
      else { waitsComplete = false; missing.push(m.runId + ':wait:' + id); }
    }
  }
  const first = anchors[0];
  const compatible = first !== undefined && anchors.every(a => sameClock(first, a) && (interval(first, a) !== null || interval(a, first) !== null));
  if (!compatible && phases.length > 0) missing.push('phase_clock_domains');
  const complete = phases.length === manifests.length && compatible;
  const grossMs = complete ? duration(phases) : null;
  const merged = union(phases);
  const start = merged[0], end = merged.at(-1);
  const spanMs = complete && start && end ? end[1] - start[0] : null;
  const clipped = phases.flatMap(([a, b]) => waits.map(([c, d]): Interval => [Math.max(a, c), Math.min(b, d)]).filter(([a, b]) => b >= a));
  const waitUnionMs = complete && waitsComplete ? duration(clipped) : null;
  return { grossMs, waitUnionMs, activeMs: grossMs !== null && waitUnionMs !== null ? grossMs - waitUnionMs : null, spanMs, interphaseGapMs: spanMs !== null && grossMs !== null ? spanMs - grossMs : null, observedPhaseSubtotalMs: duration(phases), missing, synchronisationVerified: false, scope: 'raytrek observer intervals, not provider processing time' };
}
function scopeReport(manifests: Manifest[], measurements: Measurement[], events: Observation[]) {
  const ids = new Set(manifests.map(m => m.runId));
  const selected = measurements.filter(e => ids.has(e.runId));
  const missing = manifests.flatMap(m => coverage(m, selected.filter(e => e.runId === m.runId), events.filter(e => e.manifestId === m.id)));
  return { runIds: [...ids], tokens: tokenTotals(selected, missing), tokensIncludingTranslation: tokenTotals(selected, missing, true), time: timeTotals(manifests, events), missingObservations: missing };
}
function memoryTotals(events: Observation[]) {
  const processes = events.filter(e => e.kind === 'memory').map(e => {
    const data = parseMemory(e.data);
    const intervalsMs = data.samples.slice(1).map((s, i) => s.monotonicMs - data.samples[i]!.monotonicMs);
    return { ...data, eventId: e.id, sourceRef: e.sourceRef, runId: e.runId, intervalsMs, minIntervalMs: intervalsMs.length ? Math.min(...intervalsMs) : null, maxIntervalMs: intervalsMs.length ? Math.max(...intervalsMs) : null, window: { start: data.samples[0]?.observedAt ?? null, end: data.samples.at(-1)?.observedAt ?? null }, observedMaxRssBytes: data.samples.length ? Math.max(...data.samples.map(s => s.rssBytes)) : null, observedMaxHeapUsedBytes: data.samples.length ? Math.max(...data.samples.map(s => s.heapUsedBytes)) : null };
  });
  const samples = processes.flatMap(p => p.samples);
  return { processes, sampleCount: samples.length, observedMaxRssBytes: samples.length ? Math.max(...samples.map(s => s.rssBytes)) : null, observedMaxHeapUsedBytes: samples.length ? Math.max(...samples.map(s => s.heapUsedBytes)) : null, truePeakBytes: null, scope: 'Imported M1 CLI boundary samples only; not host, parent, child, agent or cloud memory.' };
}
function outcomeReport(events: Observation[], manifest: Manifest) {
  const event = events.find(e => e.kind === 'outcome');
  const d = event?.data;
  const checks = (d?.intentChecks ?? []) as { id: string; status: string }[];
  const missingIntentChecks = manifest.intentCheckIds.filter(id => !checks.some(c => c.id === id));
  const intentStatus = checks.some(c => c.status === 'fail') ? 'fail' : checks.length === 0 || missingIntentChecks.length > 0 || checks.some(c => c.status === 'unknown') ? 'unknown' : 'pass';
  const literal = d?.literal ? object(d.literal) : null;
  const literalStatus = literal === null || literal.observed === null ? 'unknown' : canonical(literal.expected) === canonical(literal.observed) ? 'pass' : 'fail';
  const status = d?.status === 'incomplete' ? 'incomplete' : d?.status === 'failure' || literalStatus === 'fail' || intentStatus === 'fail' ? 'failure' : d?.status === 'success' && literalStatus === 'pass' && intentStatus === 'pass' ? 'success' : 'unknown';
  return { status, claimedStatus: d?.status ?? 'unknown', literalStatus, intentStatus, missingIntentChecks, stopReason: d?.stopReason ?? null, assessment: 'operator_literal_evidence_only', evidence: event ?? null };
}
function resourceReport(events: Observation[], resource: string) {
  const readings = events.filter(e => e.kind === 'boundary' && e.data.stage === 'direct_resource' && e.data.resource === resource).map(e => ({ ...e.data, value: finite(e.data.value), unit: string(e.data.unit), eventId: e.id, sourceRef: e.sourceRef, runId: e.runId }));
  if (readings.length === 0) return { value: null, status: 'measurement-unavailable', label: '測定不能' };
  const single = readings.length === 1 ? readings[0] : undefined;
  return { value: single?.value ?? null, unit: single?.unit ?? null, status: 'direct-readings', label: '直接観測', readings };
}
function buildReport(store: HubStore, manifest: Manifest) {
  const manifests = [manifest];
  if (manifest.formationManifestId !== null) manifests.push(manifestFor(store, manifest.formationManifestId));
  const ids = new Set(manifests.map(m => m.runId));
  const measurements = store.list<Measurement>('measurement').filter(m => ids.has(m.runId));
  const events = store.list<Observation>('m1_event').filter(e => manifests.some(m => m.id === e.manifestId));
  const withoutFormation = scopeReport([manifest], measurements, events);
  const withFormation = scopeReport(manifests, measurements, events);
  const translations = measurements.filter(e => e.phase === 'human_translation' && e.direction !== 'none');
  const taskEvents = events.filter(e => e.manifestId === manifest.id);
  const protocolViolations = store.list<Message>('message').filter(m => m.runId === manifest.runId && ['correction', 'result'].includes(m.kind) && !taskEvents.some(e => e.messageId === m.id && e.kind === 'boundary')).map(m => 'untracked_' + m.kind + ':' + m.id);
  return {
    schema: 'semevolve-m1-report-1', manifestId: manifest.id, manifests, tokenizer, withoutFormation, withFormation,
    missingObservations: withFormation.missingObservations,
    observationIds: events.map(e => e.id), observations: events,
    measurements: measurements.map(e => ({ ...e, textHash: e.text === null ? null : digest(e.text) })),
    translationTokens: { observedSubtotal: translations.reduce((n, e) => n + (e.tokens ?? 0), 0), completeTotal: translations.length === 0 || translations.some(e => e.tokens === null) ? null : translations.reduce((n, e) => n + (e.tokens ?? 0), 0) },
    providerUsage: measurements.filter(e => e.providerUsage !== null).map(e => ({ runId: e.runId, eventId: e.eventId, sourceRef: e.sourceRef, usage: e.providerUsage })),
    providerInternalContext: null, actualCost: null,
    resources: { power: resourceReport(events, 'power'), cloudRAM: resourceReport(events, 'cloudRAM'), cloudGPU: resourceReport(events, 'cloudGPU'), cloudKV: resourceReport(events, 'cloudKV') },
    localMemory: memoryTotals(events), outcome: outcomeReport(taskEvents, manifest),
    protocol: { violations: protocolViolations, offscreenDisclosure: taskEvents.find(e => e.data.stage === 'offscreen')?.data.status ?? 'unknown', assessment: 'recorded_evidence_only' },
    limits: ['Observed exchange text only; hidden provider context is unknown.', 'Operator evidence cannot certify offscreen disclosure or semantic correctness.'],
  };
}
interface Snapshot { id: string; manifestId: string; sourceRef: string; recordedAt: string; reportHash: string; report: ReturnType<typeof buildReport> }
export function reportM1(store: HubStore, input: unknown): unknown {
  const v = object(input);
  keys(v, ['manifestId', 'snapshotId']);
  const manifest = manifestFor(store, identifier(v.manifestId));
  if (v.snapshotId !== undefined) {
    const snapshot = store.get<Snapshot>('m1_report', identifier(v.snapshotId));
    demand(snapshot && snapshot.manifestId === manifest.id, 'source_mismatch');
    return snapshot;
  }
  return buildReport(store, manifest);
}
