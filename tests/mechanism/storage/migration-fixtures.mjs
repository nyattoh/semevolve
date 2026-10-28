import { digestJson } from '@semevolve/core';
import { syntheticStorageAdapters } from '@semevolve/storage-planner';
import { fixture, mapping, clausePayload, graphPayload, take } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';

export const targetMapping = mapping('M2', 'L1', 'R2', 'S2');
export async function migrationFixture(extra = {}) {
  const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble(), plan: { expectedConditions: { payloads: { 'message-1': clausePayload, 'message-2': clausePayload, 'graph-1': graphPayload } } }, ...extra });
  if (extra.seed !== false) {
    await f.versions(); await f.certify(); take(await f.runtime.store('message-1', mapping()));
    await f.versions(targetMapping, extra.targetAdapterId ?? 'clauses'); await f.certify(targetMapping);
  }
  return f;
}
export async function migrationRequest(f, id = 'migration-1') {
  const s = await f.snapshot();
  return { migrationId: id, taskId: f.options.taskId, source: mapping().versions, target: targetMapping.versions, snapshotDigest: s.digest,
    baseRevision: s.revision, reconciledThroughRevision: s.revision, shadowRef: 'proposal-data-only', checkRefs: [], pendingOperation: null, switchedAtRevision: null,
    restoration: { verified: false, reason: 'Not restored' } };
}
export async function checkedMigration(f) {
  const request = await migrationRequest(f); const prepared = take(await f.runtime.migration.prepare(request));
  take(await f.runtime.migration.catchUp(prepared.migrationId, (await f.snapshot()).revision));
  return prepared;
}
export const headDigest = head => digestJson(head);
