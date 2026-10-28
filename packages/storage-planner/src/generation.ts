import { digestJson } from '@semevolve/core';
import type { StoreSnapshot } from '@semevolve/core';
import type { Mapping } from './contracts/storage.js';
import type { Planner } from './planner.js';
import type { OriginalInput, StorageInspection } from './types.js';
import * as v from './validation.js';

interface Candidate {
  generation: string;
  revision: number;
  receipt: Record<string, unknown>;
  projectedMapping: Mapping;
}

async function projectionEvidence(p: Planner, s: StoreSnapshot, candidate: Candidate): Promise<readonly OriginalInput[]> {
  const { receipt, projectedMapping: mapping } = candidate;
  const manifest = v.find(s, 'storage.manifests', String(receipt.generation));
  if (!v.object(manifest) || manifest.generation !== receipt.generation || manifest.mappingDigest !== digestJson(mapping)
    || manifest.datasetDigest !== receipt.datasetDigest || !v.unique(manifest.originalIds) || !v.unique(manifest.checkIds)
    || manifest.checkIds.length !== p.options.comparison.queries.length || manifest.checkIds.length === 0
    || !v.integer(manifest.throughRevision) || manifest.throughRevision >= candidate.revision) return v.unavailable('Confirmed generation manifest is inconsistent');
  const originalIds = manifest.originalIds;
  const originals = await Promise.all(originalIds.map(id => p.original(s, id as OriginalInput['message']['envelope']['message_id'])));
  const references = await Promise.all(originals.map(o => p.resolveRefs(s, o)));
  if (digestJson({ originals, references }) !== receipt.datasetDigest) return v.unavailable('Confirmed generation dataset is inconsistent');
  const units = p.projection(s, String(receipt.generation), mapping).filter(u => originalIds.includes(u.source.messageId));
  if (v.manifestUnitDigest(units) !== manifest.unitDigest) return v.unavailable('Confirmed generation projection is incomplete');
  const queries: unknown[] = [];
  for (const id of manifest.checkIds) {
    const c = v.find(s, 'storage.inspections', id);
    if (!v.object(c) || c.checkId !== id || !v.object(c.request) || !v.object(c.result)
      || c.mappingDigest !== digestJson(mapping) || c.originalSetDigest !== digestJson(originals)
      || c.querySetDigest !== digestJson(p.options.comparison.queries)) return v.unavailable('Confirmed generation inspection is inconsistent');
    const { request, result } = c;
    if (request.taskId !== p.options.taskId || request.scope !== p.options.scope
      || request.criteriaDigest !== p.options.comparison.criteriaDigest || request.evaluatorVersion !== p.options.comparison.evaluatorVersion
      || !v.same(request.expectedConditions, p.options.comparison.expectedConditions)
      || !v.same(request.original, { originals, versions: mapping.versions, mappingDigest: digestJson(mapping) })
      || !v.object(request.retrieved) || !Array.isArray(request.retrieved.units)
      || request.inputDigest !== digestJson({ original: request.original, retrieved: request.retrieved, expectedConditions: request.expectedConditions,
        criteriaDigest: request.criteriaDigest, evaluatorVersion: request.evaluatorVersion, scope: request.scope })) return v.unavailable('Confirmed generation inspection input changed');
    p.checkResult(result as unknown as StorageInspection['result'], request as unknown as StorageInspection['request']);
    if (!p.passing(result as unknown as StorageInspection['result'])) return v.unavailable('Confirmed generation inspection did not pass');
    const selected = v.value(await p.adapter(s, mapping).retrieve(v.json(request.retrieved.query), units, mapping));
    if (v.manifestUnitDigest(selected) !== v.manifestUnitDigest(request.retrieved.units as unknown as Parameters<typeof v.manifestUnitDigest>[0])) return v.unavailable('Confirmed generation retrieval differs from inspection');
    queries.push(request.retrieved.query);
  }
  if (!v.same(queries, p.options.comparison.queries)) return v.unavailable('Confirmed generation query coverage changed');
  return originals;
}

export async function confirmedGeneration(p: Planner, s: StoreSnapshot, mapping: Mapping): Promise<string> {
  const candidates: Candidate[] = [];
  const operations = v.rows(s, 'storage.operations');
  const mappingDigest = digestJson(mapping);
  for (const receipt of operations) {
    if (!v.object(receipt) || receipt.kind !== 'receipt' || receipt.pass === false) continue;
    const state = v.find(s, 'storage.migrations', String(receipt.migrationId));
    if (!v.object(state) || !v.object(state.migration) || state.scope !== p.options.scope || state.migration.taskId !== p.options.taskId) continue;
    if (!v.mappingValid(state.sourceMapping) || !v.mappingValid(state.targetMapping)) return v.unavailable('Generation Mapping history is unavailable');
    const projectedMapping = receipt.operation === 'restore' ? state.sourceMapping : state.targetMapping;
    const source = receipt.operation === 'restore' ? state.restoreSourceHead : state.sourceHead;
    const retires = ['switch', 'restore'].includes(String(receipt.operation)) && v.object(source) && source.mappingDigest === mappingDigest;
    const projects = ['copy', 'catch_up', 'restore'].includes(String(receipt.operation)) && projectedMapping.mappingId === mapping.mappingId;
    if (!retires && !projects) continue;
    const intent = v.find(s, 'storage.operations', `${receipt.executionId}/intent`);
    if (!v.object(intent) || intent.kind !== 'intent' || intent.operation !== receipt.operation || intent.executionId !== receipt.executionId
      || intent.migrationId !== receipt.migrationId || intent.taskId !== p.options.taskId || intent.scope !== p.options.scope
      || intent.datasetDigest !== receipt.datasetDigest || intent.sourceHeadDigest !== digestJson(state.sourceHead)
      || !v.integer(intent.expectedRevision) || !v.integer(receipt.revision) || receipt.revision <= intent.expectedRevision || receipt.revision > s.revision
      || !v.digest(intent.snapshotDigest) || !v.digest(intent.inputDigest) || !v.text(receipt.generation)) return v.unavailable('Generation receipt or intent is inconsistent');
    if (receipt.operation !== 'switch' && receipt.pass !== true) return v.unavailable('Generation receipt has no successful outcome');
    if (retires) {
      if (!v.object(source) || !v.text(source.generation) || !v.integer(source.revision) || source.revision > intent.expectedRevision) return v.unavailable('Retired source head is unavailable');
      const committed = s.events.find(e => e.kind === `storage.${receipt.operation}.committed` && e.taskId === p.options.taskId
        && v.object(e.data) && e.data.intent === receipt.executionId && e.data.migrationId === receipt.migrationId);
      const head = { generation: receipt.generation, mappingId: projectedMapping.mappingId, mappingDigest: digestJson(projectedMapping), revision: receipt.revision };
      if (!committed || receipt.headDigest !== digestJson(head)) return v.unavailable('Retirement has no matching committed head');
      if (receipt.operation === 'switch' && (!v.object(committed.data) || !v.same(committed.data.head, head))) return v.unavailable('Switch head history is inconsistent');
      if (receipt.operation === 'restore' && !s.events.some(e => e.kind === 'storage.restore.intent' && e.taskId === p.options.taskId
        && v.object(e.data) && e.data.intent === receipt.executionId && e.data.migrationId === receipt.migrationId
        && v.same(e.data.head, source))) return v.unavailable('Restoration source head history is inconsistent');
      candidates.push({ generation: source.generation, revision: receipt.revision, receipt, projectedMapping });
    }
    if (projects) candidates.push({ generation: receipt.generation, revision: receipt.revision, receipt, projectedMapping });
  }
  for (const manifest of v.rows(s, 'storage.manifests')) {
    if (v.object(manifest) && manifest.mappingDigest === mappingDigest
      && !operations.some(r => v.object(r) && r.kind === 'receipt' && r.generation === manifest.generation)) return v.unavailable('Projection manifest has no terminal receipt');
  }
  const revision = Math.max(...candidates.map(c => c.revision));
  const latest = candidates.filter(c => c.revision === revision);
  if (!latest.length || new Set(latest.map(c => c.generation)).size !== 1) return v.unavailable('Confirmed projection generation is unavailable or ambiguous');
  for (const candidate of latest) {
    const originals = await projectionEvidence(p, s, candidate);
    const units = p.projection(s, candidate.generation, mapping);
    if (!v.same([...new Set(units.map(u => u.source.messageId))].sort(), originals.map(o => o.message.envelope.message_id).sort())
      || units.some(u => {
        const original = originals.find(o => o.message.envelope.message_id === u.source.messageId);
        return !original || !v.same(u.eventRefs, original.eventRefs) || !v.same(u.interpretationRefs, original.interpretationRefs) || !v.same(u.checkRefs, original.checkRefs);
      })) return v.unavailable('Confirmed generation provenance is incomplete');
  }
  return latest[0]!.generation;
}
