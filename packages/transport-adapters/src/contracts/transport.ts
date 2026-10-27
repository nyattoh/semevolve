import type { Envelope, MessageId, PeerId, UtcTimestamp } from '@semevolve/core';

export interface DeliveryReceipt {
  readonly messageId: MessageId;
  readonly acceptedAt: UtcTimestamp;
  readonly recipientIds: readonly PeerId[];
}

export interface ReceivedEnvelope {
  readonly envelope: Envelope;
  readonly authenticatedSenderId: PeerId;
  readonly receivedAt: UtcTimestamp;
}

export interface DeliveryBatch {
  readonly deliveries: readonly ReceivedEnvelope[];
  readonly cursor: string | null;
}

export interface TransportAdapter {
  send(envelope: Envelope): Promise<DeliveryReceipt>;
  receive(cursor: string | null): Promise<DeliveryBatch>;
  acknowledge(messageId: MessageId): Promise<void>;
}

export interface OutboxRecord {
  readonly messageId: MessageId;
  readonly recipientId: PeerId;
  readonly attempts: number;
  readonly receipt: DeliveryReceipt | null;
}

export interface InboxRecord {
  readonly messageId: MessageId;
  readonly recipientId: PeerId;
  readonly receivedAt: UtcTimestamp;
  readonly appliedAt: UtcTimestamp | null;
}
