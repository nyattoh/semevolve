import { digestJson, isUtcTimestamp } from '@semevolve/core';
import type { ExecutionId, StoreSnapshot, StoreMutation } from '@semevolve/core';
import type { Mapping, Migration, MigrationPort } from './contracts/storage.js';
import type { OriginalInput, StorageHead, StorageInspection } from './types.js';
import type { Planner } from './planner.js';
import * as v from './validation.js';
import { manifestUnitDigest } from './validation.js';

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
    if (task.deadline <= p.identity.now() || grant.expiresAt <= p.identity.now()) return v.unavailable('Task or grant expired while authorising');
    return decision.policyRevision;
  }
  noOtherPending(s: StoreSnapshot, id: string): void {
    for (const record of v.rows(s, 'storage.migrations')) {
      if (v.object(record) && record.scope === this.p.options.scope && v.object(record.migration) && record.migration.migrationId !== id
        && record.migration.pendingOperation !== null) v.unavailable('Scope has an operation requiring reconciliation');
    }
  }
  intent(s: StoreSnapshot, state: StateBase, operation: Operation, executionId: ExecutionId, ref: string, policyRevision: number, inspectionDigest = this.inspectionDigest()): unknown {
    return { kind: 'intent', operation, executionId, migrationId: state.migration.migrationId, taskId: this.p.options.taskId, scope: state.scope,
      expectedRevision: s.revision, snapshotDigest: s.digest, sourceHeadDigest: digestJson(state.sourceHead), datasetDigest: state.datasetDigest,
      inputDigest: digestJson({ migration: state.migration, dataset: state.dataset, sourceHead: state.sourceHead, ref, policyRevision }), authorisationRef: ref, policyRevision,
      inspectionDigest };
  }
  inspectionDigest(): string {
    const plan = this.p.options.comparison;
    return digestJson({ queries: plan.queries, expectedConditions: plan.expectedConditions, criteriaDigest: plan.criteriaDigest, evaluatorVersion: plan.evaluatorVersion });
  }
  intentHistory(s: StoreSnapshot, state: State, operation: Operation, ref: string, policyRevision: number, inspectionDigest = this.inspectionDigest()): unknown {
    return { intent: state.intent, migrationId: state.migration.migrationId, head: operation === 'restore' ? state.restoreSourceHead : state.sourceHead,
      stateDigest: digestJson(state), intentDigest: digestJson(this.intent(s, state, operation, state.intent, ref, policyRevision, inspectionDigest)) };
  }
  fence(s: StoreSnapshot, state: State, expectedRevision: number): void {
    if (!v.same(v.find(s, 'storage.migrations', state.migration.migrationId), state)) {
      throw new v.Refusal({ code: 'revision_conflict', expected: expectedRevision, actual: s.revision });
    }
  }
  async unchanged(s: StoreSnapshot, state: State): Promise<void> {
    const current = await this.p.snapshot();
    if (current.revision !== s.revision) throw new v.Refusal({ code: 'revision_conflict', expected: s.revision, actual: current.revision });
    this.fence(current, state, s.revision);
  }
  legacyInspection(s: StoreSnapshot, state: State, operation: 'switch' | 'restore', intent: Record<string, unknown>): string {
    const { p } = this;
    if (!v.same(v.find(s, 'storage.mappings', state.sourceMapping.mappingId), state.sourceMapping)
      || !v.same(v.find(s, 'storage.mappings', state.targetMapping.mappingId), state.targetMapping)
      || !v.same(state.migration.source, state.sourceMapping.versions) || !v.same(state.migration.target, state.targetMapping.versions)
      || state.sourceHead.mappingId !== state.sourceMapping.mappingId || state.sourceHead.mappingDigest !== digestJson(state.sourceMapping)
      || !v.integer(state.sourceHead.revision) || state.sourceHead.revision > Number(intent.expectedRevision)) return v.unavailable('Legacy Mapping or source head is inconsistent');
    const generation = state.migration.shadowRef;
    const priorOperation = operation === 'switch' ? 'catch_up' : 'switch';
    const receipts = v.rows(s, 'storage.operations').filter(r => v.object(r) && r.kind === 'receipt' && r.operation === priorOperation
      && r.migrationId === state.migration.migrationId && r.generation === generation && (operation === 'restore' || r.pass === true));
    if (receipts.length !== 1 || !v.object(receipts[0])) return v.unavailable('Legacy pending has no unique confirmed predecessor');
    const receipt = receipts[0];
    const previousIntent = v.find(s, 'storage.operations', `${receipt.executionId}/intent`);
    if (!v.object(previousIntent) || previousIntent.kind !== 'intent' || previousIntent.operation !== priorOperation
      || previousIntent.executionId !== receipt.executionId || previousIntent.migrationId !== state.migration.migrationId
      || previousIntent.taskId !== p.options.taskId || previousIntent.scope !== state.scope
      || previousIntent.sourceHeadDigest !== digestJson(state.sourceHead) || previousIntent.datasetDigest !== receipt.datasetDigest
      || !v.digest(previousIntent.inputDigest) || !v.digest(previousIntent.snapshotDigest) || !v.integer(previousIntent.expectedRevision)
      || !v.integer(receipt.revision) || receipt.revision <= previousIntent.expectedRevision || receipt.revision > Number(intent.expectedRevision)) return v.unavailable('Legacy predecessor intent and receipt disagree');
    const events = s.events.filter(e => e.taskId === p.options.taskId && e.actor === 'host'
      && e.kind === `storage.${priorOperation}.${operation === 'switch' ? 'checked' : 'committed'}`
      && v.object(e.data) && e.data.intent === receipt.executionId && e.data.migrationId === state.migration.migrationId);
    if (events.length !== 1 || !v.object(events[0]!.data)) return v.unavailable('Legacy predecessor history is unavailable');
    const manifest = v.find(s, 'storage.manifests', generation);
    if (!v.object(manifest) || manifest.generation !== generation || manifest.mappingDigest !== digestJson(state.targetMapping)
      || manifest.datasetDigest !== receipt.datasetDigest || !v.unique(manifest.originalIds) || !v.unique(manifest.checkIds) || !manifest.checkIds.length
      || !v.integer(manifest.throughRevision) || manifest.throughRevision !== state.migration.reconciledThroughRevision
      || manifest.throughRevision >= receipt.revision) return v.unavailable('Legacy predecessor manifest is incomplete');
    if (operation === 'switch') {
      if (generation !== state.generation || state.datasetDigest !== receipt.datasetDigest || events[0]!.data.pass !== true
        || !v.same(events[0]!.data.checkRefs, manifest.checkIds)) return v.unavailable('Legacy switch projection differs from its confirmed predecessor');
    } else {
      if (state.migration.switchedAtRevision !== receipt.revision || !v.same(events[0]!.data.head, state.restoreSourceHead)
        || receipt.headDigest !== digestJson(state.restoreSourceHead) || state.restoreSourceHead?.generation !== generation
        || state.restoreSourceHead.mappingId !== state.targetMapping.mappingId || state.restoreSourceHead.mappingDigest !== digestJson(state.targetMapping)
        || state.restoreSourceHead.revision !== receipt.revision || state.generation === state.sourceHead.generation || state.generation === generation
        || v.find(s, 'storage.manifests', state.generation) !== undefined
        || v.rows(s, 'storage.derived').some(r => v.object(r) && r.generation === state.generation)
        || v.rows(s, 'storage.operations').some(r => v.object(r) && r.kind === 'receipt' && r.generation === state.generation)) return v.unavailable('Legacy restoration source or unused generation is unproved');
    }
    const ids = manifest.originalIds;
    const units = p.projection(s, generation, state.targetMapping).filter(u => ids.includes(u.source.messageId));
    if (manifest.unitDigest !== manifestUnitDigest(units)) return v.unavailable('Legacy predecessor projection changed');
    const queries: unknown[] = []; let plan: Record<string, unknown> | undefined;
    for (const id of manifest.checkIds) {
      const check = v.find(s, 'storage.inspections', id);
      if (!v.object(check) || check.checkId !== id || !state.migration.checkRefs.includes(id as StorageInspection['checkId'])
        || check.mappingDigest !== digestJson(state.targetMapping) || !v.object(check.request) || !v.object(check.result)) return v.unavailable('Legacy inspection is missing');
      const r = check.request;
      if (r.taskId !== p.options.taskId || r.scope !== state.scope || !v.object(r.original) || !Array.isArray(r.original.originals)
        || !r.original.originals.every(v.originalValid) || !v.same(r.original.versions, state.targetMapping.versions)
        || r.original.mappingDigest !== digestJson(state.targetMapping) || check.originalSetDigest !== digestJson(r.original.originals)
        || !v.same(r.original.originals.map(o => o.message.envelope.message_id), ids)
        || !v.object(r.retrieved) || !Array.isArray(r.retrieved.units) || r.retrieved.units.some(u => !units.some(unit => v.same(unit, u)))
        || r.inputDigest !== digestJson({ original: r.original, retrieved: r.retrieved, expectedConditions: r.expectedConditions,
          criteriaDigest: r.criteriaDigest, evaluatorVersion: r.evaluatorVersion, scope: r.scope })
        || !v.digest(r.criteriaDigest) || !v.text(r.evaluatorVersion)) return v.unavailable('Legacy inspection input is inconsistent');
      const currentPlan = { expectedConditions: r.expectedConditions, criteriaDigest: r.criteriaDigest, evaluatorVersion: r.evaluatorVersion };
      if (plan && !v.same(plan, currentPlan)) return v.unavailable('Legacy inspection plans disagree');
      plan = currentPlan; queries.push(r.retrieved.query);
      try { p.checkResult(check.result as unknown as StorageInspection['result'], r as unknown as StorageInspection['request']); }
      catch { return v.unavailable('Legacy inspection result identity is inconsistent'); }
      if (!p.passing(check.result as unknown as StorageInspection['result'])) return v.unavailable('Legacy predecessor inspection did not pass');
    }
    if (manifest.checkIds.some(id => { const c = v.find(s, 'storage.inspections', id); return !v.object(c) || c.querySetDigest !== digestJson(queries); })) return v.unavailable('Legacy query coverage is incomplete');
    return digestJson({ ...plan, queries });
  }
  pendingEvidence(s: StoreSnapshot, state: State, operation: 'switch' | 'restore'): Record<string, unknown> {
    const { p } = this;
    const pending = state.migration.pendingOperation;
    const intent = v.find(s, 'storage.operations', `${state.intent}/intent`);
    if (state.phase !== `${operation}_pending` || !pending || pending.operation !== operation || pending.executionId !== state.intent
      || !v.object(intent) || intent.kind !== 'intent' || intent.operation !== operation || intent.executionId !== state.intent
      || intent.migrationId !== state.migration.migrationId || intent.taskId !== p.options.taskId || intent.scope !== p.options.scope
      || state.migration.taskId !== p.options.taskId || intent.expectedRevision !== pending.expectedRevision || !v.integer(intent.expectedRevision)
      || intent.expectedRevision >= s.revision || !v.digest(intent.snapshotDigest) || intent.sourceHeadDigest !== digestJson(state.sourceHead)
      || intent.datasetDigest !== state.datasetDigest || !v.text(intent.authorisationRef) || !v.integer(intent.policyRevision)
      || intent.inputDigest !== digestJson({ migration: state.migration, dataset: state.dataset, sourceHead: state.sourceHead, ref: intent.authorisationRef, policyRevision: intent.policyRevision })
      || v.find(s, 'storage.operations', `${state.intent}/receipt`) !== undefined
      || v.find(s, 'storage.operations', `${state.intent}/not-applied`) !== undefined
      || v.rows(s, 'storage.operations').some(r => v.object(r) && ['receipt', 'not_applied'].includes(String(r.kind)) && r.executionId === state.intent)) return v.unavailable('Pending intent cannot be proved unapplied');
    const history = s.events.filter(e => e.kind === `storage.${operation}.intent` && e.taskId === p.options.taskId
      && v.object(e.data) && e.data.intent === state.intent && e.data.migrationId === state.migration.migrationId);
    if (history.length !== 1 || history[0]!.actor !== 'host' || !v.object(history[0]!.data)) return v.unavailable('Pending intent lacks matching immutable history');
    const data = history[0]!.data;
    const modern = Object.hasOwn(data, 'intentDigest') || Object.hasOwn(data, 'stateDigest');
    if (modern && (data.intentDigest !== digestJson(intent) || data.stateDigest !== digestJson(state)
      || !v.same(Object.keys(data).sort(), ['head', 'intent', 'intentDigest', 'migrationId', 'stateDigest']))) return v.unavailable('Pending intent and state lack matching immutable history');
    const source = operation === 'restore' ? state.restoreSourceHead : state.sourceHead;
    if (!source || !v.same(p.headAt(s), source)) return v.unavailable('Pending source head is unknown or changed');
    if (operation === 'restore' && !s.events.some(e => e.kind === 'storage.restore.intent' && e.taskId === p.options.taskId
      && v.object(e.data) && e.data.intent === state.intent && e.data.migrationId === state.migration.migrationId
      && v.same(e.data.head, source))) return v.unavailable('Restoration source head is not supported by its intent history');
    if (modern) return intent;
    const expectedKeys = operation === 'restore' ? ['intent', 'migrationId', 'head'] : ['intent', 'migrationId'];
    if (!v.same(Object.keys(data).sort(), expectedKeys.sort()) || Object.hasOwn(intent, 'inspectionDigest')) return v.unavailable('Incomplete new pending evidence cannot use legacy recovery');
    return { ...intent, inspectionDigest: this.legacyInspection(s, state, operation, intent) };
  }
  superseded(s: StoreSnapshot, state: State, successor: ExecutionId, reason: string): StoreMutation {
    return this.p.insert('storage.operations', `${state.intent}/not-applied`, { kind: 'not_applied', executionId: state.intent,
      operation: state.migration.pendingOperation!.operation, migrationId: state.migration.migrationId, reason, successor,
      observedRevision: s.revision, observedSnapshotDigest: s.digest, sourceHead: this.p.headAt(s), intentDigest: digestJson(v.find(s, 'storage.operations', `${state.intent}/intent`)) });
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
    this.fence(s, state, state.migration.pendingOperation!.expectedRevision);
    const units = await p.project(s, state.targetMapping, state.dataset.originals);
    const checks = await p.inspect(s, state.targetMapping, state.dataset.originals, units);
    const final = await p.snapshot();
    this.fence(final, state, s.revision);
    if (!v.same(p.headAt(final), state.sourceHead) || digestJson(await this.dataset(final)) !== state.datasetDigest) return v.unavailable('Delta changed during shadow inspection; reconcile and catch up');
    await this.permit(final, 'copy', p.options.copyAuthorisationRef);
    await this.unchanged(final, state);
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
    if (['restore_pending', 'switched', 'restored'].includes(previous.phase)) return v.unavailable('Migration requires reconciliation, not catch-up');
    if (previous.phase === 'switch_pending') {
      const evidence = this.pendingEvidence(s, previous, 'switch');
      await this.permit(s, 'switch', String(evidence.authorisationRef));
    }
    this.noOtherPending(s, id);
    if (!v.same(p.headAt(s), previous.sourceHead)) return v.unavailable('Source head changed');
    const dataset = await this.dataset(s); const policyRevision = await this.permit(s, 'copy', p.options.copyAuthorisationRef);
    const intent = p.identity.newId('execution'); const generation = p.identity.newId('storage-generation');
    const state: State = { ...previous, phase: 'catch_up_pending', intent, generation, dataset, datasetDigest: digestJson(dataset),
      migration: { ...previous.migration, pendingOperation: { executionId: intent, operation: 'catch_up', expectedRevision: s.revision } } };
    const mutations = [p.replace(s, 'storage.migrations', id, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'catch_up', intent, p.options.copyAuthorisationRef, policyRevision))];
    if (previous.phase === 'switch_pending') {
      const evidence = this.pendingEvidence(s, previous, 'switch');
      if (dataset && digestJson(dataset) === previous.datasetDigest && evidence.inspectionDigest === this.inspectionDigest()) return v.unavailable('Unchanged switch must explicitly resume its existing intent');
      mutations.push(this.superseded(s, previous, intent, 'Source head is unchanged; latest dataset or inspection requires catch-up'));
    }
    await this.unchanged(s, previous);
    await p.commit(s, mutations, 'catch_up.intent', { intent, migrationId: id });
    return this.finishProjection(state, 'catch_up');
  }
  async ready(s: StoreSnapshot, state: State): Promise<void> {
    if (!v.same(this.p.headAt(s), state.sourceHead) || digestJson(await this.dataset(s)) !== state.datasetDigest) return v.unavailable('Unreconciled source head or related delta');
    const manifest = v.find(s, 'storage.manifests', state.generation);
    if (!v.object(manifest) || manifest.generation !== state.generation || manifest.datasetDigest !== state.datasetDigest || manifest.mappingDigest !== digestJson(state.targetMapping)
      || !v.same(manifest.originalIds, state.dataset.originals.map(o => o.message.envelope.message_id)) || !v.unique(manifest.checkIds) || !manifest.checkIds.length
      || manifest.checkIds.length !== this.p.options.comparison.queries.length || !v.integer(manifest.throughRevision)
      || manifest.throughRevision !== state.migration.reconciledThroughRevision || manifest.throughRevision >= s.revision
      || manifest.unitDigest !== manifestUnitDigest(this.p.projection(s, state.generation, state.targetMapping))) return v.unavailable('Shadow manifest is incomplete');
    const queries: unknown[] = [];
    for (const id of manifest.checkIds) {
      const check = v.find(s, 'storage.inspections', id);
      if (!v.object(check) || check.checkId !== id || !state.migration.checkRefs.includes(id as StorageInspection['checkId'])
        || !v.object(check.result) || !v.object(check.request) || check.mappingDigest !== digestJson(state.targetMapping)
        || check.originalSetDigest !== digestJson(state.dataset.originals) || check.request.taskId !== this.p.options.taskId
        || check.querySetDigest !== digestJson(this.p.options.comparison.queries) || check.request.criteriaDigest !== this.p.options.comparison.criteriaDigest
        || check.request.evaluatorVersion !== this.p.options.comparison.evaluatorVersion || check.request.scope !== this.p.options.scope
        || !v.same(check.request.expectedConditions, this.p.options.comparison.expectedConditions)
        || !v.same(check.request.original, { originals: state.dataset.originals, versions: state.targetMapping.versions, mappingDigest: digestJson(state.targetMapping) })
        || !v.object(check.request.retrieved) || !Array.isArray(check.request.retrieved.units)
        || check.request.inputDigest !== digestJson({ original: check.request.original, retrieved: check.request.retrieved, expectedConditions: check.request.expectedConditions,
          criteriaDigest: check.request.criteriaDigest, evaluatorVersion: check.request.evaluatorVersion, scope: check.request.scope })
        || !['literalRestoration', 'meaningPreservation', 'retrievalCorrectness'].every(k => v.object(check.result) && check.result[k] === 'pass')) return v.unavailable('Shadow has no current independent passing inspection');
      const valid = await v.boundary(async () => this.p.checkResult(check.result as unknown as StorageInspection['result'], check.request as unknown as StorageInspection['request']));
      if (!valid.ok) return v.unavailable('Shadow inspection result identity differs from its request');
      queries.push(check.request.retrieved.query);
    }
    if (!v.same(queries, this.p.options.comparison.queries)) return v.unavailable('Shadow query coverage differs from the current plan');
  }
  async switchHead(request: Parameters<MigrationPort['switch']>[0]): Promise<Migration> {
    const { p } = this; const input = structuredClone(request); const s = await p.snapshot();
    if (!v.integer(input.expectedRevision)) v.invalid('Invalid expected revision');
    if (input.expectedRevision !== s.revision) throw new v.Refusal({ code: 'revision_conflict', expected: input.expectedRevision, actual: s.revision });
    const previous = this.get(s, input.migrationId); this.noOtherPending(s, input.migrationId);
    if (previous.phase === 'switch_pending') return this.resumeSwitch(s, previous, input.authorisationRef);
    if (previous.phase !== 'checked') return v.unavailable('Shadow must be caught up and independently checked');
    await this.ready(s, previous); const policyRevision = await this.permit(s, 'switch', input.authorisationRef);
    const intent = p.identity.newId('execution');
    const state: State = { ...previous, phase: 'switch_pending', intent, migration: { ...previous.migration, pendingOperation: { executionId: intent, operation: 'switch', expectedRevision: input.expectedRevision } } };
    await p.commit(s, [p.replace(s, 'storage.migrations', input.migrationId, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'switch', intent, input.authorisationRef, policyRevision))], 'switch.intent', this.intentHistory(s, state, 'switch', input.authorisationRef, policyRevision));
    return this.finishSwitch(await p.snapshot(), state, input.authorisationRef);
  }
  async resumeSwitch(s: StoreSnapshot, previous: State, ref: string): Promise<Migration> {
    const { p } = this;
    const evidence = this.pendingEvidence(s, previous, 'switch');
    const policyRevision = await this.permit(s, 'switch', ref);
    await this.unchanged(s, previous);
    if (ref === evidence.authorisationRef && policyRevision === evidence.policyRevision) return this.finishSwitch(s, previous, ref);
    const inspectionDigest = this.legacyInspection(s, previous, 'switch', evidence);
    if (evidence.inspectionDigest !== inspectionDigest) return v.unavailable('Pending projection inspection history is inconsistent');
    await this.dataset(s);
    const intent = p.identity.newId('execution');
    const state: State = { ...previous, intent, migration: { ...previous.migration,
      pendingOperation: { executionId: intent, operation: 'switch', expectedRevision: s.revision } } };
    const mutations = [p.replace(s, 'storage.migrations', state.migration.migrationId, state),
      p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'switch', intent, ref, policyRevision, inspectionDigest)),
      this.superseded(s, previous, intent, 'Verified pending switch replaced by explicitly authorised authority')];
    if (await this.permit(s, 'switch', ref) !== policyRevision) return v.unavailable('New switch authority changed before replacement');
    await this.unchanged(s, previous);
    await p.commit(s, mutations, 'switch.intent', this.intentHistory(s, state, 'switch', ref, policyRevision, inspectionDigest));
    return this.finishSwitch(await p.snapshot(), state, ref);
  }
  async finishSwitch(final: StoreSnapshot, state: State, ref: string): Promise<Migration> {
    const { p } = this; const id = state.migration.migrationId; const intent = state.intent;
    this.fence(final, state, state.migration.pendingOperation!.expectedRevision);
    const evidence = this.pendingEvidence(final, state, 'switch');
    if (evidence.authorisationRef !== ref || (evidence.inspectionDigest !== undefined && evidence.inspectionDigest !== this.inspectionDigest())) return v.unavailable('Pending switch inputs changed; explicit catch-up is required');
    await this.ready(final, state);
    if (await this.permit(final, 'switch', ref) !== evidence.policyRevision) return v.unavailable('Pending switch policy revision changed');
    await this.unchanged(final, state);
    const migration: Migration = { ...state.migration, switchedAtRevision: final.revision + 1, pendingOperation: null };
    const head: StorageHead = { generation: state.generation, mappingId: state.targetMapping.mappingId, mappingDigest: digestJson(state.targetMapping), revision: final.revision + 1 };
    await p.commit(final, [p.replace(final, 'storage.heads', p.options.scope, head), p.replace(final, 'storage.migrations', id, { ...state, phase: 'switched', migration }),
      p.insert('storage.operations', `${intent}/receipt`, { kind: 'receipt', operation: 'switch', executionId: intent, migrationId: id, generation: head.generation,
        datasetDigest: state.datasetDigest, headDigest: digestJson(head), revision: final.revision + 1 })], 'switch.committed', { intent, migrationId: id, head });
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
    const pending = previous.phase === 'restore_pending' ? this.pendingEvidence(s, previous, 'restore') : null;
    if (!pending && (previous.migration.pendingOperation !== null || previous.migration.switchedAtRevision === null || !['switched', 'blocked'].includes(previous.phase))) return v.unavailable('Migration is not ready for restoration');
    const head = p.headAt(s);
    if (!head || head.mappingDigest !== digestJson(previous.targetMapping)) return v.unavailable('Restoration source head changed');
    const dataset = await this.dataset(s); const policyRevision = await this.permit(s, 'restore', input.authorisationRef);
    if (pending && previous.datasetDigest === digestJson(dataset) && pending.authorisationRef === input.authorisationRef
      && pending.policyRevision === policyRevision && pending.inspectionDigest === this.inspectionDigest()) return this.finishRestore(previous, input.authorisationRef, s.revision);
    const intent = p.identity.newId('execution'); const generation = p.identity.newId('storage-generation');
    const state: State = { ...previous, phase: 'restore_pending', intent, generation, dataset, datasetDigest: digestJson(dataset), restoreSourceHead: head,
      migration: { ...previous.migration, restoration: { verified: false, reason: 'Latest information is not yet independently verified in the old format' }, pendingOperation: { executionId: intent, operation: 'restore', expectedRevision: input.expectedRevision } } };
    const mutations = [p.replace(s, 'storage.migrations', input.migrationId, state), p.insert('storage.operations', `${intent}/intent`, this.intent(s, state, 'restore', intent, input.authorisationRef, policyRevision))];
    if (pending) mutations.push(this.superseded(s, previous, intent, 'Source head is unchanged; latest restoration inputs require a new attempt'));
    await this.unchanged(s, previous);
    await p.commit(s, mutations, 'restore.intent', this.intentHistory(s, state, 'restore', input.authorisationRef, policyRevision));
    return this.finishRestore(state, input.authorisationRef, s.revision);
  }
  async finishRestore(state: State, ref: string, expectedRevision: number): Promise<Migration> {
    const { p } = this; const { dataset, generation, intent } = state; const id = state.migration.migrationId;
    const inspectionSnapshot = await p.snapshot();
    this.fence(inspectionSnapshot, state, expectedRevision);
    const evidence = this.pendingEvidence(inspectionSnapshot, state, 'restore');
    const head = state.restoreSourceHead!;
    if (evidence.authorisationRef !== ref || evidence.inspectionDigest !== this.inspectionDigest()
      || digestJson(await this.dataset(inspectionSnapshot)) !== state.datasetDigest) return v.unavailable('Pending restoration inputs changed');
    if (await this.permit(inspectionSnapshot, 'restore', ref) !== evidence.policyRevision) return v.unavailable('Pending restoration policy revision changed');
    const projection = await v.boundary(async () => {
      const units = await p.project(inspectionSnapshot, state.sourceMapping, dataset.originals);
      const checks = await p.inspect(inspectionSnapshot, state.sourceMapping, dataset.originals, units);
      return { units, checks };
    });
    const final = await p.snapshot();
    this.fence(final, state, expectedRevision);
    this.pendingEvidence(final, state, 'restore');
    if (!v.same(p.headAt(final), head) || digestJson(await this.dataset(final)) !== state.datasetDigest) return v.unavailable('New delta invalidated restoration; pending verification is retained');
    if (await this.permit(final, 'restore', ref) !== evidence.policyRevision) return v.unavailable('Pending restoration policy revision changed');
    await this.unchanged(final, state);
    const pass = projection.ok && projection.value.checks.length > 0 && projection.value.checks.every(c => p.passing(c.result));
    const checks = projection.ok ? projection.value.checks : [];
    const reason = projection.ok ? 'Old-format literal, meaning or retrieval inspection did not pass' : projection.error.code === 'unavailable' ? projection.error.reason : JSON.stringify(projection.error);
    const migration: Migration = { ...state.migration, pendingOperation: null, checkRefs: [...state.migration.checkRefs, ...checks.map(c => c.checkId)],
      restoration: pass ? { verified: true, throughRevision: inspectionSnapshot.revision, checkRefs: checks.map(c => c.checkId) } : { verified: false, reason } };
    const restoredHead: StorageHead = { generation, mappingId: state.sourceMapping.mappingId, mappingDigest: digestJson(state.sourceMapping), revision: final.revision + 1 };
    const next: State = { ...state, migration, phase: pass ? 'restored' : 'blocked' };
    const mutations = [p.replace(final, 'storage.migrations', id, next), ...checks.map(c => p.insert('storage.inspections', c.checkId, c)),
      p.insert('storage.operations', `${intent}/receipt`, { kind: 'receipt', operation: 'restore', executionId: intent, migrationId: id, generation,
        datasetDigest: state.datasetDigest, headDigest: digestJson(pass ? restoredHead : head), revision: final.revision + 1, pass })];
    if (projection.ok) {
      const { units } = projection.value;
      mutations.push(...dataset.originals.map(o => p.insert('storage.derived', digestJson([generation, o.message.envelope.message_id, state.sourceMapping]),
        { generation, mappingDigest: digestJson(state.sourceMapping), mappingId: state.sourceMapping.mappingId, units: units.filter(u => u.source.messageId === o.message.envelope.message_id) })),
        p.insert('storage.manifests', generation, { generation, mappingDigest: digestJson(state.sourceMapping), datasetDigest: state.datasetDigest,
          originalIds: dataset.originals.map(o => o.message.envelope.message_id), unitDigest: manifestUnitDigest(units), checkIds: checks.map(c => c.checkId), throughRevision: inspectionSnapshot.revision }));
    }
    if (pass) mutations.push(p.replace(final, 'storage.heads', p.options.scope, restoredHead));
    await p.commit(final, mutations, pass ? 'restore.committed' : 'restore.blocked', { intent, migrationId: id, pass, reason: pass ? null : reason });
    if (!pass) return v.unavailable(reason);
    return migration;
  }
}
