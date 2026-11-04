import { canonicalJson } from './identity.js';
import type { JsonObject, JsonValue } from './contracts/identity.js';

const boundIdentityBrand: unique symbol = Symbol('semevolve.boundIdentity');
type IdentityFields<K extends readonly string[]> = { readonly [P in K[number]]: JsonValue };

export interface BoundIdentity {
  readonly [boundIdentityBrand]: readonly string[];
  readonly identity: JsonObject;
  readonly keys: readonly string[];
  matches(actual: unknown): boolean;
}

export function sameManifest(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  const canon = (items: readonly unknown[]): string[] | null => {
    try { return items.map(item => canonicalJson(item)).sort(); }
    catch { return null; }
  };
  const left = canon(actual);
  const right = canon(expected);
  return left !== null && right !== null && left.length === right.length && left.every((item, index) => item === right[index]);
}

export function uniqueManifest(items: readonly unknown[]): boolean {
  let canon: string[];
  try { canon = items.map(item => canonicalJson(item)); }
  catch { return false; }
  const distinct = canon.filter((item, index) => canon.indexOf(item) === index);
  return sameManifest(canon, distinct);
}

export function bindIdentity<const K extends readonly string[]>(keys: K, value: IdentityFields<K>): BoundIdentity {
  const fields = Object.keys(value);
  if (keys.length === 0 || !sameManifest(fields, [...keys])) throw new Error('Identity fields do not match the required manifest');
  const source = value as Readonly<Record<string, JsonValue | undefined>>;
  const identity: { [key: string]: JsonValue } = {};
  for (const key of keys) {
    const item = source[key];
    if (!Object.hasOwn(value, key) || item === undefined) throw new Error('Identity fields do not match the required manifest');
    identity[key] = item;
  }
  canonicalJson(identity);
  const boundKeys = Object.freeze([...keys]);
  const plain = Object.freeze(identity);
  return Object.freeze({
    [boundIdentityBrand]: boundKeys,
    identity: plain,
    keys: boundKeys,
    matches: (actual: unknown) => sameIdentity(actual, plain, boundKeys),
  });
}

export function sameIdentity(actual: unknown, expected: unknown, keys: readonly string[]): boolean {
  if (!plain(actual) || !plain(expected)) return false;
  if (!sameManifest(Object.keys(actual), keys) || !sameManifest(Object.keys(expected), keys)) return false;
  try { return canonicalJson(actual) === canonicalJson(expected); }
  catch { return false; }
}

export function sameFields<const K extends readonly string[]>(keys: K, actual: { readonly [P in K[number]]: unknown }, expected: { readonly [P in K[number]]: unknown }): boolean {
  try { return bindIdentity(keys, expected as IdentityFields<K>).matches(bindIdentity(keys, actual as IdentityFields<K>).identity); }
  catch { return false; }
}

export function completionProven(proof: unknown, expected: { readonly identity: BoundIdentity; readonly steps: readonly string[] }): proof is JsonObject {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  const record = proof as { readonly identity?: unknown; readonly steps?: unknown };
  if (!expected.identity.matches(record.identity)) return false;
  if (!Array.isArray(record.steps) || record.steps.length !== expected.steps.length) return false;
  return record.steps.every((step, index) => step === expected.steps[index]);
}

function plain(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
