import { digestJson, isUtcTimestamp } from '@semevolve/core';
import type { CheckExecution, CheckId, HostIdentity, Interpretation, JsonValue, MessageId, StoreMutation, StoreSnapshot, TaskStore } from '@semevolve/core';
import type { StorageCheckResult } from '@semevolve/evaluator';
import type { DerivedUnit, Mapping } from './contracts/storage.js';
import type { OriginalInput, RuleDefinition, StorageAdapter, StorageHead, StorageInspection, StoragePlannerOptions, StorageRuntime, StorageTrace, StructureDefinition } from './types.js';
import * as v from './validation.js';
import { compare, registerProposal } from './comparison.js';
import { Migrations } from './migration.js';
import { confirmedGeneration } from './generation.js';

export const storageMutableCollections = ['storage.migrations', 'storage.heads'] as const;

export class Planner {
  readonly options: StoragePlannerOptions;
  readonly identity: HostIdentity;
  readonly store: TaskStore;
  constructor(options: StoragePlannerOptions) {
    this.options = { ...options, comparison: { ...structuredClone({ ...options.comparison, measurement: null }), measurement: options.comparison.measurement }, adapters: [...options.adapters] };
    this.identity = options.identity;
    this.store = options.store;
    if (!v.text(options.taskId) || !v.text(options.scope) || new Set(options.adapters.map(a => a.id)).size !== options.adapters.length) throw new TypeError('Invalid storage configuration');
  }
  async snapshot(): Promise<StoreSnapshot> { return v.value(await this.store.snapshot()); }
  async commit(s: StoreSnapshot, mutations: readonly StoreMutation[], kind: string, data: unknown): Promise<number> {
    return v.value(await this.store.transact({ transactionId: this.identity.newId('transaction'), expectedRevision: s.revision, mutations,
      events: [{ eventId: this.identity.newId('event'), taskId: this.options.taskId, actor: 'host', kind: `storage.${kind}`, occurredAt: this.identity.now(), data: v.json(data) }] })).revision;
  }
  insert(collection: string, id: string, value: unknown): StoreMutation { return { kind: 'insert', entry: { key: { collection, id }, value: v.json(value) } }; }
  replace(s: StoreSnapshot, collection: string, id: string, value: unknown): StoreMutation {
    const before = v.find(s, collection, id);
    if (before === undefined) return v.unavailable('Missing mutable record');
    return { kind: 'replace', expectedDigest: digestJson(before), entry: { key: { collection, id }, value: v.json(value) } };
  }
  async immutable(s: StoreSnapshot, collection: string, id: string, record: unknown): Promise<void> {
    const old = v.find(s, collection, id);
    if (old !== undefined) { if (!v.same(old, record)) v.collision(id); return; }
    await this.commit(s, [this.insert(collection, id, record)], 'registered', { collection, id, digest: digestJson(record) });
  }
  async language(id: string): Promise<void> {
    const language = v.value(await this.options.registry.get(id as Mapping['versions']['languageVersionId']));
    if (!language) return v.unavailable('Language version is unavailable');
    const { version_id, digest, ...content } = language;
    if (version_id !== id || digestJson(content) !== digest || language.scope.scopeId !== this.options.scope) v.invalid('Language digest or scope mismatch');
  }
  async registerRule(input: RuleDefinition): Promise<void> {
    const rule = structuredClone(input);
    if (!v.ruleValid(rule)) v.invalid('Invalid rule definition');
    const s = await this.snapshot();
    for (const parent of rule.parentIds) if (v.find(s, 'storage.rules', parent) === undefined) v.invalid('Missing rule parent');
    await this.immutable(s, 'storage.rules', rule.ruleVersionId, rule);
  }
  async registerStructure(input: StructureDefinition): Promise<void> {
    const structure = structuredClone(input);
    if (!v.structureValid(structure)) v.invalid('Invalid structure definition');
    const s = await this.snapshot();
    for (const parent of structure.parentIds) if (v.find(s, 'storage.structures', parent) === undefined) v.invalid('Missing structure parent');
    await this.immutable(s, 'storage.structures', structure.storageVersionId, structure);
  }
  async validateMapping(s: StoreSnapshot, mapping: Mapping): Promise<void> {
    if (!v.mappingValid(mapping) || mapping.scope !== this.options.scope) v.invalid('Invalid Mapping or scope');
    await this.language(mapping.versions.languageVersionId);
    const rule = v.find(s, 'storage.rules', mapping.versions.ruleVersionId);
    const structure = v.find(s, 'storage.structures', mapping.versions.storageVersionId);
    if (!v.ruleValid(rule) || !v.structureValid(structure)) v.unavailable('Rule or structure version is unavailable');
  }
  async registerMapping(input: Mapping): Promise<void> {
    const mapping = structuredClone(input);
    const s = await this.snapshot();
    await this.validateMapping(s, mapping);
    await this.immutable(s, 'storage.mappings', mapping.mappingId, mapping);
  }
  async registered(s: StoreSnapshot, mapping: Mapping): Promise<void> {
    await this.validateMapping(s, mapping);
    const stored = v.find(s, 'storage.mappings', mapping.mappingId);
    if (stored === undefined || !v.same(stored, mapping)) v.unavailable('Mapping is not registered with this exact content');
  }
  adapter(s: StoreSnapshot, mapping: Mapping): StorageAdapter {
    const rule = v.find(s, 'storage.rules', mapping.versions.ruleVersionId);
    if (!v.ruleValid(rule)) return v.unavailable('Invalid stored rule');
    const adapter = this.options.adapters.find(a => a.id === rule.adapterId);
    if (!adapter) return v.unavailable('Adapter is not registered by the host');
    return adapter;
  }
  async project(s: StoreSnapshot, mapping: Mapping, originals: readonly OriginalInput[]): Promise<readonly DerivedUnit[]> {
    const adapter = this.adapter(s, mapping);
    const all: DerivedUnit[] = [];
    for (const original of originals) {
      if (original.message.envelope.language_version_id !== mapping.versions.languageVersionId) v.invalid('Original language version differs from Mapping');
      const units = structuredClone(v.value(await adapter.decompose(structuredClone(original), structuredClone(mapping), this.identity)));
      if (!Array.isArray(units) || !v.unique(units.map(u => u.unitId))) v.invalid('Invalid derived unit set');
      for (const unit of units) {
        if (!v.unitValid(unit, original, mapping) || !v.same(unit.eventRefs, original.eventRefs)
          || !v.same(unit.interpretationRefs, original.interpretationRefs) || !v.same(unit.checkRefs, original.checkRefs)) v.invalid('Derived range, versions or references mismatch');
        all.push(unit);
      }
    }
    if (!v.unique(all.map(u => u.unitId))) v.invalid('Duplicate derived unit IDs');
    return all;
  }
  checkResult(result: StorageCheckResult, request: StorageInspection['request']): void {
    if (!v.object(result) || ['executionId', 'inputDigest', 'criteriaDigest', 'evaluatorVersion', 'scope'].some(k => !v.same(result[k as keyof StorageCheckResult], request[k as keyof typeof request]))
      || !['literalRestoration', 'meaningPreservation', 'retrievalCorrectness'].every(k => ['pass', 'fail', 'inconclusive'].includes(String(result[k as keyof StorageCheckResult])))
      || !v.unique(result.evidenceIds) || !(result.limitation === null || typeof result.limitation === 'string')) v.invalid('Storage evaluator result does not match its request');
  }
  async inspect(s: StoreSnapshot, mapping: Mapping, originals: readonly OriginalInput[], units: readonly DerivedUnit[]): Promise<readonly StorageInspection[]> {
    const adapter = this.adapter(s, mapping);
    const plan = this.options.comparison;
    const checks: StorageInspection[] = [];
    const literals: Record<string, JsonValue> = {};
    for (const original of originals) {
      const restored = await adapter.restoreLiteral(structuredClone(units), structuredClone(original));
      literals[original.message.envelope.message_id] = restored.ok ? restored.value : null;
    }
    for (const query of plan.queries) {
      const selected = structuredClone(v.value(await adapter.retrieve(structuredClone(query), structuredClone(units), structuredClone(mapping))));
      if (!Array.isArray(selected) || selected.some(u => !units.some(source => v.same(source, u)))) v.invalid('Retrieval fabricated or changed a derived unit');
      const original = v.json({ originals, versions: mapping.versions, mappingDigest: digestJson(mapping) });
      const retrieved = v.json({ literals, units: selected, query });
      const request = { executionId: this.identity.newId('execution'), taskId: this.options.taskId, original, retrieved,
        expectedConditions: structuredClone(plan.expectedConditions), inputDigest: digestJson({ original, retrieved, expectedConditions: plan.expectedConditions,
          criteriaDigest: plan.criteriaDigest, evaluatorVersion: plan.evaluatorVersion, scope: this.options.scope }), evaluatorVersion: plan.evaluatorVersion, criteriaDigest: plan.criteriaDigest, scope: this.options.scope };
      const result = structuredClone(v.value(await this.options.evaluator.evaluateStorage(structuredClone(request))));
      this.checkResult(result, request);
      checks.push({ checkId: this.identity.newId('check'), mappingDigest: digestJson(mapping), originalSetDigest: digestJson(originals), querySetDigest: digestJson(plan.queries), request, result, evidenceKind: 'host_evaluation_port' });
    }
    return checks;
  }
  async inspectMapping(input: Mapping): Promise<readonly StorageInspection[]> {
    const mapping = structuredClone(input);
    const s = await this.snapshot();
    await this.registered(s, mapping);
    const originals = await Promise.all(this.options.comparison.originalIds.map(id => this.original(s, id)));
    const units = await this.project(s, mapping, originals);
    const checks = await this.inspect(s, mapping, originals, units);
    await this.commit(s, checks.map(c => this.insert('storage.inspections', c.checkId, c)), 'inspected', { mappingId: mapping.mappingId, checkIds: checks.map(c => c.checkId) });
    return checks;
  }
  async recordConformance(input: Mapping, ids: readonly CheckId[]): Promise<void> {
    const mapping = structuredClone(input);
    const s = await this.snapshot();
    await this.registered(s, mapping);
    if (!v.unique(ids) || ids.length !== this.options.comparison.queries.length || ids.length === 0) v.invalid('Missing real storage inspection checks');
    const originals = await Promise.all(this.options.comparison.originalIds.map(id => this.original(s, id)));
    for (const id of ids) {
      const c = v.find(s, 'storage.inspections', id);
      if (!v.object(c) || !v.object(c.request) || !v.object(c.result) || c.checkId !== id || c.mappingDigest !== digestJson(mapping)
        || c.originalSetDigest !== digestJson(originals) || c.querySetDigest !== digestJson(this.options.comparison.queries)
        || c.request.criteriaDigest !== this.options.comparison.criteriaDigest || c.request.evaluatorVersion !== this.options.comparison.evaluatorVersion || c.request.scope !== this.options.scope) v.invalid('Mismatched conformance check');
      this.checkResult(c.result as unknown as StorageCheckResult, c.request as unknown as StorageInspection['request']);
      if (!this.passing(c.result as unknown as StorageCheckResult)) v.unavailable('Storage combination is not independently verified');
    }
    await this.immutable(s, 'storage.conformance', digestJson([mapping, ids]), { mappingDigest: digestJson(mapping), ids, criteriaDigest: this.options.comparison.criteriaDigest, evaluatorVersion: this.options.comparison.evaluatorVersion });
  }
  passing(result: StorageCheckResult): boolean { return result.literalRestoration === 'pass' && result.meaningPreservation === 'pass' && result.retrievalCorrectness === 'pass'; }
  async verified(s: StoreSnapshot, mapping: Mapping): Promise<void> {
    await this.registered(s, mapping);
    const found = v.rows(s, 'storage.conformance').some(c => v.object(c) && c.mappingDigest === digestJson(mapping)
      && c.criteriaDigest === this.options.comparison.criteriaDigest && c.evaluatorVersion === this.options.comparison.evaluatorVersion);
    if (!found) v.unavailable('Unverified language/rule/storage combination');
  }
  projection(s: StoreSnapshot, generation: string, mapping: Mapping): readonly DerivedUnit[] {
    const units: DerivedUnit[] = [];
    for (const row of v.rows(s, 'storage.derived')) {
      if (!v.object(row) || !Array.isArray(row.units)) return v.unavailable('Corrupt projection record');
      if (row.generation !== generation || row.mappingDigest !== digestJson(mapping)) continue;
      for (const unit of row.units) {
        if (!v.object(unit) || !v.object(unit.source) || !v.text(unit.source.messageId)) return v.unavailable('Corrupt unit');
        const original = v.find(s, 'storage.originals', unit.source.messageId);
        if (!v.originalValid(original) || !v.unitValid(unit, original, mapping)) return v.unavailable('Corrupt projection provenance');
        units.push(unit);
      }
    }
    return units;
  }
  async storeMessage(id: MessageId, input: Mapping): Promise<readonly DerivedUnit[]> {
    const mapping = structuredClone(input);
    const s = await this.snapshot();
    await this.verified(s, mapping);
    const head = this.headAt(s);
    if (head && head.mappingDigest !== digestJson(mapping)) v.unavailable('Writes must use the current head Mapping');
    const generation = head?.generation ?? this.identity.newId('storage-generation');
    const key = digestJson([generation, id, mapping]);
    const previous = v.find(s, 'storage.derived', key);
    const original = await this.original(s, id);
    if (previous !== undefined) {
      const saved = v.find(s, 'storage.originals', id);
      if (!v.same(saved, original)) v.collision(id);
      return this.projection(s, generation, mapping).filter(u => u.source.messageId === id);
    }
    const units = await this.project(s, mapping, [original]);
    if (units.length === 0) v.unavailable('No derived units were produced');
    const saved = v.find(s, 'storage.originals', id);
    if (saved !== undefined && !v.same(saved, original)) v.collision(id);
    const mutations = [this.insert('storage.derived', key, { generation, mappingDigest: digestJson(mapping), mappingId: mapping.mappingId, units })];
    if (saved === undefined) mutations.push(this.insert('storage.originals', id, original));
    if (!head) mutations.push(this.insert('storage.heads', this.options.scope, { generation, mappingId: mapping.mappingId, mappingDigest: digestJson(mapping), revision: s.revision + 1 }));
    mutations.push(this.insert('storage.changes', this.identity.newId('storage-change'), { messageId: id, originalDigest: digestJson(original), revision: s.revision + 1 }));
    await this.commit(s, mutations, 'stored', { generation, messageId: id, mappingId: mapping.mappingId });
    return units;
  }
  async retrieve(query: JsonValue, input: Mapping): Promise<readonly DerivedUnit[]> {
    const mapping = structuredClone(input);
    const s = await this.snapshot();
    await this.verified(s, mapping);
    const head = this.headAt(s);
    const chosen = head?.mappingDigest === digestJson(mapping) ? head.generation : await confirmedGeneration(this, s, mapping);
    const units = this.projection(s, chosen, mapping);
    const selected = structuredClone(v.value(await this.adapter(s, mapping).retrieve(structuredClone(query), units, mapping)));
    if (!Array.isArray(selected) || selected.some(u => !units.some(source => v.same(u, source)))) v.invalid('Retrieval changed provenance');
    return selected;
  }
  async original(s: StoreSnapshot, id: MessageId): Promise<OriginalInput> {
    const o = v.value(await this.options.references.readOriginal(s, id));
    if (!o) return v.unavailable('Original is unavailable');
    if (!v.originalValid(o) || o.message.envelope.message_id !== id || o.message.envelope.task_id !== this.options.taskId) v.invalid('Original Envelope, payload digest or task mismatch');
    await this.resolveRefs(s, o);
    return structuredClone(o);
  }
  async resolveRefs(s: StoreSnapshot, o: OriginalInput): Promise<{ events: StoreSnapshot['events']; interpretations: Interpretation[]; checks: CheckExecution[] }> {
    const e = o.message.envelope;
    const context = { taskId: this.options.taskId, messageId: e.message_id, languageVersionId: e.language_version_id, scope: this.options.scope };
    const events = o.eventRefs.map(id => {
      const event = s.events.find(event => event.eventId === id);
      if (!event || event.taskId !== context.taskId || !v.object(event.data) || event.data.messageId !== e.message_id
        || event.data.languageVersionId !== e.language_version_id || event.data.scope !== context.scope) return v.invalid('Unresolved or mismatched actual event');
      return event;
    });
    const interpretations: Interpretation[] = [];
    for (const id of o.interpretationRefs) {
      const proof = v.value(await this.options.references.readInterpretation(s, id));
      if (!proof || !v.same(proof.context, context) || proof.interpretation.messageId !== e.message_id
        || digestJson(proof.interpretation.inputSnapshot) !== proof.interpretation.inputDigest || !isUtcTimestamp(proof.interpretation.recordedAt)) v.invalid('Unresolved or mismatched interpretation');
      interpretations.push(proof.interpretation);
    }
    const checks: CheckExecution[] = [];
    for (const id of o.checkRefs) {
      const proof = v.value(await this.options.references.readCheck(s, id));
      if (!proof || !v.same(proof.context, context) || proof.execution.taskId !== context.taskId || proof.execution.result.checkId !== id
        || proof.execution.result.targetMessageId !== e.message_id || proof.execution.result.languageVersionId !== e.language_version_id
        || proof.execution.result.scope !== context.scope || !v.digest(proof.execution.inputDigest) || !v.text(proof.execution.executionId)
        || !isUtcTimestamp(proof.execution.performedAt)) v.invalid('Unresolved or mismatched check execution');
      checks.push(proof.execution);
    }
    return { events, interpretations, checks };
  }
  async recordOriginal(id: MessageId): Promise<OriginalInput> {
    const s = await this.snapshot();
    const original = await this.original(s, id);
    await this.immutable(s, 'storage.originals', id, original);
    return original;
  }
  headAt(s: StoreSnapshot): StorageHead | null {
    const h = v.find(s, 'storage.heads', this.options.scope);
    if (h === undefined) return null;
    if (!v.object(h) || !v.text(h.generation) || !v.text(h.mappingId) || !v.digest(h.mappingDigest) || !v.integer(h.revision)) return v.unavailable('Invalid storage head');
    return h as unknown as StorageHead;
  }
  async head(): Promise<StorageHead | null> { return this.headAt(await this.snapshot()); }
  async trace(reference: string): Promise<StorageTrace> {
    const s = await this.snapshot();
    const derived = v.rows(s, 'storage.derived').flatMap(r => { if (!v.object(r) || !Array.isArray(r.units)) return v.unavailable('Corrupt derived record'); return r.units; });
    const unitMessages = derived.filter(u => v.object(u) && u.unitId === reference).map(u => v.object(u) && v.object(u.source) ? u.source.messageId : null);
    const originals = v.rows(s, 'storage.originals').map(o => { if (!v.originalValid(o)) return v.unavailable('Corrupt original'); return o; })
      .filter(o => o.message.envelope.message_id === reference || unitMessages.includes(o.message.envelope.message_id) || [...o.eventRefs, ...o.interpretationRefs, ...o.checkRefs].includes(reference));
    const messageIds = new Set(originals.map(o => o.message.envelope.message_id));
    const units = derived.filter(u => v.object(u) && v.object(u.source) && messageIds.has(u.source.messageId as MessageId)) as unknown as DerivedUnit[];
    const events = [], interpretations = [], checks = [], unknowns = [];
    for (const o of originals) {
      const proof = await v.boundary(() => this.resolveRefs(s, o));
      if (!proof.ok) { unknowns.push(proof.error.code); continue; }
      events.push(...proof.value.events); interpretations.push(...proof.value.interpretations); checks.push(...proof.value.checks);
    }
    return { originals, units, events, interpretations, checks, unknowns };
  }
}

export function createStoragePlanner(options: StoragePlannerOptions): StorageRuntime {
  const p = new Planner(options);
  const migration = new Migrations(p);
  return {
    registerRule: r => v.boundary(() => p.registerRule(r)), registerStructure: s => v.boundary(() => p.registerStructure(s)),
    registerMapping: m => v.boundary(() => p.registerMapping(m)), recordOriginal: id => v.boundary(() => p.recordOriginal(id)),
    trace: ref => v.boundary(() => p.trace(ref)), head: () => v.boundary(() => p.head()),
    inspectMapping: m => v.boundary(() => p.inspectMapping(m)), recordConformance: (m, ids) => v.boundary(() => p.recordConformance(m, ids)),
    store: (id, m) => v.boundary(() => p.storeMessage(id, m)), retrieve: (q, m) => v.boundary(() => p.retrieve(q, m)),
    registerProposal: proposal => v.boundary(() => registerProposal(p, proposal)), compare: (a, b) => v.boundary(() => compare(p, a, b)),
    migration: { prepare: m => v.boundary(() => migration.prepare(m)), catchUp: (id, rev) => v.boundary(() => migration.catchUp(id, rev)),
      switch: r => v.boundary(() => migration.switchHead(r)), restore: r => v.boundary(() => migration.restore(r)), reconcile: id => v.boundary(() => migration.reconcile(id)) },
  };
}
