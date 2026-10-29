import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryTaskStore, digestJson, openFileTaskStore } from '@semevolve/core';
import { registryMutableCollections } from '@semevolve/language-registry';
import { createStoragePlanner, storageMutableCollections } from '@semevolve/storage-planner';
import { mapping, rows, take } from './fixtures.mjs';
import { comparisonProposal, recordingFixture } from './recording-evaluation-fixtures.mjs';

const mutableCollections = [...registryMutableCollections, ...storageMutableCollections, 'host.tasks', 'host.grants'];
const storageEntries = s => s.entries.filter(e => e.key.collection.startsWith('storage.'));
const storageEvents = s => s.events.filter(e => e.kind.startsWith('storage.'));
const counts = s => ({ inspections: rows(s, 'storage.inspections').length, comparisons: rows(s, 'storage.comparisons').length, conformance: rows(s, 'storage.conformance').length, events: storageEvents(s).length });
const difference = (before, after) => Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));

function barrier() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  let armed = true;
  const order = [];
  return { entered, order, release() { order.push('release'); release(); }, async hold(value) {
    if (!armed) return;
    armed = false; order.push('entered'); enter(value); await released;
  } };
}

export async function standaloneCase(t, backend, operation, change) {
  const directory = backend === 'file' ? await mkdtemp(join(tmpdir(), 'semevolve-standalone-cas-')) : null;
  let store = directory ? await openFileTaskStore(directory, { mutableCollections }) : createMemoryTaskStore({ mutableCollections });
  const gate = barrier();
  let running;
  t.signal.addEventListener('abort', () => gate.release(), { once: true });
  try {
    const f = await recordingFixture({ writing: false, store });
    const { inspectionEligibility, ...plain } = f.options;
    assert.equal(Object.hasOwn(plain, 'inspectionEligibility'), false);
    const readOriginal = plain.references.readOriginal;
    let hookArmed = false;
    const runtime = createStoragePlanner({ ...plain, references: { ...plain.references, async readOriginal(s, id) {
      const result = await readOriginal(s, id);
      if (hookArmed && operation === 'conformance') {
        hookArmed = false;
        assert.equal(result.ok, true); assert.notEqual(result.value, null);
        await gate.hold({ snapshotRevision: s.revision, original: result.value });
      }
      return result;
    } } });
    const baseline = comparisonProposal(), candidate = comparisonProposal('candidate');
    if (operation === 'compare') {
      take(await runtime.registerProposal(baseline)); take(await runtime.registerProposal(candidate));
    }
    const checks = operation === 'conformance' ? take(await runtime.inspectMapping(mapping())) : [];
    const ids = checks.map(c => c.checkId);
    const s0 = take(await store.snapshot());
    assert.equal(rows(s0, 'storage.conformance').length, 0);
    const callsBefore = f.controls.calls;
    f.controls.after = async (request, result) => {
      if (operation !== 'conformance') await gate.hold({ request, result });
    };
    hookArmed = true;
    let completed = false;
    running = (operation === 'inspect' ? runtime.inspectMapping(mapping()) : operation === 'compare' ? runtime.compare(baseline, candidate) : runtime.recordConformance(mapping(), ids))
      .then(result => { completed = true; return result; });
    const hook = await Promise.race([gate.entered, running.then(result => { assert.fail(`D27 hook not reached: ${JSON.stringify(result)}`); })]);
    assert.equal(completed, false);
    const current = take(await store.snapshot());
    assert.deepEqual(current, s0);
    let external = null;
    if (change !== 'none') {
      const collection = change === 'cancel' ? 'host.tasks' : 'host.grants';
      const id = change === 'cancel' ? 'storage-task' : 'grant-copy';
      const entry = current.entries.find(e => e.key.collection === collection && e.key.id === id);
      assert.notEqual(entry, undefined);
      const value = structuredClone(entry.value);
      if (change === 'cancel') { value.cancellationRequestedAt = f.clock.value; value.stopReason = 'cancelled'; value.revision++; }
      else value.revokedAt = f.clock.value;
      const event = { eventId: f.options.identity.newId('event'), taskId: f.taskId, actor: 'host', kind: change === 'cancel' ? 'synthetic.task_cancelled' : 'synthetic.grant_revoked', occurredAt: f.clock.value, data: { collection, id } };
      const batch = { transactionId: f.options.identity.newId('transaction'), expectedRevision: current.revision, mutations: [{ kind: 'replace', expectedDigest: digestJson(entry.value), entry: { key: entry.key, value } }], events: [event] };
      const result = await store.transact(batch); take(result);
      external = { batch, result };
      gate.order.push('external_committed');
    }
    const s1 = take(await store.snapshot());
    assert.equal(s1.revision, s0.revision + (change === 'none' ? 0 : 1));
    gate.release();
    const result = await running;
    gate.order.push('operation_completed');
    const after = take(await store.snapshot());
    let reopened = null;
    if (directory) {
      await store.close(); store = await openFileTaskStore(directory, { mutableCollections });
      reopened = take(await store.snapshot()); assert.deepEqual(reopened, after);
    }
    const added = difference(counts(s0), counts(after));
    const observed = { ok: result.ok, error: result.ok ? null : result.error, added, revision: after.revision };
    t.diagnostic(JSON.stringify({ backend, operation, change, runtime: process.version, fixtureClock: f.clock.value, query: f.options.comparison.queries, criteria: f.options.comparison.criteriaDigest, evaluator: f.options.comparison.evaluatorVersion, hook, order: gate.order, s0, external, s1, result, after, reopened, observed }));
    assert.deepEqual(gate.order, change === 'none' ? ['entered', 'release', 'operation_completed'] : ['entered', 'external_committed', 'release', 'operation_completed']);
    assert.equal(f.controls.calls - callsBefore, operation === 'compare' ? 2 : operation === 'inspect' ? 1 : 0);
    assert.equal(f.controls.eligibilityReads, 0);
    assert.deepEqual(after.events.slice(0, s0.events.length), s0.events);
    for (const entry of storageEntries(s0)) assert.deepEqual(after.entries.find(e => digestJson(e.key) === digestJson(entry.key)), entry);
    assert.deepEqual(after.events.filter(e => e.kind.startsWith('synthetic.')), external ? external.batch.events : []);
    if (external) {
      const entry = external.batch.mutations[0].entry;
      assert.deepEqual(after.entries.find(e => digestJson(e.key) === digestJson(entry.key)), entry);
      assert.deepEqual(observed, { ok: false, error: { code: 'revision_conflict', expected: s0.revision, actual: s1.revision }, added: { inspections: 0, comparisons: 0, conformance: 0, events: 0 }, revision: s1.revision }, 'D27_STANDALONE_CAS');
      assert.deepEqual(storageEntries(after), storageEntries(s0));
    } else {
      const expected = operation === 'inspect' ? { inspections: 1, comparisons: 0, conformance: 0, events: 1 } : operation === 'compare' ? { inspections: 2, comparisons: 1, conformance: 0, events: 1 } : { inspections: 0, comparisons: 0, conformance: 1, events: 1 };
      assert.deepEqual(observed, { ok: true, error: null, added: expected, revision: s0.revision + 1 });
      const event = after.events.at(-1);
      assert.equal(event.kind, operation === 'inspect' ? 'storage.inspected' : operation === 'compare' ? 'storage.compared' : 'storage.registered');
      if (operation === 'conformance') {
        assert.equal(event.data.collection, 'storage.conformance');
        assert.deepEqual(rows(after, 'storage.conformance')[0].ids, ids);
        assert.deepEqual(rows(after, 'storage.inspections'), checks);
      } else {
        for (const c of rows(after, 'storage.inspections')) assert.deepEqual([c.result.literalRestoration, c.result.meaningPreservation, c.result.retrievalCorrectness], ['pass', 'pass', 'pass']);
        if (operation === 'compare') assert.equal(rows(after, 'storage.comparisons')[0].selectedProposalId, 'baseline');
      }
    }
  } finally {
    gate.release();
    if (running) await running;
    await store.close();
  }
}
