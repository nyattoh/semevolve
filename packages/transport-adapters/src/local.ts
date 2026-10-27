import { canonicalJson, hostIdentity, type Envelope, type HostIdentity, type PeerId } from '@semevolve/core';
import type { ReceivedEnvelope, TransportAdapter } from './contracts/transport.js';

export function createLocalTransportHub(registeredPeerIds: readonly PeerId[], identity: HostIdentity = hostIdentity) {
  if (!registeredPeerIds.length || registeredPeerIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(registeredPeerIds).size !== registeredPeerIds.length) throw new TypeError('Invalid registered peers');
  const queues = new Map<PeerId, ReceivedEnvelope[]>(registeredPeerIds.map(id => [id, []]));
  return {
    connect(authenticatedSenderId: PeerId, recipientId: PeerId): TransportAdapter {
      if (!queues.has(authenticatedSenderId) || !queues.has(recipientId)) throw new Error('Peer is not registered');
      return {
        async send(input) {
          const envelope = JSON.parse(canonicalJson(input)) as Envelope;
          if (envelope.sender_id !== authenticatedSenderId) throw new Error('Authenticated sender mismatch');
          if (!Array.isArray(envelope.recipient_ids) || !envelope.recipient_ids.includes(recipientId)
            || envelope.recipient_ids.some(id => !queues.has(id))) throw new Error('Recipient is not registered or addressed');
          const acceptedAt = identity.now();
          queues.get(recipientId)!.push({ envelope, authenticatedSenderId, receivedAt: acceptedAt });
          return { messageId: envelope.message_id, recipientIds: [recipientId], acceptedAt };
        },
        async receive() { return { deliveries: structuredClone(queues.get(recipientId)!), cursor: null }; },
        async acknowledge(messageId) { queues.set(recipientId, queues.get(recipientId)!.filter(item => item.envelope.message_id !== messageId)); },
      };
    },
  };
}
