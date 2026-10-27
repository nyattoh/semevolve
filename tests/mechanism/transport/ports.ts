import { digestJson, type Envelope, type EnvelopeContext, type PeerId, type Result } from '@semevolve/core';
import type { LanguageRegistry, LanguageVersion, ParticipantFingerprint } from '@semevolve/language-registry';
import type { PolicyGate } from '@semevolve/policy';
import type { TransportEndpointOptions } from '@semevolve/transport-adapters';

export function frozenPortDoubles(context: EnvelopeContext) {
  const controls = { known: true, conforming: true, allowed: true };
  const content = { parent_ids: [], scope: { scopeId: 'public', purpose: 'synthetic', taskRange: 'public', participantIds: context.participantIds },
    specification_text: 'Public synthetic language data.', public_examples: [], change_reason: 'Synthetic', compatibility_claims: [] };
  const version: LanguageVersion = { ...content, version_id: 'language-public' as LanguageVersion['version_id'], digest: digestJson(content) };
  const unused = async (): Promise<never> => { throw new Error('This frozen port method is outside the transport fixture'); };
  const registry: LanguageRegistry = {
    register: unused, recordConformance: unused, appendStatus: unused, statusEvents: unused, head: unused, selectHead: unused, nextEpoch: unused,
    async get(id) { return { ok: true, value: controls.known && id === version.version_id ? version : null }; },
    async conformance(versionId, fingerprint, scopeId) {
      return { ok: true, value: controls.conforming ? [{ versionId, fingerprint, scopeId, testSetDigest: digestJson(['public']),
        evaluatorVersion: 'public-1', checkIds: [], verdict: 'pass', checkedAt: context.now, expiresAt: null }] : [] };
    },
  };
  const policy: PolicyGate = { async authorise() { return controls.allowed
    ? { allowed: true, policyRevision: 0 } : { allowed: false, reason: 'Synthetic refusal' }; } };
  const checkLanguage: TransportEndpointOptions['checkLanguage'] = async (envelope: Envelope, peer: PeerId): Promise<Result<void>> => {
    const unavailable = { ok: false, error: { code: 'unavailable', reason: 'Language not confirmed' } } as const;
    if (envelope.language_version_id === null) return unavailable;
    const known = await registry.get(envelope.language_version_id);
    if (!known.ok || !known.value) return unavailable;
    const fingerprint: ParticipantFingerprint = { peerId: peer, provider: 'synthetic', modelId: null, cliVersion: null,
      settingsDigest: digestJson({}), introductionDigest: digestJson({}) };
    const checked = await registry.conformance(known.value.version_id, fingerprint, 'public');
    return checked.ok && checked.value.some(record => record.verdict === 'pass') ? { ok: true, value: undefined } : unavailable;
  };
  return { controls, registry, policy, checkLanguage };
}
