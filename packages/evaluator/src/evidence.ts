import { createHash } from 'node:crypto';
import type { EvidenceRef, JsonValue, PeerId, Verdict } from '@semevolve/core';
import type { Conditions } from './conditions.js';
import { compare } from './conditions.js';
import * as v from './validation.js';

export const bodyDigest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');
export interface Judgement { readonly verdict: Verdict; readonly limitation: string | null }
export function checkSources(evidence: readonly EvidenceRef[], rules: Conditions, scope: string, evaluatorId: PeerId, withdrawn: ReadonlySet<string>): Judgement {
  let unknown = evidence.length === 0;
  let failed = false;
  const reasons: string[] = [];
  if (unknown) reasons.push('No retrieved evidence');
  for (const ref of evidence) {
    if (withdrawn.has(ref.evidenceId)) { unknown = true; reasons.push('withdrawn evidence'); continue; }
    if (ref.scope !== scope || !ref.allowedReaders.includes(evaluatorId)) { unknown = true; reasons.push('Evidence scope or reader mismatch'); continue; }
    if (ref.content.kind !== 'retrieved') { unknown = true; reasons.push(ref.content.kind); continue; }
    if (bodyDigest(ref.content.body) !== ref.content.digest) { unknown = true; reasons.push('Evidence body digest mismatch'); continue; }
    let body: JsonValue;
    try { const parsed: unknown = JSON.parse(ref.content.body); if (!v.json(parsed)) throw new Error('Not JSON'); body = parsed; }
    catch { unknown = true; reasons.push('Source is outside the structured synthetic checker'); continue; }
    const verdict = compare(body, rules.checks);
    if (verdict === 'fail') failed = true;
    if (verdict === 'inconclusive') { unknown = true; reasons.push('Source fields unavailable'); }
  }
  return { verdict: failed ? 'fail' : unknown ? 'inconclusive' : 'pass', limitation: reasons.length ? reasons.join('; ') : null };
}
