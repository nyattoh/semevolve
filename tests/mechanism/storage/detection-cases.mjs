import assert from 'node:assert/strict';
import { syntheticStorageAdapters } from '@semevolve/storage-planner';
import { createMemoryTaskStore } from '@semevolve/core';
import { fixture, mapping, original, clausePayload, take } from './fixtures.mjs';
import { evaluationDouble } from './evaluation-double.mjs';
import { migrationFixture, checkedMigration, targetMapping } from './migration-fixtures.mjs';

export const cases = [
  { id: 'negation', name: 'L6 negation loss cannot certify a combination', marker: 'L6_NEGATION', async run() {
    const base = syntheticStorageAdapters()[0];
    const broken = { ...base, async decompose(...args) { const r = await base.decompose(...args); if (r.ok) delete r.value[0].representation.meaning.clauses[0].negation; return r; } };
    const f = await fixture({ adapters: [broken], evaluator: evaluationDouble(), plan: { expectedConditions: { payloads: { 'message-1': clausePayload } } } });
    try { await f.versions(); const checks = take(await f.runtime.inspectMapping(mapping()));
      const result = await f.runtime.recordConformance(mapping(), checks.map(c => c.checkId));
      assert.equal(result.ok, false, 'L6_NEGATION'); assert.equal(checks[0].result.meaningPreservation, 'fail');
    } finally { await f.store.close(); }
  } },
  { id: 'unverified', name: 'L6 unverified combinations cannot store', marker: 'L6_UNVERIFIED', async run() {
    const f = await fixture({ adapters: syntheticStorageAdapters(), evaluator: evaluationDouble() });
    try { await f.versions(); const result = await f.runtime.store('message-1', mapping()); assert.equal(result.ok, false, 'L6_UNVERIFIED'); assert.equal(result.error.code, 'unavailable'); }
    finally { await f.store.close(); }
  } },
  { id: 'cas', name: 'L6 stale expected revision cannot switch', marker: 'L6_CAS', async run() {
    const f = await migrationFixture();
    try { await checkedMigration(f); const result = await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision - 1, authorisationRef: 'grant-switch' });
      assert.equal(result.ok, false, 'L6_CAS'); assert.equal(result.error.code, 'revision_conflict'); }
    finally { await f.store.close(); }
  } },
  { id: 'pending', name: 'L6 unreceipted intent remains pending', marker: 'L6_PENDING', async run() {
    const store = createMemoryTaskStore({ mutableCollections: ['registry.heads', 'registry.task-epochs', 'registry.epochs', 'storage.heads', 'storage.migrations'] });
    let armed = false;
    const wrapped = { snapshot: () => store.snapshot(), close: () => store.close(), async transact(batch) {
      const result = await store.transact(batch);
      return armed && batch.events.some(e => e.kind === 'storage.switch.intent') ? { ok: false, error: { code: 'unavailable', reason: 'Synthetic accepted intent response lost' } } : result;
    } };
    const f = await migrationFixture({ store: wrapped });
    try { await checkedMigration(f); armed = true;
      const result = await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }); assert.equal(result.ok, false);
      const pending = take(await f.runtime.migration.reconcile('migration-1')); assert.equal(pending.pendingOperation?.operation, 'switch', 'L6_PENDING'); assert.equal(pending.switchedAtRevision, null); }
    finally { await store.close(); }
  } },
  { id: 'restore', name: 'L6 restoration retains post-switch writes', marker: 'L6_RESTORE', async run() {
    const f = await migrationFixture();
    try { await checkedMigration(f); take(await f.runtime.migration.switch({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-switch' }));
      await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', targetMapping));
      const result = await f.runtime.migration.restore({ migrationId: 'migration-1', expectedRevision: (await f.snapshot()).revision, authorisationRef: 'grant-restore' });
      assert.equal(result.ok, true, 'L6_RESTORE'); assert.deepEqual(take(await f.runtime.retrieve({ all: true }, mapping())).map(u => u.source.messageId).sort(), ['message-1', 'message-2']); }
    finally { await f.store.close(); }
  } },
];
