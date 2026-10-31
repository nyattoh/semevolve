import { canonical, demand, HubStore, identifier, keys, object, openStore, prepareStore, result, string } from './hub-store.js';
import type { Result, PreparedHub } from './hub-store.js';
import { completeFixtureSettings, fixtureDefinition, language, m0Conditions, message, readinessEvidence, run } from './hub-data.js';
import type { Delivery, Fixture, Language, Message, ReadinessEvidence, Run, Translation } from './hub-data.js';
import { encodeText, measurement, summarise, tokenizer } from './hub-measurement.js';
import type { Measurement } from './hub-measurement.js';
import { captureM1, reportM1 } from './hub-m1.js';
export type { Result, PreparedHub } from './hub-store.js';

export function tokenise(input: unknown) { return result(() => encodeText(input)); }

export function prepareHub(input: unknown): Result<PreparedHub> {
  return result(() => prepareStore(input));
}

export function createHub(input: unknown): Result<Hub> {
  return result(() => new Hub(openStore(input)));
}

export class Hub {
  constructor(private readonly store: HubStore) {}
  captureM1(input: unknown) {
    return result(() => this.store.transaction(() => {
      this.joined();
      demand(this.store.actor.role === 'pm', 'unauthorised');
      return captureM1(this.store, input);
    }));
  }
  reportM1(input: unknown) {
    return result(() => this.store.transaction(() => {
      this.joined();
      demand(this.store.actor.role === 'pm', 'unauthorised');
      return reportM1(this.store, input);
    }));
  }
  identity() {
    const { id, role, connectionRef, sessionRef } = this.store.actor;
    return { actorId: id, role, connectionRef, sessionRef };
  }
  close(): Result<null> { return result(() => { this.store.close(); return null; }); }
  recordReadiness(input: unknown): Result<ReadinessEvidence> {
    return result(() => this.store.transaction(() => {
      this.joined();
      demand(this.store.actor.role === 'pm', 'unauthorised');
      const evidence = readinessEvidence(input);
      evidence.fixtureIds.forEach(id => demand(this.store.get('fixture', id), 'unknown_fixture'));
      return this.store.put('readiness', evidence.id, evidence);
    }));
  }
  checkM0() {
    return result(() => this.store.transaction(() => {
      this.joined();
      demand(this.store.actor.role === 'pm', 'unauthorised');
      const evidence = this.store.list<ReadinessEvidence>('readiness');
      const conditions = m0Conditions.map(condition => {
        const latest = evidence.filter(e => e.condition === condition.id).at(-1);
        const facts = latest?.facts ?? Object.fromEntries(condition.fields.map(field => [field, null]));
        const unknown: string[] = condition.fields.filter(field => !facts[field]?.trim());
        if (!latest?.evidenceRefs.length) unknown.push('evidenceRefs');
        if (condition.id === 'tokenizer' && latest && (facts.name !== tokenizer.name || facts.version !== tokenizer.version || facts.encoding !== tokenizer.encoding || facts.specialTokens !== tokenizer.specialTokens)) unknown.push('tokenizer_mismatch');
        if (condition.id === 'fixtures') {
          const selected = (latest?.fixtureIds ?? []).map(id => this.store.get<Fixture>('fixture', id));
          if (selected.length !== 6 || selected.some(f => f === undefined)) unknown.push('six_fixtures');
          else if (!selected.every(f => f && completeFixtureSettings(f))) unknown.push('fixture_settings');
        }
        return { id: condition.id, requirement: condition.requirement, status: unknown.length ? 'unknown' : 'confirmed', facts, evidenceRefs: latest?.evidenceRefs ?? [], evidenceId: latest?.id ?? null, sourceRef: latest?.sourceRef ?? null, observedAt: latest?.observedAt ?? null, fixtureIds: latest?.fixtureIds ?? [], unknown };
      });
      return { M0ready: conditions.every(c => c.status === 'confirmed'), assessment: 'operator_evidence_only', conditions };
    }));
  }
  recordMeasurement(input: unknown): Result<Measurement> {
    return result(() => this.store.transaction(() => {
      this.joined();
      const run = this.accessibleRun(identifier(object(input).runId));
      const value = measurement(input, this.store.actor.id, run.languageVersion);
      demand(value.phase !== 'v0_formation' || run.condition === 'formation', 'phase_mismatch');
      demand(run.condition !== 'formation' || ['v0_formation', 'human_translation', 'paste_waiting'].includes(value.phase), 'phase_mismatch');
      if (value.messageId !== null) {
        const source = this.accessibleMessage(value.messageId);
        demand(source.runId === value.runId && source.languageVersion === value.languageVersion, 'source_mismatch');
        if (value.direction === 'input') {
          demand(value.recipientId === this.store.actor.id, 'unauthorised');
          this.delivery(value.messageId);
        } else if (value.direction === 'output') {
          demand(source.sender === this.store.actor.id && value.recipientId === null, 'unauthorised');
        }
        if (value.direction !== 'none' && value.phase !== 'human_translation') demand(value.text === null || value.text === source.body, 'source_mismatch');
      } else demand(value.recipientId === null, 'invalid_input');
      const eventKey = canonical([value.runId, value.eventId]);
      const occurrenceKey = canonical([value.runId, value.occurrenceId]);
      const previous = this.store.get<Measurement>('measurement', eventKey);
      if (previous) return this.store.put('measurement', eventKey, value);
      const occurrence = this.store.get<{ eventId: string }>('occurrence', occurrenceKey);
      if (occurrence) {
        const original = this.store.get<Measurement>('measurement', canonical([value.runId, occurrence.eventId]));
        demand(original && canonical({ ...original, eventId: value.eventId }) === canonical(value), 'conflict');
        return original;
      }
      this.store.put('measurement', eventKey, value);
      this.store.put('occurrence', occurrenceKey, { eventId: value.eventId });
      if (value.messageId !== null && value.direction === 'input') {
        this.store.db.prepare('UPDATE deliveries SET applied_at=COALESCE(applied_at,?) WHERE message_id=? AND recipient_id=?').run(new Date().toISOString(), value.messageId, this.store.actor.id);
      }
      return value;
    }));
  }
  measurements(input: unknown) {
    return result(() => this.store.transaction(() => {
      this.joined();
      const request = object(input);
      keys(request, ['runIds']);
      demand(Array.isArray(request.runIds) && request.runIds.length > 0);
      const runs = [...new Set(request.runIds.map(identifier))].map(id => this.accessibleRun(id));
      const formationRunIds = [...new Set(runs.flatMap(r => r.formationRunId === null ? [] : [r.formationRunId]))];
      const formationRuns = formationRunIds.flatMap(id => {
        const formation = this.store.get<Run>('run', id);
        demand(formation, 'unknown_run');
        return formation.actors.includes(this.store.actor.id) ? [formation] : [];
      });
      const ids = new Set([...runs.map(r => r.id), ...formationRuns.map(r => r.id)]);
      const events = this.store.list<Measurement>('measurement').filter(e => ids.has(e.runId));
      const requiredFormations = formationRunIds.map(id => ({ id, condition: 'formation' as const }));
      return {
        tokenizer, ...summarise(events, formationRunIds, [...runs, ...requiredFormations]),
        events: events.map(e => e.actorId === this.store.actor.id ? e : { ...e, text: null, textRef: null, sourceRef: 'redacted' }),
      };
    }));
  }
  private accessibleMessage(id: string): Message {
    const source = this.store.get<Message>('message', id);
    demand(source, 'unknown_message');
    demand(source.sender === this.store.actor.id || source.recipients.includes(this.store.actor.id), 'unauthorised');
    return source;
  }
  translate(input: unknown): Result<Translation[]> {
    return result(() => this.store.transaction(() => {
      this.joined();
      const v = object(input);
      const source = this.accessibleMessage(identifier(v.sourceMessageId));
      if (v.id === undefined) keys(v, ['sourceMessageId']);
      else {
        keys(v, ['id', 'sourceMessageId', 'runId', 'languageVersion', 'targetLanguage', 'text', 'sourceRef']);
        demand(v.runId === source.runId && v.languageVersion === source.languageVersion, 'source_mismatch');
        const translation: Translation = {
          id: identifier(v.id), sourceMessageId: source.id, runId: source.runId, languageVersion: source.languageVersion,
          targetLanguage: string(v.targetLanguage), text: string(v.text, true), sourceRef: identifier(v.sourceRef), authorId: this.store.actor.id, meaningVerified: false,
        };
        this.store.put('translation', translation.id, translation);
      }
      return this.store.list<Translation>('translation').filter(t => t.sourceMessageId === source.id);
    }));
  }
  private accessibleRun(id: string): Run {
    const value = this.store.get<Run>('run', id);
    demand(value, 'unknown_run');
    demand(value.actors.includes(this.store.actor.id), 'unauthorised');
    return value;
  }
  private ownRecipient(input: Record<string, unknown>): void {
    demand(input.recipientId === undefined || input.recipientId === this.store.actor.id, 'unauthorised');
  }
  private delivery(messageId: string): Delivery {
    const row = this.store.db.prepare('SELECT acked_at,applied_at FROM deliveries WHERE message_id=? AND recipient_id=?').get(messageId, this.store.actor.id);
    demand(row, 'unauthorised');
    return { messageId, recipientId: this.store.actor.id, ackedAt: row.acked_at === null ? null : String(row.acked_at), appliedAt: row.applied_at === null ? null : String(row.applied_at), understanding: null, taskCompletion: null, evaluation: null };
  }
  send(input: unknown): Result<Message> {
    return result(() => this.store.transaction(() => {
      this.joined();
      const value = message(input, this.store.actor.id);
      const run = this.accessibleRun(value.runId);
      demand(value.languageVersion === run.languageVersion, 'language_mismatch');
      value.recipients.forEach(id => this.knownActor(id));
      demand(value.recipients.every(id => run.actors.includes(id)), 'unauthorised');
      this.store.put('message', value.id, value);
      for (const recipient of value.recipients) {
        this.store.db.prepare('INSERT INTO deliveries VALUES (?,?,NULL,NULL) ON CONFLICT(message_id,recipient_id) DO NOTHING').run(value.id, recipient);
      }
      return value;
    }));
  }
  inbox(input: unknown = {}): Result<Message[]> {
    return result(() => this.store.transaction(() => {
      this.joined();
      const request = object(input);
      keys(request, ['recipientId']);
      this.ownRecipient(request);
      return this.store.db.prepare('SELECT message_id FROM deliveries WHERE recipient_id=? AND acked_at IS NULL ORDER BY rowid').all(this.store.actor.id).map(row => {
        const message = this.store.get<Message>('message', String(row.message_id));
        demand(message, 'unknown_message');
        return message;
      });
    }));
  }
  ack(input: unknown): Result<Delivery> {
    return result(() => this.store.transaction(() => {
      this.joined();
      const request = object(input);
      keys(request, ['messageId', 'recipientId']);
      this.ownRecipient(request);
      const id = identifier(request.messageId);
      demand(this.store.get('message', id), 'unknown_message');
      this.delivery(id);
      this.store.db.prepare('UPDATE deliveries SET acked_at=COALESCE(acked_at,?) WHERE message_id=? AND recipient_id=?').run(new Date().toISOString(), id, this.store.actor.id);
      return this.delivery(id);
    }));
  }
  private joined(): void {
    demand(this.store.db.prepare('SELECT state FROM principals WHERE id=?').get(this.store.actor.id)?.state === 'joined', 'not_joined');
  }
  private knownActor(id: string): void {
    demand(this.store.db.prepare('SELECT id FROM principals WHERE id=?').get(id), 'unknown_actor');
  }
  importRecords(input: unknown): Result<{ imported: number }> {
    return result(() => this.store.transaction(() => {
      this.joined();
      demand(this.store.actor.role === 'pm', 'unauthorised');
      demand(Array.isArray(input));
      for (const item of input) {
        const entry = object(item);
        keys(entry, ['kind', 'value']);
        switch (string(entry.kind)) {
          case 'language': {
            const value = language(entry.value);
            this.store.put('language', value.id, value);
            break;
          }
          case 'run': {
            const value = run(entry.value);
            demand(this.store.get('language', value.languageVersion), 'unknown_language');
            value.actors.forEach(id => this.knownActor(id));
            if (value.rerunOf !== null) {
              const original = this.store.get<Run>('run', value.rerunOf);
              demand(original && original.taskId === value.taskId && original.id !== value.id, 'unknown_run');
            }
            if (value.formationRunId !== null) {
              const formation = this.store.get<Run>('run', value.formationRunId);
              demand(formation?.condition === 'formation' && value.condition === 'internal' && formation.languageVersion === value.languageVersion, 'unknown_run');
            }
            this.store.put('run', value.id, value);
            break;
          }
          case 'fixture': {
            const value = fixtureDefinition(entry.value);
            [value.roles.sender, ...value.roles.recipients].forEach(id => this.knownActor(id));
            this.store.put('fixture', value.id, value);
            break;
          }
          default: demand(false, 'invalid_input', 'Unknown import record kind.');
        }
      }
      return { imported: input.length };
    }));
  }
  inspect() {
    return result(() => this.store.transaction(() => {
      this.joined();
      const runs = this.store.list<Run>('run').filter(r => r.actors.includes(this.store.actor.id));
      const messages = this.store.list<Message>('message').filter(m => m.sender === this.store.actor.id || m.recipients.includes(this.store.actor.id));
      return {
        identity: this.identity(),
        languages: this.store.list<Language>('language').filter(v => runs.some(r => r.languageVersion === v.id) || this.store.actor.role === 'pm'),
        runs,
        fixtures: this.store.actor.role === 'pm' ? this.store.list<Fixture>('fixture') : [],
        messages,
        deliveries: messages.filter(m => m.recipients.includes(this.store.actor.id)).map(m => this.delivery(m.id)),
      };
    }));
  }
  join(input: unknown = {}): Result<{ actorId: string; state: 'joined' }> {
    return result(() => this.store.transaction(() => {
      const request = object(input);
      keys(request, ['id', 'connectionRef', 'sessionRef']);
      const actor = this.store.actor;
      demand(request.id === undefined || request.id === actor.id, 'unauthorised');
      demand(request.connectionRef === undefined || request.connectionRef === actor.connectionRef, 'conflict');
      demand(request.sessionRef === undefined || request.sessionRef === actor.sessionRef, 'conflict');
      this.store.db.prepare("UPDATE principals SET state='joined' WHERE id=?").run(actor.id);
      return { actorId: actor.id, state: 'joined' };
    }));
  }
  leave(): Result<{ actorId: string; state: 'left' }> {
    return result(() => this.store.transaction(() => {
      this.store.db.prepare("UPDATE principals SET state='left' WHERE id=?").run(this.store.actor.id);
      return { actorId: this.store.actor.id, state: 'left' };
    }));
  }
}
