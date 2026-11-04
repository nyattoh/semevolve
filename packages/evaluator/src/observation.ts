import type { Verdict } from '@semevolve/core';

export function aggregateVerdict(verdicts: readonly Verdict[]): Verdict {
  return verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
}

export interface ObservedCheck {
  readonly recheckRequired: boolean;
  readonly reason: string | null;
  readonly verdict: Verdict;
}
export type Observation = { readonly kind: 'recheck'; readonly reason: string } | { readonly kind: 'observed'; readonly verdict: Verdict };

export function classifyObservation(check: ObservedCheck): Observation {
  if (check.recheckRequired) return { kind: 'recheck', reason: check.reason ?? 'needs re-check' };
  return { kind: 'observed', verdict: check.verdict };
}
