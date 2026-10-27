import type { Digest, Result } from './contracts/identity.js';
import type { Envelope, EnvelopeContext, EnvelopeRejection, StoredMessage } from './contracts/message.js';
import { digestJson, isUtcTimestamp } from './identity.js';

const fields = ['protocol_version', 'message_id', 'task_id', 'epoch_id', 'sender_id', 'recipient_ids', 'kind',
  'language_version_id', 'context_revision', 'causation_ids', 'content_type', 'payload', 'created_at'];
const kinds = new Set(['utterance', 'clarification', 'proposal', 'acceptance', 'rejection', 'language_notice', 'cancellation']);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const identifiers = (value: unknown): value is string[] => Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;

export function parseEnvelope(wire: string | Uint8Array, context: EnvelopeContext, expectedDigest?: Digest): Result<StoredMessage, EnvelopeRejection> {
  const reject = (error: EnvelopeRejection): Result<StoredMessage, EnvelopeRejection> => ({ ok: false, error });
  if (!Number.isSafeInteger(context.maxBytes) || context.maxBytes < 1
    || !isUtcTimestamp(context.now) || !isUtcTimestamp(context.deadline)) return reject('invalid_format');
  if (typeof wire !== 'string' && !(wire instanceof Uint8Array)) return reject('invalid_format');
  if ((typeof wire === 'string' ? Buffer.byteLength(wire, 'utf8') : wire.byteLength) > context.maxBytes) return reject('oversize');
  let value: unknown;
  try {
    value = JSON.parse(typeof wire === 'string' ? wire : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(wire));
  } catch { return reject('invalid_format'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid_format');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || !fields.every(field => Object.hasOwn(record, field))) return reject('invalid_format');
  if (typeof record.protocol_version !== 'string'
    || !['message_id', 'task_id', 'epoch_id', 'sender_id', 'content_type'].every(field => identifier(record[field]))
    || !identifiers(record.recipient_ids) || record.recipient_ids.length === 0
    || !identifiers(record.causation_ids) || typeof record.kind !== 'string' || !kinds.has(record.kind)
    || (record.language_version_id !== null && !identifier(record.language_version_id))
    || !Number.isSafeInteger(record.context_revision) || Number(record.context_revision) < 0
    || typeof record.payload !== 'string' || !isUtcTimestamp(record.created_at)) return reject('invalid_format');
  if (record.protocol_version !== '0.1') return reject('protocol_mismatch');
  if (record.task_id !== context.taskId || context.epoch.taskId !== context.taskId) return reject('task_mismatch');
  if (!record.recipient_ids.includes(context.recipientId)) return reject('recipient_mismatch');
  if (record.sender_id !== context.authenticatedSenderId) return reject('sender_mismatch');
  if (![record.sender_id, ...record.recipient_ids].every(peer => context.participantIds.includes(peer as Envelope['sender_id']))) return reject('participant_denied');
  if (record.epoch_id !== context.epoch.epochId || context.epoch.sendsClosedAt !== null) return reject('epoch_mismatch');
  if (record.context_revision !== context.epoch.contextRevision) return reject('context_mismatch');
  if (record.language_version_id !== context.epoch.language.languageVersionId) return reject('language_mismatch');
  if (context.now >= context.deadline) return reject('expired');
  if (record.created_at > context.now || record.created_at < context.epoch.openedAt) return reject('invalid_format');
  const envelope = record as unknown as Envelope;
  const digest = digestJson(envelope);
  if (expectedDigest !== undefined && expectedDigest !== digest) return reject('invalid_format');
  return { ok: true, value: { envelope, digest } };
}
