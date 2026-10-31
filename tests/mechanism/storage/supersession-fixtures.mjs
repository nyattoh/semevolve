import assert from 'node:assert/strict';
import { createAllowListPolicyGate } from '@semevolve/policy';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { rows, take } from './fixtures.mjs';

export function authorityOptions(options, grants, config = {}) {
  const ref = config.ref ?? 'grant-switch-next';
  const revision = config.revision ?? 2;
  const old = grants.find(g => g.ref === 'grant-switch');
  const grant = { ...old, ref, policyRevision: revision, ...config.grant };
  return { ...options, policy: config.policy ?? createAllowListPolicyGate({ policyRevision: config.gateRevision ?? revision, grants }),
    references: { ...options.references, async readGrant(s, id) {
      if (id === ref) return { ok: true, value: config.missing ? null : grant };
      const result = await options.references.readGrant(s, id);
      if (!result.ok || !result.value) return result;
      const value = { ...result.value, policyRevision: revision };
      if (id === 'grant-switch') {
        if (config.old === 'missing') return { ok: true, value: null };
        if (config.old === 'expired') value.expiresAt = '2026-10-27T00:00:00.000Z';
        else value.revokedAt = '2026-10-28T00:00:00.000Z';
      }
      if (id === 'grant-copy' && config.copyDenied) value.revokedAt = '2026-10-28T00:00:00.000Z';
      return { ok: true, value };
    } } };
}
export async function authorised(f, config = {}) {
  const options = authorityOptions(f.options, rows(await f.snapshot(), 'host.grants'), config);
  return { options, runtime: createStoragePlanner(options), ref: config.ref ?? 'grant-switch-next' };
}
export const switchRequest = (revision, ref = 'grant-switch-next') => ({ migrationId: 'migration-1', expectedRevision: revision, authorisationRef: ref });
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export function preserve(before, after) {
  for (const entry of before.entries.filter(e => ['storage.operations', 'host.tasks', 'host.grants', 'storage.originals', 'storage.manifests', 'storage.derived', 'storage.inspections'].includes(e.key.collection))) {
    assert.deepEqual(after.entries.find(e => e.key.collection === entry.key.collection && e.key.id === entry.key.id), entry);
  }
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
}
export function corrupt(f, change, options = f.options) {
  return createStoragePlanner({ ...options, store: { close: () => f.store.close(), transact: b => f.store.transact(b), async snapshot() {
    const s = structuredClone(await f.snapshot()); change(s); const { digest, ...body } = s; s.digest = digestJson(body); return { ok: true, value: s };
  } } });
}
export function captureStore(f, hook = async () => {}) {
  const batches = [];
  const store = { close: () => f.store.close(), snapshot: () => f.store.snapshot(), async transact(batch) {
    batches.push(structuredClone(batch)); await hook(batch); return f.store.transact(batch);
  } };
  return { store, batches };
}
export function assertTerminal(s, old, successor) {
  const entries = s.entries.filter(e => e.key.collection === 'storage.operations' && e.value.kind === 'not_applied' && e.value.executionId === old.intent);
  assert.equal(entries.length, 1, 'UNAPPLIED_TERMINAL_ONCE');
  assert.equal(entries[0].key.id, `${old.intent}/not-applied`);
  assert.equal(entries[0].value.successor, successor); assert.equal(entries[0].value.operation, old.migration.pendingOperation.operation);
  assert.equal(Object.hasOwn(entries[0].value, 'pass'), false);
  assert.equal(rows(s, 'storage.operations').some(r => r.kind === 'receipt' && r.executionId === old.intent), false);
}
