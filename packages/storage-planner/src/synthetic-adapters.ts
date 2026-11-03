import type { JsonValue } from '@semevolve/core';
import type { StorageAdapter } from './types.js';
import * as v from './validation.js';

export function syntheticStorageAdapters(): readonly StorageAdapter[] {
  return ['clauses', 'graph'].map(id => ({
    id,
    async decompose(original, mapping, identity) {
      return v.boundary(async () => {
        const payload: unknown = JSON.parse(original.message.envelope.payload);
        if (!v.object(payload) || (id === 'clauses' ? payload.kind !== 'clause_sequence' || !Array.isArray(payload.clauses)
          : payload.kind !== 'directed_graph' || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges))) return v.unavailable('Finite synthetic adapter cannot represent this payload');
        return [{ unitId: `${original.message.envelope.message_id}/${mapping.mappingId}`, source: { messageId: original.message.envelope.message_id,
          digest: original.payloadDigest, location: { kind: 'range' as const, start: 0, end: original.message.envelope.payload.length, unit: 'utf16_code_unit' as const } },
          versions: structuredClone(mapping.versions), representation: { meaning: v.json(payload), literalPayload: original.message.envelope.payload },
          eventRefs: [...original.eventRefs], interpretationRefs: [...original.interpretationRefs], checkRefs: [...original.checkRefs], ambiguities: [], createdAt: identity.now() }];
      });
    },
    async retrieve(query, units) {
      return v.boundary(async () => {
        if (!v.object(query) || !(query.all === true || v.text(query.messageId))) v.invalid('Unsupported public synthetic query');
        return structuredClone(query.messageId ? units.filter(u => u.source.messageId === query.messageId) : units);
      });
    },
    async restoreLiteral(units, original) {
      return v.boundary(async () => {
        const unit = units.find(u => u.source.messageId === original.message.envelope.message_id);
        const rep: JsonValue | undefined = unit?.representation;
        if (!v.object(rep) || typeof rep.literalPayload !== 'string') return v.unavailable('Literal is unavailable');
        return rep.literalPayload;
      });
    },
  }));
}
