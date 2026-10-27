import { digestJson, hostIdentity, isUtcTimestamp } from '@semevolve/core';
import type { Epoch, EpochId, HostIdentity, LanguageVersionId, Result, StoreEntry, StoreMutation, StoreSnapshot, TaskId, TaskStore } from '@semevolve/core';
import type { ConformanceRecord, LanguageHead, LanguageRegistry, LanguageScope, LanguageStatus, LanguageStatusEvent, LanguageVersion, ParticipantFingerprint } from './contracts/registry.js';
import { inspection, readiness } from './inspection.js';
import type { RegistryInspection, RegistryInspectionPort, EpochReadinessPort } from './inspection.js';
import * as valid from './validation.js';

export const registryMutableCollections: readonly string[] = Object.freeze(['registry.heads', 'registry.task-epochs']);

export interface RegistryScope {
  readonly scope: LanguageScope;
  readonly fingerprints: readonly ParticipantFingerprint[];
  readonly testSetDigest: string;
  readonly evaluatorVersion: string;
}

export interface RegistryOptions {
  readonly store: TaskStore;
  readonly scopes: readonly RegistryScope[];
  readonly identity?: HostIdentity;
  readonly inspection: RegistryInspectionPort;
  readonly transitions: EpochReadinessPort;
}

interface Sequenced<T> { readonly sequence: number; readonly record: T }
interface TaskEpoch { readonly taskId: TaskId; readonly epochId: EpochId; readonly revision: number }
interface EpochClosure { readonly epochId: EpochId; readonly closedAt: string; readonly heldMessageIds: readonly string[] }
export interface ResolveLanguageRequest {
  readonly epochId: EpochId;
  readonly languageVersionId: LanguageVersionId;
  readonly contextRevision: number;
  readonly fingerprint: ParticipantFingerprint;
  readonly digest: string;
}

const transitions: Readonly<Record<LanguageStatus, readonly LanguageStatus[]>> = {
  DRAFT: ['CANDIDATE'], CANDIDATE: ['TRIAL', 'REJECTED'], TRIAL: ['ACTIVE', 'REJECTED'],
  ACTIVE: ['QUARANTINED', 'RETIRED'], QUARANTINED: ['TRIAL', 'RETIRED'], RETIRED: ['TRIAL'], REJECTED: ['TRIAL'],
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const invalid = (issue: string): Result<never> => ({ ok: false, error: { code: 'invalid_input', issues: [issue] } });
const unavailable = (reason: string): Result<never> => ({ ok: false, error: { code: 'unavailable', reason } });
const collision = (id: string): Result<never> => ({ ok: false, error: { code: 'id_collision', id } });
const conflict = (expected: number, actual: number): Result<never> => ({ ok: false, error: { code: 'revision_conflict', expected, actual } });
const entryFor = (collection: string, id: string, value: unknown): StoreEntry => ({ key: { collection, id }, value: valid.json(value) });
const insert = (collection: string, id: string, value: unknown): StoreMutation => ({ kind: 'insert', entry: entryFor(collection, id, value) });
const valueAt = (s: StoreSnapshot, collection: string, id: string): unknown => s.entries.find(e => e.key.collection === collection && e.key.id === id)?.value;
const values = <T>(s: StoreSnapshot, collection: string): T[] => s.entries.filter(e => e.key.collection === collection).map(e => e.value as unknown as T);
const sequenced = (v: unknown, check: (v: unknown) => boolean): boolean => valid.object(v) && valid.exact(v, ['sequence', 'record']) && valid.integer(v.sequence) && check(v.record);
const headValue = (v: unknown): v is LanguageHead => valid.object(v) && valid.exact(v, ['scopeId', 'activeVersionId', 'revision']) && valid.text(v.scopeId) && valid.text(v.activeVersionId) && valid.integer(v.revision) && v.revision > 0;
const taskEpoch = (v: unknown): v is TaskEpoch => valid.object(v) && valid.exact(v, ['taskId', 'epochId', 'revision']) && valid.text(v.taskId) && valid.text(v.epochId) && valid.integer(v.revision) && v.revision > 0;
const closure = (v: unknown): v is EpochClosure => valid.object(v) && valid.exact(v, ['epochId', 'closedAt', 'heldMessageIds']) && valid.text(v.epochId) && isUtcTimestamp(v.closedAt) && valid.unique(v.heldMessageIds);
const inspectionValue = (v: unknown): v is RegistryInspection => valid.object(v) && valid.conformance(v.record) && inspection(v, v.record);

function copy<T>(input: unknown, guard: (v: unknown) => v is T): Result<T> {
  try { const v = valid.json(input); return guard(v) ? ok(v) : invalid('Invalid registry input'); }
  catch { return invalid('Invalid registry JSON'); }
}

export class StoredLanguageRegistry implements LanguageRegistry {
  private readonly identity: HostIdentity;
  private readonly scopes: readonly RegistryScope[];
  constructor(private readonly options: RegistryOptions) {
    this.identity = options.identity ?? hostIdentity;
    this.scopes = JSON.parse(valid.canonicalConfig(options.scopes)) as RegistryScope[];
  }

  private async snapshot(): Promise<Result<StoreSnapshot>> {
    const result = await this.options.store.snapshot();
    if (!result.ok) return result;
    for (const entry of result.value.entries) {
      if (entry.key.collection === 'registry.versions' && (!valid.version(entry.value) || entry.key.id !== entry.value.version_id)) return unavailable('Invalid stored language version');
      if (entry.key.collection === 'registry.status' && (!sequenced(entry.value, valid.status)
        || entry.key.id !== (entry.value as unknown as Sequenced<LanguageStatusEvent>).record.eventId)) return unavailable('Invalid stored status');
      if (entry.key.collection === 'registry.conformance' && (!sequenced(entry.value, inspectionValue)
        || entry.key.id !== digestJson((entry.value as unknown as Sequenced<RegistryInspection>).record.record))) return unavailable('Invalid stored conformance');
      if (entry.key.collection === 'registry.heads' && (!headValue(entry.value) || entry.key.id !== entry.value.scopeId)) return unavailable('Invalid stored head');
      if (entry.key.collection === 'registry.epochs' && (!valid.epoch(entry.value) || entry.key.id !== entry.value.epochId || entry.value.sendsClosedAt !== null)) return unavailable('Invalid stored epoch');
      if (entry.key.collection === 'registry.task-epochs' && (!taskEpoch(entry.value) || entry.key.id !== entry.value.taskId)) return unavailable('Invalid stored task epoch');
      if (entry.key.collection === 'registry.epoch-closures' && (!closure(entry.value) || entry.key.id !== entry.value.epochId)) return unavailable('Invalid stored epoch closure');
    }
    return result;
  }

  async register(input: LanguageVersion): Promise<Result<LanguageVersion>> {
    let version: LanguageVersion;
    try {
      const value = valid.json(input);
      if (!valid.version(value)) return invalid('Invalid language version or content digest');
      version = value;
    } catch { return invalid('Invalid language JSON'); }
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    const previous = this.findVersion(snapshot.value, version.version_id);
    if (previous) return valid.same(previous, version) ? ok(previous) : collision(version.version_id);
    if (!this.scopes.some(s => valid.same(s.scope, version.scope))) return invalid('Unknown or mismatched scope');
    if (version.parent_ids.some(id => !this.findVersion(snapshot.value, id))) return invalid('Unknown parent version');
    const entry: StoreEntry = { key: { collection: 'registry.versions', id: version.version_id }, value: valid.json(version) };
    const committed = await this.options.store.transact({ transactionId: this.identity.newId('transaction'), expectedRevision: snapshot.value.revision, mutations: [{ kind: 'insert', entry }], events: [] });
    return committed.ok ? ok(version) : committed;
  }

  private findVersion(snapshot: StoreSnapshot, id: string): LanguageVersion | null {
    const value = snapshot.entries.find(e => e.key.collection === 'registry.versions' && e.key.id === id)?.value;
    return valid.version(value) ? value : null;
  }

  async get(id: LanguageVersion['version_id']): Promise<Result<LanguageVersion | null>> {
    if (!valid.text(id)) return invalid('Invalid version ID');
    const snapshot = await this.snapshot();
    return snapshot.ok ? ok(this.findVersion(snapshot.value, id)) : snapshot;
  }

  private commit(s: StoreSnapshot, mutations: readonly StoreMutation[]) {
    return this.options.store.transact({ transactionId: this.identity.newId('transaction'), expectedRevision: s.revision, mutations, events: [] });
  }

  private records(s: StoreSnapshot, id: LanguageVersionId): ConformanceRecord[] {
    return values<Sequenced<RegistryInspection>>(s, 'registry.conformance').sort((a, b) => a.sequence - b.sequence)
      .map(v => v.record.record).filter(r => r.versionId === id);
  }

  private statuses(s: StoreSnapshot, id: LanguageVersionId): LanguageStatusEvent[] {
    return values<Sequenced<LanguageStatusEvent>>(s, 'registry.status').sort((a, b) => a.sequence - b.sequence)
      .map(v => v.record).filter(r => r.versionId === id);
  }

  private eligible(s: StoreSnapshot, version: LanguageVersion): Result<readonly ConformanceRecord[]> {
    const criteria = this.scopes.find(c => valid.same(c.scope, version.scope));
    if (!criteria) return invalid('Unknown scope');
    const now = this.identity.now();
    if (!isUtcTimestamp(now)) return unavailable('Invalid clock');
    const records = this.records(s, version.version_id);
    const accepted: ConformanceRecord[] = [];
    for (const fingerprint of criteria.fingerprints) {
      if (fingerprint.modelId === null || fingerprint.cliVersion === null) return invalid('Unknown participant fingerprint');
      const latest = records.filter(r => r.scopeId === criteria.scope.scopeId && valid.same(r.fingerprint, fingerprint)
        && r.testSetDigest === criteria.testSetDigest && r.evaluatorVersion === criteria.evaluatorVersion).at(-1);
      if (!latest || latest.verdict !== 'pass' || latest.checkedAt > now || (latest.expiresAt !== null && latest.expiresAt <= now)) return invalid('Current independent conformance required');
      accepted.push(latest);
    }
    return ok(accepted);
  }

  async recordConformance(input: ConformanceRecord): Promise<Result<void>> {
    const parsed = copy(input, valid.conformance);
    if (!parsed.ok) return parsed;
    const record = parsed.value;
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    const version = this.findVersion(s, record.versionId);
    if (!version || version.scope.scopeId !== record.scopeId || !version.scope.participantIds.includes(record.fingerprint.peerId)
      || record.checkedAt > this.identity.now()) return invalid('Conformance target or time mismatch');
    const id = digestJson(record);
    if (valueAt(s, 'registry.conformance', id)) return ok(undefined);
    const latest = this.records(s, record.versionId).filter(r => valid.same(r.fingerprint, record.fingerprint)).at(-1);
    if (latest && record.checkedAt < latest.checkedAt) return invalid('Conformance cannot predate its previous record');
    let evidence: Result<RegistryInspection | null>;
    try { evidence = await this.options.inspection.readConformance(structuredClone(record)); }
    catch { return unavailable('Independent inspection unavailable'); }
    if (!evidence.ok) return evidence;
    const checked = copy(evidence.value, inspectionValue);
    if (!checked.ok || !valid.same(checked.value.record, record)) return invalid('Independent fixed inspection does not match conformance');
    const committed = await this.commit(s, [insert('registry.conformance', id, { sequence: s.revision + 1, record: checked.value })]);
    return committed.ok ? ok(undefined) : committed;
  }

  async conformance(id: LanguageVersionId, fingerprint: ParticipantFingerprint, scope: string): Promise<Result<readonly ConformanceRecord[]>> {
    const f = copy(fingerprint, valid.fingerprint);
    if (!f.ok) return f;
    if (!valid.text(id) || !valid.text(scope)) return invalid('Invalid conformance target');
    const s = await this.snapshot();
    return s.ok ? ok(this.records(s.value, id).filter(r => r.scopeId === scope && valid.same(r.fingerprint, f.value))) : s;
  }

  async appendStatus(input: LanguageStatusEvent): Promise<Result<void>> {
    const parsed = copy(input, valid.status);
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    const previous = valueAt(s, 'registry.status', event.eventId) as unknown as Sequenced<LanguageStatusEvent> | undefined;
    if (previous) return valid.same(previous.record, event) ? ok(undefined) : collision(event.eventId);
    const version = this.findVersion(s, event.versionId);
    if (!version || version.scope.scopeId !== event.scopeId || event.occurredAt > this.identity.now()) return invalid('Status target or time mismatch');
    const latest = this.statuses(s, event.versionId).at(-1);
    if (latest ? !transitions[latest.status].includes(event.status) || latest.occurredAt > event.occurredAt
      : !['DRAFT', 'CANDIDATE'].includes(event.status)) return invalid('Invalid status transition');
    if (event.status === 'ACTIVE') {
      const accepted = this.eligible(s, version);
      if (!accepted.ok) return accepted;
      if (!valid.same([...new Set(accepted.value.flatMap(r => r.checkIds))].sort(), [...event.checkIds].sort())) return invalid('Adoption must reference the current independent checks');
    }
    const committed = await this.commit(s, [insert('registry.status', event.eventId, { sequence: s.revision + 1, record: event })]);
    return committed.ok ? ok(undefined) : committed;
  }

  async statusEvents(id: LanguageVersionId): Promise<Result<readonly LanguageStatusEvent[]>> {
    if (!valid.text(id)) return invalid('Invalid version ID');
    const s = await this.snapshot();
    return s.ok ? ok(this.statuses(s.value, id)) : s;
  }

  async head(scope: string): Promise<Result<LanguageHead | null>> {
    if (!valid.text(scope)) return invalid('Invalid scope');
    const s = await this.snapshot();
    if (!s.ok) return s;
    const value = valueAt(s.value, 'registry.heads', scope);
    return ok(headValue(value) ? value : null);
  }

  private active(s: StoreSnapshot, id: LanguageVersionId, scope: string): Result<LanguageVersion> {
    const version = this.findVersion(s, id);
    if (!version || version.scope.scopeId !== scope || this.statuses(s, id).at(-1)?.status !== 'ACTIVE') return invalid('Active version in the target scope required');
    const accepted = this.eligible(s, version);
    return accepted.ok ? ok(version) : accepted;
  }

  async selectHead(scope: string, id: LanguageVersionId, revision: number): Promise<Result<LanguageHead>> {
    if (!valid.text(scope) || !valid.text(id) || !valid.integer(revision) || !Number.isSafeInteger(revision + 1)) return invalid('Invalid head request');
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    const previous = valueAt(s, 'registry.heads', scope);
    const actual = headValue(previous) ? previous.revision : 0;
    if (actual !== revision) return conflict(revision, actual);
    const accepted = this.active(s, id, scope);
    if (!accepted.ok) return accepted;
    const head: LanguageHead = { scopeId: scope, activeVersionId: id, revision: actual + 1 };
    const entry = entryFor('registry.heads', scope, head);
    const committed = await this.commit(s, [previous === undefined ? { kind: 'insert', entry } : { kind: 'replace', entry, expectedDigest: digestJson(previous) }]);
    return committed.ok ? ok(head) : committed;
  }

  async getEpoch(id: EpochId): Promise<Result<Epoch | null>> {
    if (!valid.text(id)) return invalid('Invalid epoch ID');
    const s = await this.snapshot();
    if (!s.ok) return s;
    const e = valueAt(s.value, 'registry.epochs', id);
    if (!valid.epoch(e)) return ok(null);
    const closed = valueAt(s.value, 'registry.epoch-closures', id);
    return ok(closure(closed) ? { ...e, sendsClosedAt: closed.closedAt as Epoch['sendsClosedAt'] } : e);
  }

  async nextEpoch(input: Parameters<LanguageRegistry['nextEpoch']>[0]): Promise<Result<Epoch>> {
    const parsed = copy(input, (v): v is Parameters<LanguageRegistry['nextEpoch']>[0] => valid.object(v)
      && valid.exact(v, ['taskId', 'previousEpochId', 'epoch', 'expectedRevision']) && valid.text(v.taskId)
      && (v.previousEpochId === null || valid.text(v.previousEpochId)) && valid.epoch(v.epoch) && valid.integer(v.expectedRevision));
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const e = request.epoch;
    if (e.taskId !== request.taskId || e.sendsClosedAt !== null || e.openedAt > this.identity.now()
      || !Number.isSafeInteger(request.expectedRevision + 1)) return invalid('Invalid new epoch');
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    const pointer = valueAt(s, 'registry.task-epochs', request.taskId);
    const actual = taskEpoch(pointer) ? pointer.revision : 0;
    if (request.expectedRevision !== actual) return conflict(request.expectedRevision, actual);
    if ((taskEpoch(pointer) ? pointer.epochId : null) !== request.previousEpochId) return invalid('Previous epoch mismatch');
    if (valueAt(s, 'registry.epochs', e.epochId)) return collision(e.epochId);
    const previous = request.previousEpochId === null ? undefined : valueAt(s, 'registry.epochs', request.previousEpochId);
    if (request.previousEpochId !== null && (!valid.epoch(previous) || previous.taskId !== request.taskId || previous.openedAt > e.openedAt
      || e.contextRevision <= previous.contextRevision || valueAt(s, 'registry.epoch-closures', previous.epochId))) return invalid('Previous epoch is not switchable');
    let readinessResult;
    try { readinessResult = await this.options.transitions.inspect(structuredClone(request), s.revision); }
    catch { return unavailable('Epoch readiness unavailable'); }
    if (!readinessResult.ok) return readinessResult;
    const checked = copy(readinessResult.value, readiness);
    if (!checked.ok) return checked;
    const ready = checked.value;
    if (ready.storeRevision !== s.revision || ready.taskId !== request.taskId || ready.previousEpochId !== request.previousEpochId
      || ready.epochId !== e.epochId || (previous !== undefined && !ready.previousSendsClosed)
      || !valid.same([...ready.pendingMessageIds].sort(), [...ready.heldMessageIds].sort())
      || (previous === undefined && ready.pendingMessageIds.length !== 0)) return invalid('Epoch transition preconditions are not established');
    const criteria = this.scopes.find(c => c.scope.scopeId === ready.scopeId);
    if (!criteria) return invalid('Unknown epoch scope');
    if (e.language.mode === 'bound') {
      const active = this.active(s, e.language.languageVersionId, ready.scopeId);
      if (!active.ok) return active;
      const head = valueAt(s, 'registry.heads', ready.scopeId);
      if (!headValue(head) || head.activeVersionId !== active.value.version_id || ready.acquired.length !== criteria.fingerprints.length
        || !criteria.fingerprints.every(f => ready.acquired.some(a => valid.same(a.fingerprint, f)
          && a.versionId === active.value.version_id && a.digest === active.value.digest))) return invalid('Every participant must acquire the selected version');
    } else if (request.previousEpochId !== null) return invalid('Bootstrap is only available before the first bound epoch');
    const pointerEntry = entryFor('registry.task-epochs', request.taskId, { taskId: request.taskId, epochId: e.epochId, revision: actual + 1 });
    const mutations: StoreMutation[] = [insert('registry.epochs', e.epochId, e),
      pointer === undefined ? { kind: 'insert', entry: pointerEntry } : { kind: 'replace', entry: pointerEntry, expectedDigest: digestJson(pointer) }];
    if (valid.epoch(previous)) mutations.push(insert('registry.epoch-closures', previous.epochId, { epochId: previous.epochId, closedAt: e.openedAt, heldMessageIds: ready.heldMessageIds }));
    const committed = await this.commit(s, mutations);
    return committed.ok ? ok(e) : committed;
  }

  async resolveLanguage(input: ResolveLanguageRequest): Promise<Result<LanguageVersion>> {
    const parsed = copy(input, (v): v is ResolveLanguageRequest => valid.object(v)
      && valid.exact(v, ['epochId', 'languageVersionId', 'contextRevision', 'fingerprint', 'digest'])
      && valid.text(v.epochId) && valid.text(v.languageVersionId) && valid.integer(v.contextRevision)
      && valid.fingerprint(v.fingerprint) && valid.digest(v.digest));
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    const epoch = valueAt(s, 'registry.epochs', request.epochId);
    if (!valid.epoch(epoch) || valueAt(s, 'registry.epoch-closures', request.epochId) || epoch.contextRevision !== request.contextRevision
      || epoch.language.languageVersionId !== request.languageVersionId) return invalid('Unknown, held or mismatched epoch');
    const version = this.findVersion(s, request.languageVersionId);
    if (!version || version.digest !== request.digest) return invalid('Language unavailable or digest mismatch');
    const criteria = this.scopes.find(c => valid.same(c.scope, version.scope));
    if (!criteria?.fingerprints.some(f => valid.same(f, request.fingerprint))) return invalid('Participant fingerprint changed');
    const accepted = this.active(s, version.version_id, version.scope.scopeId);
    return accepted.ok ? ok(version) : accepted;
  }
}

export function createLanguageRegistry(options: RegistryOptions): StoredLanguageRegistry { return new StoredLanguageRegistry(options); }
