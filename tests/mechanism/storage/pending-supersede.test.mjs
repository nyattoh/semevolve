import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { take, reject, rows, mapping, original } from './fixtures.mjs';
import { migrationFixture, migrationRequest, targetMapping } from './migration-fixtures.mjs';
import { projectionPending } from './projection-pending-fixtures.mjs';
import { captureStore, assertTerminal, preserve, corrupt, authorised, switchRequest } from './supersession-fixtures.mjs';

for (const operation of ['copy', 'catch_up']) for (const format of ['modern', 'legacy', 'legacy-inspection']) for (const delta of [false, true]) test(`F2 ${operation} ${format} delta=${delta} preserves one unapplied terminal`, async t => {
  const f = await projectionPending(operation, format); t.after(() => f.store.close()); const before = await f.snapshot();
  if (delta) { await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', mapping())); }
  const captured = captureStore(f); const runtime = createStoragePlanner({ ...f.options, store: captured.store }); const revision = (await f.snapshot()).revision;
  take(await runtime.migration.catchUp('migration-1', revision));
  const after = await f.snapshot(); const state = rows(after, 'storage.migrations')[0];
  assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'not_applied' && r.executionId === f.pendingState.intent).length, 1, operation === 'copy' ? 'F2_COPY_NOT_APPLIED_ONCE' : 'F2_CATCH_UP_NOT_APPLIED_ONCE');
  assertTerminal(after, f.pendingState, state.intent); preserve(before, after); assert.equal(state.phase, 'checked'); assert.deepEqual(take(await runtime.head()), f.head);
  assert.equal(rows(after, 'storage.manifests').some(m => m.generation === f.pendingState.generation), false);
  assert.equal(rows(after, 'storage.derived').some(m => m.generation === f.pendingState.generation), false);
  const batch = captured.batches.find(b => b.mutations.some(m => m.entry.value.kind === 'not_applied'));
  assert.ok(batch.mutations.some(m => m.entry.key.id === `${state.intent}/intent`));
  assert.ok(batch.events.some(e => e.kind === 'storage.catch_up.intent' && e.data.intentDigest && e.data.stateDigest));
  take(await f.store.transact(batch)); assert.deepEqual(await f.snapshot(), after);
  reject(await runtime.migration.catchUp('migration-1', revision), 'invalid_input');
  take(await runtime.migration.switch(switchRequest(after.revision, 'grant-switch')));
  assert.deepEqual(take(await runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), delta ? ['message-1', 'message-2'] : ['message-1']);
});

for (const operation of ['copy', 'catch_up']) for (const format of ['modern', 'legacy', 'legacy-inspection']) for (const damage of ['intent', 'event', 'actor', 'event-task', 'event-operation', 'partial', 'unknown-key', 'input', 'mapping', 'generation', 'manifest', 'receipt', 'alias-terminal', 'terminal', 'head', 'other-pending']) test(`F2 ${operation} ${format} refuses unproved ${damage}`, async t => {
  const f = await projectionPending(operation, format); t.after(() => f.store.close()); const before = await f.snapshot();
  const runtime = corrupt(f, s => {
    const state = rows(s, 'storage.migrations')[0]; const event = s.events.find(e => e.data?.intent === state.intent); const intent = s.entries.find(e => e.key.id === `${state.intent}/intent`);
    if (damage === 'intent') s.entries = s.entries.filter(e => e !== intent);
    if (damage === 'event') s.events = s.events.filter(e => e !== event);
    if (damage === 'actor') event.actor = 'peer-a';
    if (damage === 'event-task') event.taskId = 'other-task';
    if (damage === 'event-operation') event.kind = 'storage.switch.intent';
    if (damage === 'partial') { delete event.data.intentDigest; event.data.stateDigest = digestJson(state); }
    if (damage === 'unknown-key') event.data.unknown = true;
    if (damage === 'input') intent.value.inputDigest = digestJson('wrong');
    if (damage === 'mapping') state.targetMapping.retrievalSpecification = 'other';
    if (damage === 'generation') state.generation = state.sourceHead.generation;
    if (damage === 'manifest') s.entries.push({ key: { collection: 'storage.manifests', id: state.generation }, value: { generation: state.generation } });
    if (['receipt', 'terminal', 'alias-terminal'].includes(damage)) s.entries.push({ key: { collection: 'storage.operations', id: damage === 'receipt' ? `${state.intent}/receipt` : damage === 'terminal' ? `${state.intent}/not-applied` : 'alias' }, value: { kind: damage === 'receipt' ? 'receipt' : 'not_applied', executionId: state.intent } });
    if (damage === 'head') rows(s, 'storage.heads')[0].revision++;
    if (damage === 'other-pending') { const other = structuredClone(state); other.migration.migrationId = 'other'; s.entries.push({ key: { collection: 'storage.migrations', id: 'other' }, value: other }); }
  });
  reject(await runtime.migration.catchUp('migration-1', before.revision), 'unavailable'); assert.deepEqual(await f.snapshot(), before);
});

for (const operation of ['copy', 'catch_up']) test(`F2 ${operation} replacement uses new copy authority without reactivating the old grant`, async t => {
  const f = await projectionPending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
  const copy = rows(before, 'host.grants').find(g => g.ref === 'grant-copy');
  const runtime = createStoragePlanner({ ...f.options, copyAuthorisationRef: 'grant-copy-next',
    policy: { async authorise(input) { return { allowed: input.name === 'storage.copy' && input.taskId === copy.taskId && input.target === copy.target, policyRevision: 2 }; } },
    references: { ...f.options.references, async readGrant(s, id) {
      if (id === 'grant-copy') return { ok: true, value: null };
      if (id === 'grant-copy-next') return { ok: true, value: { ...copy, ref: id, policyRevision: 2 } };
      return f.options.references.readGrant(s, id);
    } } });
  take(await runtime.migration.catchUp('migration-1', before.revision)); const after = await f.snapshot(); const state = rows(after, 'storage.migrations')[0];
  assertTerminal(after, f.pendingState, state.intent); preserve(before, after);
  const intent = after.entries.find(e => e.key.id === `${state.intent}/intent`).value;
  assert.equal(intent.authorisationRef, 'grant-copy-next'); assert.equal(intent.policyRevision, 2);
});

for (const failed of [false, true]) test(`F2 completed projection pass=${!failed} retains receipt and never becomes not_applied`, async t => {
  const f = await migrationFixture(); t.after(() => f.store.close());
  const evaluator = { ...f.options.evaluator, async evaluateStorage(r) { const result = await f.options.evaluator.evaluateStorage(r); return failed ? { ok: true, value: { ...result.value, meaningPreservation: 'fail' } } : result; } };
  take(await createStoragePlanner({ ...f.options, evaluator }).migration.prepare(await migrationRequest(f)));
  const before = await f.snapshot(); const old = rows(before, 'storage.migrations')[0];
  assert.equal(old.phase, failed ? 'blocked' : 'shadow_ready');
  take(await f.runtime.migration.catchUp('migration-1', before.revision)); const after = await f.snapshot(); preserve(before, after);
  assert.equal(rows(after, 'storage.operations').filter(r => r.kind === 'not_applied' && r.executionId === old.intent).length, 0);
});

for (const operation of ['copy', 'catch_up']) for (const failure of ['grant', 'task', 'refused', 'lost']) test(`F2 ${operation} ${failure} preserves an atomic replacement`, async t => {
  const f = await projectionPending(operation); t.after(() => f.store.close()); const before = await f.snapshot();
  const options = { ...f.options, references: { ...f.options.references } };
  if (failure === 'grant') options.references.readGrant = async () => ({ ok: true, value: null });
  if (failure === 'task') options.references.readTask = async s => ({ ok: true, value: { ...rows(s, 'host.tasks')[0], stopReason: 'stopped' } });
  options.store = { close: () => f.store.close(), snapshot: () => f.store.snapshot(), async transact(b) {
    if (b.mutations.some(m => m.entry.value.kind === 'not_applied')) {
      if (failure === 'refused') return { ok: false, error: { code: 'unavailable', reason: 'Synthetic admission refusal' } };
      if (failure === 'lost') { take(await f.store.transact(b)); throw new Error('Synthetic response loss'); }
    }
    return f.store.transact(b);
  } };
  reject(await createStoragePlanner(options).migration.catchUp('migration-1', before.revision), 'unavailable');
  const after = await f.snapshot();
  if (failure !== 'lost') assert.deepEqual(after, before);
  else { const state = rows(after, 'storage.migrations')[0]; assertTerminal(after, f.pendingState, state.intent); take(await f.runtime.migration.reconcile('migration-1')); assert.deepEqual(await f.snapshot(), after);
    take(await f.runtime.migration.catchUp('migration-1', after.revision)); assertTerminal(await f.snapshot(), state, rows(await f.snapshot(), 'storage.migrations')[0].intent); }
});
