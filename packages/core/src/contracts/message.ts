import type { Digest, EpochId, LanguageVersionId, MessageId, PeerId, TaskId, UtcTimestamp } from './identity.js';

export type MessageKind = 'utterance' | 'clarification' | 'proposal' | 'acceptance'
  | 'rejection' | 'language_notice' | 'cancellation';

export interface Envelope {
  readonly protocol_version: '0.1';
  readonly message_id: MessageId;
  readonly task_id: TaskId;
  readonly epoch_id: EpochId;
  readonly sender_id: PeerId;
  readonly recipient_ids: readonly [PeerId, ...PeerId[]];
  readonly kind: MessageKind;
  readonly language_version_id: LanguageVersionId | null;
  readonly context_revision: number;
  readonly causation_ids: readonly MessageId[];
  readonly content_type: string;
  readonly payload: string;
  readonly created_at: UtcTimestamp;
}

export interface StoredMessage {
  readonly envelope: Envelope;
  readonly digest: Digest;
}

export interface Epoch {
  readonly epochId: EpochId;
  readonly taskId: TaskId;
  readonly language: { readonly mode: 'bootstrap'; readonly languageVersionId: null }
    | { readonly mode: 'bound'; readonly languageVersionId: LanguageVersionId };
  readonly contextRevision: number;
  readonly openedAt: UtcTimestamp;
  readonly sendsClosedAt: UtcTimestamp | null;
}

export interface EnvelopeContext {
  readonly taskId: TaskId;
  readonly recipientId: PeerId;
  readonly authenticatedSenderId: PeerId;
  readonly participantIds: readonly PeerId[];
  readonly epoch: Epoch;
  readonly now: UtcTimestamp;
  readonly deadline: UtcTimestamp;
  readonly maxBytes: number;
}

export type EnvelopeRejection = 'invalid_format' | 'oversize' | 'protocol_mismatch'
  | 'task_mismatch' | 'recipient_mismatch' | 'sender_mismatch' | 'participant_denied'
  | 'epoch_mismatch' | 'context_mismatch' | 'language_mismatch' | 'expired' | 'digest_mismatch';
