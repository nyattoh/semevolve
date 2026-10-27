import type { Id, UtcTimestamp } from '@semevolve/core';

export function syntheticId<Kind extends string>(kind: Kind): Id<Kind> {
  return `synthetic-${kind}-001` as Id<Kind>;
}

export const syntheticTimestamp = '2026-01-01T00:00:00.000Z' as UtcTimestamp;
