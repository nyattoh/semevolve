import { canonicalJson } from './identity.js';
import type { JsonObject } from './contracts/identity.js';

export function sameManifest(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  const canon = (items: readonly unknown[]): string[] | null => {
    try { return items.map(item => canonicalJson(item)).sort(); }
    catch { return null; }
  };
  const left = canon(actual);
  const right = canon(expected);
  return left !== null && right !== null && left.length === right.length && left.every((item, index) => item === right[index]);
}

export function completionProven(proof: unknown, expected: { readonly identity: JsonObject; readonly steps: readonly string[] }): proof is JsonObject {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  const record = proof as JsonObject;
  if (!record.identity || typeof record.identity !== 'object' || Array.isArray(record.identity)) return false;
  if (!Array.isArray(record.steps) || record.steps.length !== expected.steps.length) return false;
  try {
    if (canonicalJson(record.identity) !== canonicalJson(expected.identity)) return false;
  } catch { return false; }
  return record.steps.every((step, index) => step === expected.steps[index]);
}
