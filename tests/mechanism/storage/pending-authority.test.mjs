import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoragePlanner } from '@semevolve/storage-planner';
import { digestJson } from '@semevolve/core';
import { pending, request } from './pending-fixtures.mjs';
import { legacyPending } from './legacy-pending-fixtures.mjs';
import { rows, take, reject, original, mapping } from './fixtures.mjs';
import { targetMapping } from './migration-fixtures.mjs';
import { authorised, switchRequest, preserve, assertTerminal, deferred, captureStore, corrupt } from './supersession-fixtures.mjs';

for (const legacy of [false, true]) for (const config of [{}, { ref: 'grant-switch' }, { old: 'expired' }, { old: 'missing' }]) test(`F1 renews ${legacy ? 'legacy' : 'modern'} authority ${JSON.stringify(config)}`, { timeout: 30000 }, async t => {
  const f = await (legacy ? legacyPending('switch') : pending('switch')); t.after(() => f.store.close());
  const before = await f.snapshot(); const { options, ref } = await authorised(f, config); const captured = captureStore(f);
  const runtime = createStoragePlanner({ ...options, store: captured.store });
  const result = await runtime.migration.switch(switchRequest(before.revision, ref));
  assert.equal(result.ok, true, config.ref ? 'F1_POLICY_UPDATE_RESUME' : 'F1_NEW_GRANT_RESUME');
  const after = await f.snapshot(); const state = rows(after, 'storage.migrations')[0];
  assert.equal(state.phase, 'switched'); assert.equal(result.value.pendingOperation, null);
  assertTerminal(after, f.pendingState, state.intent); preserve(before, after);
  const intent = after.entries.find(e => e.key.id === `${state.intent}/intent`).value;
  assert.equal(intent.authorisationRef, ref); assert.equal(intent.policyRevision, 2);
  const batch = captured.batches.find(b => b.mutations.some(m => m.entry.value.kind === 'not_applied'));
  assert.ok(batch.mutations.some(m => m.entry.key.id === `${state.intent}/intent`));
  assert.ok(batch.mutations.some(m => m.entry.key.collection === 'storage.migrations'));
  const settled = await f.snapshot(); take(await f.store.transact(batch)); assert.deepEqual(await f.snapshot(), settled);
  reject(await runtime.migration.switch(switchRequest(before.revision, ref)), 'revision_conflict');
  assert.deepEqual(take(await runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId), ['message-1']);
});

for (const delta of ['original', 'criteria', 'evaluator', 'query', 'conditions']) test(`F1 authority and ${delta} change reach a final explicit switch`, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const before = await f.snapshot();
  const { options, ref } = await authorised(f);
  if (delta === 'original') { await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', mapping())); }
  else {
    options.comparison = { ...options.comparison };
    if (delta === 'criteria') options.comparison.criteriaDigest = digestJson('new-criteria');
    if (delta === 'evaluator') options.comparison.evaluatorVersion = 'new-evaluator';
    if (delta === 'query') options.comparison.queries = [{ all: true, revision: 2 }];
    if (delta === 'conditions') options.comparison.expectedConditions = { ...options.comparison.expectedConditions, condition: 'new' };
  }
  const runtime = createStoragePlanner(options);
  reject(await runtime.migration.switch(switchRequest((await f.snapshot()).revision, ref)), 'unavailable');
  const updated = await f.snapshot(); const current = rows(updated, 'storage.migrations')[0];
  assert.notEqual(current.intent, f.pendingState.intent, 'F1_AUTHORITY_UPDATED_BEFORE_CATCHUP');
  const oldIntent = before.entries.find(e => e.key.id === `${f.pendingState.intent}/intent`).value;
  const newIntent = updated.entries.find(e => e.key.id === `${current.intent}/intent`).value;
  assert.equal(newIntent.inspectionDigest, oldIntent.inspectionDigest);
  assertTerminal(updated, f.pendingState, current.intent); assert.deepEqual(take(await runtime.head()), f.head);
  take(await runtime.migration.catchUp('migration-1', updated.revision));
  take(await runtime.migration.switch(switchRequest((await f.snapshot()).revision, ref)));
  assert.deepEqual(take(await runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), delta === 'original' ? ['message-1', 'message-2'] : ['message-1']);
  preserve(before, await f.snapshot());
});

for (const bad of ['missing', 'revoked', 'expired', 'purpose', 'task', 'target', 'policy', 'denied', 'deadline', 'cancel', 'stop', 'await-expiry']) test(`F1 invalid new authority ${bad} preserves pending`, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const before = await f.snapshot();
  const config = { grant: {} };
  if (bad === 'missing') config.missing = true;
  if (bad === 'revoked') config.grant.revokedAt = f.clock.value;
  if (bad === 'expired') config.grant.expiresAt = f.clock.value;
  if (bad === 'purpose') config.grant.name = 'storage.copy';
  if (bad === 'task') config.grant.taskId = 'other';
  if (bad === 'target') config.grant.target = 'other-scope';
  if (bad === 'policy') config.gateRevision = 1;
  if (bad === 'denied') config.policy = { async authorise() { return { allowed: false, reason: 'denied' }; } };
  const { options, ref } = await authorised(f, config);
  const read = options.references.readTask;
  options.references.readTask = async (...args) => { const r = await read(...args); const task = structuredClone(r.value);
    if (bad === 'deadline') task.deadline = f.clock.value;
    if (bad === 'cancel') task.cancellationRequestedAt = f.clock.value;
    if (bad === 'stop') task.stopReason = 'stopped';
    return { ok: true, value: task };
  };
  if (bad === 'await-expiry') { const policy = options.policy; options.policy = { async authorise(input) { const r = await policy.authorise(input); f.clock.value = '2026-10-30T00:00:00.000Z'; return r; } }; }
  reject(await createStoragePlanner(options).migration.switch(switchRequest(before.revision, ref)), 'unavailable');
  assert.deepEqual(await f.snapshot(), before);
});

test('F1 renewed switch permission does not grant copy permission for a changed dataset', async t => {
  const f = await pending('switch'); t.after(() => f.store.close());
  await f.append('host.originals', 'message-2', original('message-2')); take(await f.runtime.store('message-2', mapping()));
  const denied = await authorised(f, { copyDenied: true });
  reject(await denied.runtime.migration.switch(switchRequest((await f.snapshot()).revision, denied.ref)), 'unavailable');
  const before = await f.snapshot(); const state = rows(before, 'storage.migrations')[0];
  assertTerminal(before, f.pendingState, state.intent);
  reject(await denied.runtime.migration.catchUp('migration-1', before.revision), 'unavailable');
  assert.deepEqual(await f.snapshot(), before);
  const permitted = await authorised(f); take(await permitted.runtime.migration.catchUp('migration-1', before.revision));
  take(await permitted.runtime.migration.switch(switchRequest((await f.snapshot()).revision, permitted.ref)));
  assert.deepEqual(take(await permitted.runtime.retrieve({ all: true }, targetMapping)).map(u => u.source.messageId).sort(), ['message-1', 'message-2']);
});

for (const damage of ['history-key', 'partial-digest', 'other-head', 'missing-head', 'missing-manifest', 'terminal-alias', 'other-pending']) test(`F1 rejects unproved ${damage}`, async t => {
  const f = await pending('switch'); t.after(() => f.store.close()); const before = await f.snapshot(); const { options, ref } = await authorised(f);
  const runtime = corrupt(f, s => {
    const event = s.events.find(e => e.data?.intent === f.pendingState.intent);
    if (damage === 'history-key') event.data.unknown = true;
    if (damage === 'partial-digest') delete event.data.stateDigest;
    if (damage === 'other-head') rows(s, 'storage.heads')[0].generation = 'different';
    if (damage === 'missing-head') s.entries = s.entries.filter(e => e.key.collection !== 'storage.heads');
    if (damage === 'missing-manifest') s.entries = s.entries.filter(e => e.key.collection !== 'storage.manifests');
    if (damage === 'terminal-alias') s.entries.push({ key: { collection: 'storage.operations', id: 'alias' }, value: { kind: 'receipt', executionId: f.pendingState.intent } });
    if (damage === 'other-pending') { const state = structuredClone(f.pendingState); state.migration.migrationId = 'other'; s.entries.push({ key: { collection: 'storage.migrations', id: 'other' }, value: state }); }
  }, options);
  reject(await runtime.migration.switch(switchRequest(before.revision, ref)), 'unavailable'); assert.deepEqual(await f.snapshot(), before);
});
