import { canonicalJson, digestJson, isUtcTimestamp } from '@semevolve/core';
import type { ExecutionId, StoreSnapshot } from '@semevolve/core';
import type { DerivedUnit, Mapping, Migration, MigrationPort } from './contracts/storage.js';
import type { OriginalInput, StorageHead } from './types.js';
import type { Planner } from './planner.js';
import * as v from './validation.js';

function manifestUnitDigest(units: readonly DerivedUnit[]): ReturnType<typeof digestJson> {
  const ordered = [...units].sort((left, right) => {
    const a = canonicalJson(left), b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return digestJson(ordered);
}

interface Dataset { readonly originals: readonly OriginalInput[]; readonly references: readonly unknown[] }
interface StateBase {
  readonly migration: Migration;
  readonly scope: string;
  readonly requestDigest: string;
  readonly sourceMapping: Mapping;
  readonly targetMapping: Mapping;
  readonly sourceHead: StorageHead;
  readonly dataset: Dataset;
  readonly datasetDigest: string;
  readonly generation: string;
  readonly restoreSourceHead?: StorageHead;
}
type State = StateBase & (
  | { readonly phase: 'copy_pending' | 'catch_up_pending' | 'switch_pending' | 'restore_pending'; readonly intent: ExecutionId }
  | { readonly phase: 'shadow_ready' | 'checked' | 'blocked' | 'switched' | 'restored'; readonly intent: ExecutionId }
);
type Operation = NonNullable<Migration['pendingOperation']>['operation'];

export class Migrations {
  constructor(readonly p: Planner) {}
  get(s: StoreSnapshot, id: string): State {
    const record = v.find(s, 'storage.migrations', id);
    if (!v.object(record) || !v.object(record.migration) || record.migration.migrationId !== id || record.scope !== this.p.options.scope
      || !v.mappingValid(record.sourceMapping) || !v.mappingValid(record.targetMapping) || !v.object(record.sourceHead)
      || !v.object(record.dataset) || !Array.isArray(record.dataset.originals) || !record.dataset.originals.every(v.originalValid)
      || !Array.isArray(record.dataset.references) || record.datasetDigest !== digestJson(record.dataset) || !v.text(record.generation)
      || !v.text(record.intent) || !['copy_pending', 'catch_up_pending', 'switch_pending', 'restore_pending', 'shadow_ready', 'checked', 'blocked', 'switched', 'restored'].includes(String(record.phase))) return v.unavailable('Migration record is unavailable or inconsistent');
    return record as unknown as State;
  }
  mapping(s: StoreSnapshot, versions: Mapping['versions']): Mapping {
    const mappings: Mapping[] = [];
    for (const m of v.rows(s, 'storage.mappings')) if (v.mappingValid(m) && m.scope === this.p.options.scope && v.same(m.versions, versions)) mappings.push(m);
    if (mappings.length !== 1) return v.unavailable('Version combination must identify one registered Mapping');
    return mappings[0]!;
  }
  async dataset(s: StoreSnapshot): Promise<Dataset> {
    const ids = v.rows(s, 'storage.originals').map(o => { if (!v.originalValid(o)) return v.unavailable('Corrupt original'); return o; })
      .filter(o => o.message.envelope.task_id === this.p.options.taskId).map(o => o.message.envelope.message_id).sort();
    const originals = await Promise.all(ids.map(id => this.p.original(s, id)));
    const references = await Promise.all(originals.map(o => this.p.resolveRefs(s, o)));
    return { originals, references };
  }
  async permit(s: StoreSnapshot, name: 'copy' | 'switch' | 'restore', ref: string): Promise<number> {
    const { p } = this;
    const task = v.value(await p.options.references.readTask(s, p.options.taskId));
    const now = p.identity.now();
    if (!task || task.taskId !== p.options.taskId || !isUtcTimestamp(task.deadline) || task.deadline <= now
      || task.cancellationRequestedAt !== null || task.stopReason !== null) return v.unavailable('Task is expired, cancelled or unavailable');
    const operation = { taskId: p.options.taskId, name: `storage.${name}`, target: `storage:${digestJson([p.options.taskId, p.options.scope])}` };
    const grant = v.value(await p.options.references.readGrant(s, ref));
    if (!grant || grant.ref !== ref || grant.taskId !== operation.taskId || grant.name !== operation.name || grant.target !== operation.target
      || !v.integer(grant.policyRevision) || !isUtcTimestamp(grant.expiresAt) || grant.expiresAt <= now || grant.revokedAt !== null) return v.unavailable('Host grant does not permit this task, target, purpose or time');
    const decision = await p.options.policy.authorise(operation);
    if (!decision.allowed || decision.policyRevision !== grant.policyRevision) return v.unavailable('PolicyGate rejected the current grant revision');
    return decision.policyRevision;
  }
  noOtherPending(s: StoreSnapshot, id: string): void {
    for (const record of v.rows(s, 'storage.migrations')) {
      if (v.object(record) && record.scope === this.p.options.scope && v.object(record.migration) && record.migration.migrationId !== id
        && record.migration.pendingOperation !== null) v.unavailable('Scope has an operation requiring reconciliation');
    }
  }
  intent(s: StoreSnapshot, state: StateBase, operation: Operation, executionId: ExecutionId, ref: string, policyRevision: number): unknown {
    return { kind: 'intent', operation, executionId, migrationId: state.migration.migrationId, taskId: this.p.options.taskId, scope: state.scope,
      expectedRevision: s.revision, snapshotDigest: s.digest, sourceHeadDigest: digestJson(state.sourceHead), datasetDigest: state.datasetDigest,
      inputDigest: digestJson({ migration: state.migration, dataset: state.dataset, sourceHead: state.sourceHead, ref, policyRevision }), authorisationRef: ref, policyRevision };
  }
  async prepare(input: Migration): Promise<Migration> {
    const { p } = this; const request = structuredClone(input); const s = await p.snapshot();
    if (!v.object(request) || !v.text(request.migrationId)) v.invalid('Invalid migration');
    const existing = v.find(s, 'storage.migrations', request.migrationId);
    if (existing !== undefined) { const state = this.get(s, request.migrationId); if (state.requestDigest !== digestJson(request)) v.collision(request.migrationId); return state.migration; }
    if (request.taskId !== p.options.taskId || !v.combination(request.source) || !v.combination(request.target) || request.snapshotDigest !== s.digest
      || request.baseRevision !== s.revision || request.reconciledThroughRevision !== s.revision || !Array.isArray(request.checkRefs) || request.checkRefs.length !== 0
      || request.pendingOperation !== null || request.switchedAtRevision !== null || !v.object(request.restoration) || request.restoration.verified !== false
      || !v.text(request.restoration.reason) || !v.text(request.shadowRef)) v.invalid('Migration request fabricates snapshot, revision or host progress');
    this.noOtherPending(s, request.migrationId);
    const head = p.headAt(s); if (!head) return v.unavailable('No source head');
    const source = this.mapping(s, request.source), target = this.mapping(s, request.target);
    await p.registered(s, target);
    if (head.mappingDigest !== digestJson(source) || v.same(source.versions, target.versions)) v.invalid('Migration source head or target mismatch');
    const dataset = await this.dataset(s);
    const policyRevision = await this.permit(s, 'copy', p.options.copyAuthorisationRef);
    const intent = p.identity.newId('execution'); const generation = p.identity.newId('storage-generation');
    const migration: Migration = { ...request, shadowRef: generation, pendingOperation: { executionId: intent, operation: 'copy', expectedRevision: s.revision } };
    const state: State = { phase: 'copy_pending', intent, migration, scope: p.options.scope, requestDigest: digestJson(request), sourceMapping: source,
      targetMapping: target, sourceHead: head, dataset, datasetDigest: digestJson(dataset), generation };
    await p.commit(s, [p.insert('storage.migrations', migration.migrationId, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'copy', intent, p.options.copyAuthorisationRef, policyRevision))], 'copy.intent', { intent, migrationId: migration.migrationId });
    return this.finishProjection(state, 'copy');
  }
  async finishProjection(state: State, operation: 'copy' | 'catch_up'): Promise<Migration> {
    const { p } = this; const s = await p.snapshot();
    const units = await p.project(s, state.targetMapping, state.dataset.originals);
    const checks = await p.inspect(s, state.targetMapping, state.dataset.originals, units);
    const final = await p.snapshot();
    if (!v.same(p.headAt(final), state.sourceHead) || digestJson(await this.dataset(final)) !== state.datasetDigest) return v.unavailable('Delta changed during shadow inspection; reconcile and catch up');
    await this.permit(final, 'copy', p.options.copyAuthorisationRef);
    const pass = checks.length > 0 && checks.every(c => p.passing(c.result));
    const migration: Migration = { ...state.migration, checkRefs: [...state.migration.checkRefs, ...checks.map(c => c.checkId)], pendingOperation: null,
      reconciledThroughRevision: s.revision, shadowRef: state.generation };
    const next: State = { ...state, migration, phase: pass ? operation === 'copy' ? 'shadow_ready' : 'checked' : 'blocked' };
    const mutations = state.dataset.originals.map(o => p.insert('storage.derived', digestJson([state.generation, o.message.envelope.message_id, state.targetMapping]),
      { generation: state.generation, mappingDigest: digestJson(state.targetMapping), mappingId: state.targetMapping.mappingId, units: units.filter(u => u.source.messageId === o.message.envelope.message_id) }));
    mutations.push(...checks.map(c => p.insert('storage.inspections', c.checkId, c)), p.insert('storage.manifests', state.generation,
      { generation: state.generation, mappingDigest: digestJson(state.targetMapping), datasetDigest: state.datasetDigest,
        originalIds: state.dataset.originals.map(o => o.message.envelope.message_id), unitDigest: manifestUnitDigest(units), checkIds: checks.map(c => c.checkId), throughRevision: s.revision }),
      p.replace(final, 'storage.migrations', migration.migrationId, next), p.insert('storage.operations', `${state.intent}/receipt`,
        { kind: 'receipt', operation, executionId: state.intent, migrationId: migration.migrationId, datasetDigest: state.datasetDigest, generation: state.generation, revision: final.revision + 1, pass }));
    if (pass) mutations.push(p.insert('storage.conformance', state.intent, { mappingDigest: digestJson(state.targetMapping), ids: checks.map(c => c.checkId), criteriaDigest: p.options.comparison.criteriaDigest, evaluatorVersion: p.options.comparison.evaluatorVersion }));
    await p.commit(final, mutations, `${operation}.checked`, { intent: state.intent, migrationId: migration.migrationId, pass, checkRefs: checks.map(c => c.checkId) });
    return migration;
  }
  async catchUp(id: string, throughRevision: number): Promise<Migration> {
    const { p } = this; const s = await p.snapshot(); const previous = this.get(s, id);
    if (!v.integer(throughRevision) || throughRevision !== s.revision) v.invalid('Catch-up requires the current observed snapshot revision');
    if (['switch_pending', 'restore_pending', 'switched', 'restored'].includes(previous.phase)) return v.unavailable('Migration requires reconciliation, not catch-up');
    this.noOtherPending(s, id);
    if (!v.same(p.headAt(s), previous.sourceHead)) return v.unavailable('Source head changed');
    const dataset = await this.dataset(s); const policyRevision = await this.permit(s, 'copy', p.options.copyAuthorisationRef);
    const intent = p.identity.newId('execution'); const generation = p.identity.newId('storage-generation');
    const state: State = { ...previous, phase: 'catch_up_pending', intent, generation, dataset, datasetDigest: digestJson(dataset),
      migration: { ...previous.migration, pendingOperation: { executionId: intent, operation: 'catch_up', expectedRevision: s.revision } } };
    await p.commit(s, [p.replace(s, 'storage.migrations', id, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'catch_up', intent, p.options.copyAuthorisationRef, policyRevision))], 'catch_up.intent', { intent, migrationId: id });
    return this.finishProjection(state, 'catch_up');
  }
  async ready(s: StoreSnapshot, state: State): Promise<void> {
    if (!v.same(this.p.headAt(s), state.sourceHead) || digestJson(await this.dataset(s)) !== state.datasetDigest) return v.unavailable('Unreconciled source head or related delta');
    const manifest = v.find(s, 'storage.manifests', state.generation);
    if (!v.object(manifest) || manifest.datasetDigest !== state.datasetDigest || manifest.mappingDigest !== digestJson(state.targetMapping)
      || !v.same(manifest.originalIds, state.dataset.originals.map(o => o.message.envelope.message_id)) || !v.unique(manifest.checkIds) || !manifest.checkIds.length
      || manifest.unitDigest !== manifestUnitDigest(this.p.projection(s, state.generation, state.targetMapping))) return v.unavailable('Shadow manifest is incomplete');
    for (const id of manifest.checkIds) {
      const check = v.find(s, 'storage.inspections', id);
      if (!v.object(check) || !v.object(check.result) || !v.object(check.request) || check.mappingDigest !== digestJson(state.targetMapping)
        || check.querySetDigest !== digestJson(this.p.options.comparison.queries) || check.request.criteriaDigest !== this.p.options.comparison.criteriaDigest
        || check.request.evaluatorVersion !== this.p.options.comparison.evaluatorVersion || check.request.scope !== this.p.options.scope
        || !['literalRestoration', 'meaningPreservation', 'retrievalCorrectness'].every(k => v.object(check.result) && check.result[k] === 'pass')) return v.unavailable('Shadow has no current independent passing inspection');
    }
  }
  async switchHead(request: Parameters<MigrationPort['switch']>[0]): Promise<Migration> {
    const { p } = this; const input = structuredClone(request); const s = await p.snapshot();
    if (!v.integer(input.expectedRevision)) v.invalid('Invalid expected revision');
    if (input.expectedRevision !== s.revision) throw new v.Refusal({ code: 'revision_conflict', expected: input.expectedRevision, actual: s.revision });
    const previous = this.get(s, input.migrationId); this.noOtherPending(s, input.migrationId);
    if (previous.phase !== 'checked') return v.unavailable('Shadow must be caught up and independently checked');
    await this.ready(s, previous); const policyRevision = await this.permit(s, 'switch', input.authorisationRef);
    const intent = p.identity.newId('execution');
    const state: State = { ...previous, phase: 'switch_pending', intent, migration: { ...previous.migration, pendingOperation: { executionId: intent, operation: 'switch', expectedRevision: input.expectedRevision } } };
    await p.commit(s, [p.replace(s, 'storage.migrations', input.migrationId, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'switch', intent, input.authorisationRef, policyRevision))], 'switch.intent', { intent, migrationId: input.migrationId });
    const final = await p.snapshot(); await this.ready(final, state); await this.permit(final, 'switch', input.authorisationRef);
    const migration: Migration = { ...state.migration, switchedAtRevision: final.revision + 1, pendingOperation: null };
    const head: StorageHead = { generation: state.generation, mappingId: state.targetMapping.mappingId, mappingDigest: digestJson(state.targetMapping), revision: final.revision + 1 };
    await p.commit(final, [p.replace(final, 'storage.heads', p.options.scope, head), p.replace(final, 'storage.migrations', input.migrationId, { ...state, phase: 'switched', migration }),
      p.insert('storage.operations', `${intent}/receipt`, { kind: 'receipt', operation: 'switch', executionId: intent, migrationId: input.migrationId, generation: head.generation,
        datasetDigest: state.datasetDigest, headDigest: digestJson(head), revision: final.revision + 1 })], 'switch.committed', { intent, migrationId: input.migrationId, head });
    return migration;
  }
  async reconcile(id: string): Promise<Migration> {
    const s = await this.p.snapshot(); const state = this.get(s, id);
    const intent = v.find(s, 'storage.operations', `${state.intent}/intent`);
    const receipt = v.find(s, 'storage.operations', `${state.intent}/receipt`);
    if (!v.object(intent) || intent.migrationId !== id || intent.executionId !== state.intent) return v.unavailable('Missing or inconsistent operation intent');
    if (state.migration.pendingOperation !== null) {
      if (receipt !== undefined) return v.unavailable('Pending migration and receipt disagree');
      return state.migration;
    }
    if (!v.object(receipt) || receipt.executionId !== state.intent || receipt.migrationId !== id || receipt.generation !== state.generation) return v.unavailable('Missing or inconsistent operation receipt');
    if (['switched', 'restored'].includes(state.phase) && receipt.headDigest !== digestJson(this.p.headAt(s))) return v.unavailable('Head does not match the committed receipt');
    return state.migration;
  }
  async restore(request: Parameters<MigrationPort['restore']>[0]): Promise<Migration> {
    const { p } = this; const input = structuredClone(request); const s = await p.snapshot();
    if (!v.integer(input.expectedRevision)) v.invalid('Invalid expected revision');
    if (input.expectedRevision !== s.revision) throw new v.Refusal({ code: 'revision_conflict', expected: input.expectedRevision, actual: s.revision });
    const previous = this.get(s, input.migrationId); this.noOtherPending(s, input.migrationId);
    if (previous.migration.pendingOperation !== null || previous.migration.switchedAtRevision === null || !['switched', 'blocked'].includes(previous.phase)) return v.unavailable('Migration is not ready for restoration');
    const head = p.headAt(s);
    if (!head || head.mappingDigest !== digestJson(previous.targetMapping)) return v.unavailable('Restoration source head changed');
    const dataset = await this.dataset(s); const policyRevision = await this.permit(s, 'restore', input.authorisationRef);
    const intent = p.identity.newId('execution'); const generation = p.identity.newId('storage-generation');
    const state: State = { ...previous, phase: 'restore_pending', intent, generation, dataset, datasetDigest: digestJson(dataset), restoreSourceHead: head,
      migration: { ...previous.migration, restoration: { verified: false, reason: 'Latest information is not yet independently verified in the old format' }, pendingOperation: { executionId: intent, operation: 'restore', expectedRevision: input.expectedRevision } } };
    await p.commit(s, [p.replace(s, 'storage.migrations', input.migrationId, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'restore', intent, input.authorisationRef, policyRevision))], 'restore.intent', { intent, migrationId: input.migrationId, head });
    const inspectionSnapshot = await p.snapshot();
    const projection = await v.boundary(async () => {
      const units = await p.project(inspectionSnapshot, previous.sourceMapping, dataset.originals);
      const checks = await p.inspect(inspectionSnapshot, previous.sourceMapping, dataset.originals, units);
      return { units, checks };
    });
    const final = await p.snapshot();
    if (!v.same(p.headAt(final), head) || digestJson(await this.dataset(final)) !== state.datasetDigest) return v.unavailable('New delta invalidated restoration; pending verification is retained');
    await this.permit(final, 'restore', input.authorisationRef);
    const pass = projection.ok && projection.value.checks.length > 0 && projection.value.checks.every(c => p.passing(c.result));
    const checks = projection.ok ? projection.value.checks : [];
    const reason = projection.ok ? 'Old-format literal, meaning or retrieval inspection did not pass' : projection.error.code === 'unavailable' ? projection.error.reason : JSON.stringify(projection.error);
    const migration: Migration = { ...state.migration, pendingOperation: null, checkRefs: [...state.migration.checkRefs, ...checks.map(c => c.checkId)],
      restoration: pass ? { verified: true, throughRevision: inspectionSnapshot.revision, checkRefs: checks.map(c => c.checkId) } : { verified: false, reason } };
    const restoredHead: StorageHead = { generation, mappingId: previous.sourceMapping.mappingId, mappingDigest: digestJson(previous.sourceMapping), revision: final.revision + 1 };
    const next: State = { ...state, migration, phase: pass ? 'restored' : 'blocked' };
    const mutations = [p.replace(final, 'storage.migrations', input.migrationId, next), ...checks.map(c => p.insert('storage.inspections', c.checkId, c)),
      p.insert('storage.operations', `${intent}/receipt`, { kind: 'receipt', operation: 'restore', executionId: intent, migrationId: input.migrationId, generation,
        datasetDigest: state.datasetDigest, headDigest: digestJson(pass ? restoredHead : head), revision: final.revision + 1, pass })];
    if (projection.ok) {
      const { units } = projection.value;
      mutations.push(...dataset.originals.map(o => p.insert('storage.derived', digestJson([generation, o.message.envelope.message_id, previous.sourceMapping]),
        { generation, mappingDigest: digestJson(previous.sourceMapping), mappingId: previous.sourceMapping.mappingId, units: units.filter(u => u.source.messageId === o.message.envelope.message_id) })),
        p.insert('storage.manifests', generation, { generation, mappingDigest: digestJson(previous.sourceMapping), datasetDigest: state.datasetDigest,
          originalIds: dataset.originals.map(o => o.message.envelope.message_id), unitDigest: manifestUnitDigest(units), checkIds: checks.map(c => c.checkId), throughRevision: inspectionSnapshot.revision }));
    }
    if (pass) mutations.push(p.replace(final, 'storage.heads', p.options.scope, restoredHead));
    await p.commit(final, mutations, pass ? 'restore.committed' : 'restore.blocked', { intent, migrationId: input.migrationId, pass, reason: pass ? null : reason });
    if (!pass) return v.unavailable(reason);
    return migration;
  }
}
