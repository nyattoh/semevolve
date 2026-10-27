import assert from 'node:assert/strict';
import { createMemoryTaskStore, digestJson, hostIdentity } from '@semevolve/core';
import { createLanguageRegistry, registryMutableCollections } from '@semevolve/language-registry';

export const now = '2026-10-27T00:00:00.000Z';
export const scope = { scopeId: 'synthetic-scope', purpose: 'public mechanism fixture', taskRange: 'synthetic tasks', participantIds: ['peer-a', 'peer-b'] };
export const fingerprints = scope.participantIds.map(peerId => ({ peerId, provider: 'synthetic', modelId: 'fake-1', cliVersion: 'fake-cli-1', settingsDigest: digestJson({}), introductionDigest: digestJson('intro') }));
export const criteria = { scope, fingerprints, testSetDigest: digestJson('public-suite'), evaluatorVersion: 'fixed-1' };
export const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
export const rejected = (result, code = 'invalid_input') => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, code); };

export function language(id = 'language-v1', changes = {}) {
  const content = { parent_ids: [], scope, specification_text: '否定と条件を含む任意の関係グラフ。SVOは必須ではない。', public_examples: [{ expression: '(条件⇒禁止)', explanation: 'Public synthetic grammar only.', counterexample: false }], change_reason: 'public fixture', compatibility_claims: ['Both peers agree'], ...changes };
  return { ...structuredClone(content), version_id: id, digest: digestJson(content) };
}

export function record(versionId = 'language-v1', fingerprint = fingerprints[0], verdict = 'pass', suffix = '') {
  return { versionId, fingerprint: structuredClone(fingerprint), scopeId: scope.scopeId, testSetDigest: criteria.testSetDigest, evaluatorVersion: criteria.evaluatorVersion,
    checkIds: [`check-${versionId}-${fingerprint.peerId}${suffix}`], verdict, checkedAt: now, expiresAt: '2026-10-28T00:00:00.000Z' };
}

export function proof(r) {
  return { record: structuredClone(r), independent: true, fixedBeforeRun: true, regressionVerdict: r.verdict,
    checks: r.checkIds.map(checkId => ({ executionId: `execution-${checkId}`, taskId: 'synthetic-task', inputDigest: digestJson('public-input'), performedAt: r.checkedAt,
      result: { checkId, targetMessageId: 'synthetic-message', languageVersionId: r.versionId, dimension: 'transmission', verdict: r.verdict, scope: r.scopeId,
        method: 'deterministic_test', evidenceIds: [`evidence-${checkId}`], evaluatorVersion: r.evaluatorVersion, limitation: 'Public synthetic mechanism only.' },
      usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: 0, source: 'unavailable' } })) };
}

export function fixture(store = createMemoryTaskStore({ mutableCollections: registryMutableCollections }), scopes = [criteria]) {
  const proofs = new Map();
  const languages = new Map();
  const clock = { value: now };
  const transition = { change: value => value };
  const options = { store, scopes, identity: { ...hostIdentity, now: () => clock.value }, inspection: { async readConformance(r) { return { ok: true, value: structuredClone(proofs.get(digestJson(r)) ?? null) }; } },
    transitions: { async inspect(request, storeRevision) {
      const v = languages.get(request.epoch.language.languageVersionId);
      return { ok: true, value: transition.change({ storeRevision, taskId: request.taskId, previousEpochId: request.previousEpochId, epochId: request.epoch.epochId,
        scopeId: scope.scopeId, previousSendsClosed: true, pendingMessageIds: [], heldMessageIds: [],
        acquired: fingerprints.map(fingerprint => ({ fingerprint, versionId: v?.version_id ?? null, digest: v?.digest ?? null })) }) };
    } } };
  const registry = createLanguageRegistry(options);
  return { store, registry, options, proofs, languages, clock, transition,
    async register(v = language()) { take(await registry.register(v)); languages.set(v.version_id, v); return v; },
    async certify(r) { proofs.set(digestJson(r), proof(r)); take(await registry.recordConformance(r)); },
    async status(versionId, status, checkIds = [], suffix = '') {
      return registry.appendStatus({ eventId: `event-${versionId}-${status}${suffix}`, versionId, scopeId: scope.scopeId, status, checkIds, reason: 'Public mechanism transition', occurredAt: clock.value });
    },
    async activate(v = language()) {
      await this.register(v);
      take(await this.status(v.version_id, 'CANDIDATE'));
      take(await this.status(v.version_id, 'TRIAL'));
      const records = fingerprints.map(f => record(v.version_id, f));
      for (const r of records) await this.certify(r);
      take(await this.status(v.version_id, 'ACTIVE', records.flatMap(r => r.checkIds)));
      return v;
    } };
}

export function epoch(id = 'epoch-1', versionId = 'language-v1', contextRevision = 0) {
  return { epochId: id, taskId: 'synthetic-task', language: { mode: 'bound', languageVersionId: versionId }, contextRevision, openedAt: now, sendsClosedAt: null };
}

export function request(e = epoch(), previousEpochId = null, expectedRevision = 0) {
  return { taskId: e.taskId, previousEpochId, epoch: e, expectedRevision };
}
