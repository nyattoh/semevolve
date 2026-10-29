import type { JsonValue, Verdict } from '@semevolve/core';
import * as v from './validation.js';
import { projectionConditions } from './storage-projection.js';
import type { ProjectionConditions } from './storage-projection.js';

export interface Condition { readonly path: readonly string[]; readonly equals: JsonValue }
export interface Conditions { readonly kind: 'conditions-v1'; readonly checks: readonly Condition[] }
export interface StorageConditions { readonly kind: 'storage-v1'; readonly meaning: readonly Condition[]; readonly retrieval: { readonly path: readonly string[]; readonly expected: readonly string[] } }
function path(x: unknown): x is string[] { return Array.isArray(x) && x.length > 0 && x.every(k => v.text(k) && !['__proto__', 'prototype', 'constructor'].includes(k)); }
function checks(x: unknown): x is Condition[] {
  return Array.isArray(x) && x.length > 0 && x.every(c => v.object(c) && Object.keys(c).length === 2 && path(c.path) && Object.hasOwn(c, 'equals') && v.json(c.equals));
}
export function conditions(x: unknown): x is Conditions { return v.object(x) && Object.keys(x).length === 2 && x.kind === 'conditions-v1' && checks(x.checks); }
export function storageConditions(x: unknown): x is StorageConditions | ProjectionConditions {
  return projectionConditions(x) || v.object(x) && Object.keys(x).length === 3 && x.kind === 'storage-v1' && checks(x.meaning)
    && v.object(x.retrieval) && Object.keys(x.retrieval).length === 2 && path(x.retrieval.path) && v.strings(x.retrieval.expected) && x.retrieval.expected.length > 0;
}
export function at(value: JsonValue, keys: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of keys) {
    if (!v.record(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
export function compare(value: JsonValue, rules: readonly Condition[]): Verdict {
  let missing = false;
  for (const rule of rules) {
    const observed = at(value, rule.path);
    if (observed === undefined) missing = true;
    else if (!v.same(observed, rule.equals)) return 'fail';
  }
  return missing ? 'inconclusive' : 'pass';
}
export function retrieval(value: JsonValue, rules: StorageConditions['retrieval']): Verdict {
  const observed = at(value, rules.path);
  if (observed === undefined) return 'inconclusive';
  return v.strings(observed) && v.same([...observed].sort(), [...rules.expected].sort()) ? 'pass' : 'fail';
}
