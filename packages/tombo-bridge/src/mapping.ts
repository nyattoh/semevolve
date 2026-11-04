import { createHash } from 'node:crypto';
import type { EvidenceRef, JsonValue } from '@semevolve/core';

export interface EvidenceMetadata {
  readonly evidenceId: string;
  readonly kind: 'document' | 'code' | 'test' | 'user_statement';
  readonly sourceGroup: string;
  readonly version: string | null;
}
export function mapEvidence(refs: readonly EvidenceRef[], metadata: readonly EvidenceMetadata[], readerId: string): JsonValue[] {
  return refs.filter(ref => ref.content.kind === 'retrieved').map(ref => {
    if (ref.content.kind !== 'retrieved') throw new Error('Evidence content changed');
    const meta = metadata.find(m => m.evidenceId === ref.evidenceId);
    if (!meta || !ref.allowedReaders.some(id => id === readerId) || !meta.sourceGroup.trim() || !ref.scope.trim()
      || createHash('sha256').update(ref.content.body, 'utf8').digest('hex') !== ref.content.digest) throw new Error('Retrieved evidence lacks matching provenance, passage or reader authority');
    return { id: ref.evidenceId, kind: meta.kind, locator: ref.source, sourceGroup: meta.sourceGroup, retrievedAt: ref.content.retrievedAt, version: meta.version,
      scope: ref.scope, passage: ref.content.body, contentHash: ref.content.digest, validity: 'current' };
  });
}
