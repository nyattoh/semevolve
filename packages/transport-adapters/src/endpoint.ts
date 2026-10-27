import {
  canonicalJson, digestJson, hostIdentity, isUtcTimestamp, parseEnvelope,
  type AuditEvent, type CheckExecution, type ContractError, type Envelope, type EnvelopeContext, type EnvelopeRejection,
  type HostIdentity, type JsonValue, type MessageId, type PeerId, type Result,
  type StoredMessage, type StoreMutation, type StoreSnapshot, type TaskId, type TaskStore,
} from '@semevolve/core';
import type { DeliveryReceipt, InboxRecord, OutboxRecord, ReceivedEnvelope, TransportAdapter } from './contracts/transport.js';

export const transportMutableCollections = Object.freeze(['transport.outbox', 'transport.inbox', 'transport.state']);

export type TransportError = ContractError | {
  readonly code: 'transport_refused';
  readonly reason: EnvelopeRejection | 'language_unavailable' | 'policy_denied' | 'missing_message' | 'invalid_receipt' | 'invalid_observation';
};

export interface TransportApplication {
  readonly state: JsonValue;
  readonly observation: CheckExecution | null;
}

export interface TransportEndpointOptions {
  readonly store: TaskStore;
  readonly peerId: PeerId;
  readonly identity?: HostIdentity;
  readonly adapterFor: (recipientId: PeerId) => TransportAdapter;
  readonly context: (envelope: Envelope, recipientId: PeerId) => Promise<Result<EnvelopeContext>>;
  readonly checkLanguage: (envelope: Envelope, recipientId: PeerId) => Promise<Result<void>>;
  readonly policy: {
    authorise(operation: { readonly taskId: TaskId; readonly name: string; readonly target: string }):
      Promise<{ readonly allowed: true; readonly policyRevision: number } | { readonly allowed: false; readonly reason: string }>;
  };
}

function json(value: unknown): JsonValue { return JSON.parse(canonicalJson(value)) as JsonValue; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function receipt(value: unknown): value is DeliveryReceipt {
  return object(value) && exact(value, ['messageId', 'acceptedAt', 'recipientIds']) && nonempty(value.messageId)
    && isUtcTimestamp(value.acceptedAt) && Array.isArray(value.recipientIds) && value.recipientIds.length > 0
    && value.recipientIds.every(nonempty) && new Set(value.recipientIds).size === value.recipientIds.length;
}
function readOutbox(value: JsonValue): OutboxRecord {
  if (!object(value) || !exact(value, ['messageId', 'recipientId', 'attempts', 'receipt'])
    || !nonempty(value.messageId) || !nonempty(value.recipientId) || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0
    || (value.receipt !== null && (!receipt(value.receipt) || value.receipt.messageId !== value.messageId
      || value.receipt.recipientIds.length !== 1 || value.receipt.recipientIds[0] !== value.recipientId))) throw new Error('Invalid outbox record');
  return value as unknown as OutboxRecord;
}

function readInbox(value: JsonValue): InboxRecord {
  if (!object(value) || !exact(value, ['messageId', 'recipientId', 'receivedAt', 'appliedAt'])
    || !nonempty(value.messageId) || !nonempty(value.recipientId) || !isUtcTimestamp(value.receivedAt)
    || (value.appliedAt !== null && !isUtcTimestamp(value.appliedAt))) throw new Error('Invalid inbox record');
  return value as unknown as InboxRecord;
}

function validObservation(value: unknown): value is CheckExecution {
  if (!object(value) || !exact(value, ['executionId', 'taskId', 'inputDigest', 'performedAt', 'result', 'usage'])
    || !nonempty(value.executionId) || !nonempty(value.taskId) || typeof value.inputDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.inputDigest) || !isUtcTimestamp(value.performedAt)) return false;
  const { result, usage } = value;
  return object(result) && exact(result, ['checkId', 'targetMessageId', 'languageVersionId', 'dimension', 'verdict', 'scope',
    'method', 'evidenceIds', 'evaluatorVersion', 'limitation'])
    && ['checkId', 'targetMessageId', 'languageVersionId', 'scope', 'evaluatorVersion'].every(key => nonempty(result[key]))
    && ['transmission', 'factuality', 'authorisation', 'task_outcome'].includes(String(result.dimension))
    && ['pass', 'fail', 'inconclusive'].includes(String(result.verdict))
    && ['deterministic_test', 'source_check', 'human_review', 'model_judgment'].includes(String(result.method))
    && Array.isArray(result.evidenceIds) && result.evidenceIds.every(nonempty)
    && (result.limitation === null || typeof result.limitation === 'string')
    && object(usage) && exact(usage, ['inputTokens', 'outputTokens', 'reasoningTokens', 'costYen', 'elapsedMs', 'source'])
    && ['inputTokens', 'outputTokens', 'reasoningTokens'].every(key => usage[key] === null || (Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0))
    && (usage.costYen === null || (typeof usage.costYen === 'number' && Number.isFinite(usage.costYen) && usage.costYen >= 0))
    && typeof usage.elapsedMs === 'number' && Number.isFinite(usage.elapsedMs) && usage.elapsedMs >= 0
    && ['provider', 'local_estimate', 'unavailable'].includes(String(usage.source));
}

const pair = (messageId: MessageId, recipientId: PeerId) => canonicalJson([messageId, recipientId]);
const refused = (reason: Extract<TransportError, { code: 'transport_refused' }>['reason']): Result<never, TransportError> =>
  ({ ok: false, error: { code: 'transport_refused', reason } });
const unknown = (): Result<never, TransportError> => ({ ok: false, error: { code: 'unavailable', reason: 'Transport outcome unknown; reconcile the store before retrying' } });
const collision = (id: string): Result<never, TransportError> => ({ ok: false, error: { code: 'id_collision', id } });
const entry = (snapshot: StoreSnapshot, collection: string, id: string) => snapshot.entries.find(row => row.key.collection === collection && row.key.id === id);
const insert = (collection: string, id: string, value: unknown): StoreMutation => ({ kind: 'insert', entry: { key: { collection, id }, value: json(value) } });

export function createTransportEndpoint(options: TransportEndpointOptions) {
  const { store, peerId } = options;
  const identity = options.identity ?? hostIdentity;

  function event(taskId: TaskId, kind: string, data: unknown): AuditEvent {
    return { eventId: identity.newId('event'), taskId, actor: peerId, kind, occurredAt: identity.now(), data: json(data) };
  }

  async function commit<T>(build: (snapshot: StoreSnapshot) => Promise<{
    mutations: readonly StoreMutation[]; events: readonly AuditEvent[]; result: Result<T, TransportError>;
  }>): Promise<Result<T, TransportError>> {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const snapshot = await store.snapshot();
        if (!snapshot.ok) return snapshot;
        const batch = await build(snapshot.value);
        if (!batch.mutations.length && !batch.events.length) return batch.result;
        const saved = await store.transact({ transactionId: identity.newId('transaction'), expectedRevision: snapshot.value.revision,
          mutations: batch.mutations, events: batch.events });
        if (saved.ok) return batch.result;
        if (saved.error.code !== 'revision_conflict' || attempt === 3) return saved;
      }
    } catch { return unknown(); }
    return unknown();
  }

  async function validate(envelope: Envelope, recipientId: PeerId, authenticatedSenderId: PeerId, operation: string) {
    const context = await options.context(envelope, recipientId);
    if (!context.ok) return context;
    const parsed = parseEnvelope(canonicalJson(envelope), { ...context.value, recipientId, authenticatedSenderId });
    if (!parsed.ok) return refused(parsed.error);
    const language = await options.checkLanguage(parsed.value.envelope, recipientId);
    if (!language.ok) return refused('language_unavailable');
    const permission = await options.policy.authorise({ taskId: envelope.task_id, name: operation, target: recipientId });
    if (!permission.allowed) return refused('policy_denied');
    return parsed;
  }

  function message(snapshot: StoreSnapshot, messageId: MessageId): StoredMessage | undefined {
    const row = entry(snapshot, 'transport.messages', messageId);
    if (!row) return undefined;
    const value = row.value;
    if (!object(value) || !exact(value, ['envelope', 'digest']) || !object(value.envelope)
      || value.envelope.message_id !== messageId || value.digest !== digestJson(value.envelope)) throw new Error('Invalid stored message');
    return value as unknown as StoredMessage;
  }

  async function stage(input: Envelope): Promise<Result<StoredMessage, TransportError>> {
    let envelope: Envelope;
    try { envelope = json(input) as unknown as Envelope; } catch { return refused('invalid_format'); }
    return commit(async snapshot => {
      const done = (result: Result<StoredMessage, TransportError>, mutations: StoreMutation[] = [], events: AuditEvent[] = []) => ({ result, mutations, events });
      const existing = message(snapshot, envelope.message_id);
      if (existing && existing.digest !== digestJson(envelope)) return done(collision(envelope.message_id), [],
        [event(existing.envelope.task_id, 'transport.id_collision', { messageId: envelope.message_id, incomingDigest: digestJson(envelope) })]);
      if (!Array.isArray(envelope.recipient_ids) || !envelope.recipient_ids.length) return done(refused('invalid_format'));
      let parsed: StoredMessage | undefined;
      for (const recipientId of envelope.recipient_ids) {
        const result = await validate(envelope, recipientId, peerId, 'transport.send');
        if (!result.ok) return done(result);
        parsed = result.value;
      }
      if (!parsed) return done(refused('invalid_format'));
      const mutations = existing ? [] : [insert('transport.messages', envelope.message_id, parsed)];
      for (const recipientId of envelope.recipient_ids) {
        const key = pair(envelope.message_id, recipientId);
        const previous = entry(snapshot, 'transport.outbox', key);
        if (previous) readOutbox(previous.value);
        else mutations.push(insert('transport.outbox', key, { messageId: envelope.message_id, recipientId, attempts: 0, receipt: null }));
      }
      return done({ ok: true, value: parsed }, mutations, mutations.length ? [event(envelope.task_id, 'transport.staged', { messageId: envelope.message_id })] : []);
    });
  }

  async function dispatch(messageId: MessageId, recipientId: PeerId): Promise<Result<DeliveryReceipt, TransportError>> {
    const attempt = await commit<StoredMessage>(async snapshot => {
      const stored = message(snapshot, messageId);
      const row = entry(snapshot, 'transport.outbox', pair(messageId, recipientId));
      if (!stored || !row) return { result: refused('missing_message'), mutations: [], events: [] };
      const outbox = readOutbox(row.value);
      const valid = await validate(stored.envelope, recipientId, peerId, 'transport.send');
      if (!valid.ok) return { result: valid, mutations: [], events: [] };
      if (!Number.isSafeInteger(outbox.attempts + 1)) throw new Error('Attempts exhausted');
      return { result: { ok: true, value: stored }, mutations: [{ kind: 'replace', entry: { key: row.key,
        value: json({ ...outbox, attempts: outbox.attempts + 1 }) }, expectedDigest: digestJson(row.value) }],
      events: [event(stored.envelope.task_id, 'transport.delivery_attempt', { messageId, recipientId })] };
    });
    if (!attempt.ok) return attempt;
    const stored = attempt.value;
    let delivered: DeliveryReceipt;
    try { delivered = json(await options.adapterFor(recipientId).send(stored.envelope)) as unknown as DeliveryReceipt; }
    catch { return unknown(); }
    if (!receipt(delivered) || delivered.messageId !== messageId || delivered.recipientIds.length !== 1 || delivered.recipientIds[0] !== recipientId) return refused('invalid_receipt');
    return commit(async snapshot => {
      const row = entry(snapshot, 'transport.outbox', pair(messageId, recipientId));
      if (!row) throw new Error('Outbox disappeared');
      const outbox = readOutbox(row.value);
      return { result: { ok: true, value: outbox.receipt ?? delivered }, mutations: outbox.receipt ? [] : [{ kind: 'replace', entry: { key: row.key,
        value: json({ ...outbox, receipt: delivered }) }, expectedDigest: digestJson(row.value) }],
      events: outbox.receipt ? [] : [event(stored.envelope.task_id, 'transport.delivered', { messageId, recipientId })] };
    });
  }

  async function accept(input: ReceivedEnvelope): Promise<Result<InboxRecord, TransportError>> {
    let incoming: ReceivedEnvelope;
    try { incoming = json(input) as unknown as ReceivedEnvelope; } catch { return refused('invalid_format'); }
    if (!object(incoming) || !object(incoming.envelope) || !nonempty(incoming.authenticatedSenderId)
      || !isUtcTimestamp(incoming.receivedAt)) return refused('invalid_format');
    const { envelope } = incoming;
    return commit(async snapshot => {
      const done = (result: Result<InboxRecord, TransportError>, mutations: StoreMutation[] = [], events: AuditEvent[] = []) => ({ result, mutations, events });
      const existing = message(snapshot, envelope.message_id);
      if (existing && existing.digest !== digestJson(envelope)) return done(collision(envelope.message_id), [],
        [event(existing.envelope.task_id, 'transport.id_collision', { messageId: envelope.message_id, incomingDigest: digestJson(envelope) })]);
      const parsed = await validate(envelope, peerId, incoming.authenticatedSenderId, 'transport.receive');
      if (!parsed.ok) return done(parsed, [], nonempty(envelope.task_id) ? [event(envelope.task_id, 'transport.rejected', { messageId: envelope.message_id, error: parsed.error })] : []);
      const key = pair(envelope.message_id, peerId);
      const previous = entry(snapshot, 'transport.inbox', key);
      if (previous) return done({ ok: true, value: readInbox(previous.value) });
      const inbox: InboxRecord = { messageId: envelope.message_id, recipientId: peerId, receivedAt: incoming.receivedAt, appliedAt: null };
      const mutations = existing ? [] : [insert('transport.messages', envelope.message_id, parsed.value)];
      mutations.push(insert('transport.inbox', key, inbox), insert('transport.deliveries', key, incoming));
      return done({ ok: true, value: inbox }, mutations, [event(envelope.task_id, 'transport.received', { messageId: envelope.message_id, recipientId: peerId })]);
    });
  }

  async function apply(messageId: MessageId, input: TransportApplication): Promise<Result<InboxRecord, TransportError>> {
    let application: TransportApplication;
    try { application = json(input) as unknown as TransportApplication; } catch { return refused('invalid_format'); }
    if (!object(application) || !exact(application, ['state', 'observation'])) return refused('invalid_format');
    if (application.observation !== null && !validObservation(application.observation)) return refused('invalid_observation');
    return commit(async snapshot => {
      const done = (result: Result<InboxRecord, TransportError>, mutations: StoreMutation[] = [], events: AuditEvent[] = []) => ({ result, mutations, events });
      const stored = message(snapshot, messageId);
      const key = pair(messageId, peerId);
      const row = entry(snapshot, 'transport.inbox', key);
      const received = entry(snapshot, 'transport.deliveries', key)?.value;
      if (!stored || !row) return done(refused('missing_message'));
      if (!object(received) || !nonempty(received.authenticatedSenderId) || !isUtcTimestamp(received.receivedAt)
        || digestJson(received.envelope) !== stored.digest) throw new Error('Invalid delivery record');
      const inbox = readInbox(row.value);
      const parsed = await validate(stored.envelope, peerId, received.authenticatedSenderId as PeerId, 'transport.apply');
      if (!parsed.ok) return done(parsed, [], [event(stored.envelope.task_id, 'transport.rejected', { messageId, error: parsed.error })]);
      if (inbox.appliedAt !== null) return done({ ok: true, value: inbox });
      const observation = application.observation;
      const previousObservation = observation ? entry(snapshot, 'transport.observations', observation.executionId) : undefined;
      if (observation && previousObservation && digestJson(previousObservation.value) !== digestJson(observation)) return done(collision(observation.executionId), [],
        [event(stored.envelope.task_id, 'transport.id_collision', { executionId: observation.executionId })]);
      if (observation && (observation.taskId !== stored.envelope.task_id || observation.result.languageVersionId !== stored.envelope.language_version_id)) return done(refused('invalid_observation'));
      const applied: InboxRecord = { ...inbox, appliedAt: identity.now() };
      const stateId = canonicalJson([stored.envelope.task_id, peerId]);
      const previousState = entry(snapshot, 'transport.state', stateId);
      if (previousState && (!object(previousState.value) || !exact(previousState.value, ['taskId', 'recipientId', 'value'])
        || previousState.value.taskId !== stored.envelope.task_id || previousState.value.recipientId !== peerId)) throw new Error('Invalid transport state');
      const stateEntry = { key: { collection: 'transport.state', id: stateId },
        value: json({ taskId: stored.envelope.task_id, recipientId: peerId, value: application.state }) };
      const mutations: StoreMutation[] = [
        { kind: 'replace', entry: { key: row.key, value: json(applied) }, expectedDigest: digestJson(row.value) },
        previousState ? { kind: 'replace', entry: stateEntry, expectedDigest: digestJson(previousState.value) } : { kind: 'insert', entry: stateEntry },
        insert('transport.applications', key, { messageId, recipientId: peerId, appliedAt: applied.appliedAt,
          stateDigest: digestJson(application.state), observationExecutionId: observation?.executionId ?? null }),
      ];
      if (observation && !previousObservation) mutations.push(insert('transport.observations', observation.executionId, observation));
      return done({ ok: true, value: applied }, mutations, [event(stored.envelope.task_id, 'transport.applied', { messageId, recipientId: peerId })]);
    });
  }

  async function receive(): Promise<Result<readonly Result<InboxRecord, TransportError>[], TransportError>> {
    try {
      const batch = await options.adapterFor(peerId).receive(null);
      const results = [];
      for (const incoming of batch.deliveries) results.push(await accept(incoming));
      return { ok: true, value: results };
    } catch { return unknown(); }
  }

  async function acknowledge(messageId: MessageId): Promise<Result<void, TransportError>> {
    try {
      const snapshot = await store.snapshot();
      if (!snapshot.ok) return snapshot;
      const stored = message(snapshot.value, messageId);
      const row = entry(snapshot.value, 'transport.inbox', pair(messageId, peerId));
      if (!stored || !row) return refused('missing_message');
      readInbox(row.value);
      await options.adapterFor(peerId).acknowledge(messageId);
      return commit(async () => ({ result: { ok: true, value: undefined }, mutations: [],
        events: [event(stored.envelope.task_id, 'transport.acknowledged', { messageId, recipientId: peerId })] }));
    } catch { return unknown(); }
  }

  return { stage, dispatch, accept, apply, receive, acknowledge };
}
