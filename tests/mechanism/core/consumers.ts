import {
  createMemoryTaskStore, hostIdentity, openFileTaskStore, parseEnvelope,
  type EnvelopeContext, type EnvelopeRejection, type HostIdentity, type StoreTransaction, type TaskStore,
} from '@semevolve/core';
import type { LanguageHead, LanguageVersion } from '@semevolve/language-registry';
import type { BudgetSnapshot } from '@semevolve/policy';
import type { InboxRecord, OutboxRecord } from '@semevolve/transport-adapters';

const identity: HostIdentity = hostIdentity;
const memory: TaskStore = createMemoryTaskStore({ mutableCollections: ['state'] });

export async function coreConsumer(directory: string, input: string, context: EnvelopeContext, batch: StoreTransaction) {
  const file: TaskStore = await openFileTaskStore(directory, { mutableCollections: ['state'] });
  for (const store of [memory, file]) {
    const committed = await store.transact(batch);
    if (committed.ok) {
      const revision: number = committed.value.revision;
      void revision;
    }
    const snapshot = await store.snapshot();
    if (snapshot.ok) {
      const hash: string = snapshot.value.digest;
      void hash;
    }
    await store.close();
  }
  const parsed = parseEnvelope(input, context);
  const digestMismatch: EnvelopeRejection = 'digest_mismatch';
  if (!parsed.ok && parsed.error === digestMismatch) {
    const reason: 'digest_mismatch' = parsed.error;
    void reason;
  }
  if (parsed.ok) {
    const id: typeof parsed.value.envelope.message_id = identity.newId('message');
    void id;
  }
  return parsed;
}

export type RemainingConsumers = [LanguageHead, LanguageVersion, BudgetSnapshot, InboxRecord, OutboxRecord];
