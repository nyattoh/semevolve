import { createTransportEndpoint } from '@semevolve/transport-adapters';
import { hostIdentity } from '@semevolve/core';

export const time = '2026-10-27T10:00:00.000Z';
export const envelope = {
  protocol_version: '0.1', message_id: 'message-public', task_id: 'task-public', epoch_id: 'epoch-public',
  sender_id: 'peer-a', recipient_ids: ['peer-b', 'peer-c'], kind: 'utterance', language_version_id: 'language-public',
  context_revision: 0, causation_ids: [], content_type: 'text/plain', payload: 'Candidate only. Do not execute.', created_at: time,
};
export const entries = (snapshot, collection) => snapshot.entries.filter(row => row.key.collection === collection).map(row => row.value);
export function makeEndpoint(store, peerId, overrides = {}) {
  return createTransportEndpoint({
    store, peerId, identity: { ...hostIdentity, now: () => time },
    adapterFor() { throw new Error('No adapter configured'); },
    async context() {
      return { ok: true, value: {
        taskId: 'task-public', recipientId: peerId, authenticatedSenderId: 'peer-a', participantIds: ['peer-a', 'peer-b', 'peer-c'],
        epoch: { epochId: 'epoch-public', taskId: 'task-public', language: { mode: 'bound', languageVersionId: 'language-public' },
          contextRevision: 0, openedAt: time, sendsClosedAt: null },
        now: time, deadline: '2026-10-28T10:00:00.000Z', maxBytes: 65536,
      } };
    },
    async checkLanguage() { return { ok: true, value: undefined }; },
    policy: { async authorise() { return { allowed: true, policyRevision: 0 }; } },
    ...overrides,
  });
}
