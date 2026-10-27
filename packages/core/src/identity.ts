import { createHash, randomUUID } from 'node:crypto';
import type { Digest, HostIdentity, Id, UtcTimestamp } from './contracts/identity.js';

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new TypeError('Invalid JSON value');
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('Non-JSON object');
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) throw new TypeError('Non-JSON key');
      const keys = Object.keys(descriptors).filter(key => !array || key !== 'length');
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Non-JSON property');
      }
      if (array) {
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) throw new TypeError('Non-JSON array');
        return '[' + keys.map(key => encode(descriptors[key]?.value)).join(',') + ']';
      }
      return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + encode(descriptors[key]?.value)).join(',') + '}';
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

export function digestJson(value: unknown): Digest {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex') as Digest;
}

export const hostIdentity: HostIdentity = Object.freeze({
  newId<Kind extends string>(kind: Kind): Id<Kind> {
    if (!/^[a-z][a-z0-9-]*$/u.test(kind)) throw new TypeError('Invalid ID kind');
    return `${kind}-${randomUUID()}` as Id<Kind>;
  },
  now(): UtcTimestamp { return new Date().toISOString() as UtcTimestamp; },
  digest: digestJson,
});

export function isUtcTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
