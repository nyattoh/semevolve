import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManagedSession } from '@semevolve/tombo-bridge';
import { commit } from './fixture.mjs';

export const proposal = {
  claims: [{ id: 'public-factuality-claim', role: 'answer_claim', text: 'Synthetic source says X is the cause', scope: 'public-synthetic' }],
  lenses: [{ id: 'public-source-lens', label: 'Synthetic independent source', rationale: 'Compare the structured public source', origin: 'initial', status: 'active' }],
  gaps: [{ id: 'public-source-gap', kind: 'unsupported_claim', lensId: 'public-source-lens', question: 'Does the public source support X?', triggerRefs: ['public-factuality-claim'], whyItMatters: 'Separate factuality from transmission', importance: 'optional', claimIds: ['public-factuality-claim'], probeIds: ['public-probe'] }],
  probes: [{ id: 'public-probe', gapIds: ['public-source-gap'], method: 'counterexample', question: 'Read the synthetic source', requiredCapability: 'public-source-read', sourceGroups: ['public-synthetic-source'], successCondition: 'Source says X', refutationCondition: 'Source says Y', inconclusiveCondition: 'Source unavailable' }],
};
export async function sdkOptions(existing) {
  const runtimeRoot = process.env.SEMEVOLVE_TOMBO_RUNTIME;
  if (!runtimeRoot) throw new Error('Fixed SDK runtime required; real SDK checks cannot be skipped');
  const allowedTaskRoot = process.env.SEMEVOLVE_E_EVIDENCE_ROOT ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(allowedTaskRoot, { recursive: true });
  const taskDirectory = existing?.taskDirectory ?? await mkdtemp(join(allowedTaskRoot, 'semevolve-e-sdk-task-'));
  const now = existing?.startedAt ?? new Date().toISOString();
  const task = { schemaVersion: '0.1', taskId: 'public-task', goal: 'Synthetic fixed SDK bridge compatibility only', mode: 'explain', successCriteria: ['Track independent public observations without network inference'], evidence: [], reflectionRequired: true, capabilities: ['public-source-read'], budget: { maxRounds: 6, maxModelCalls: 12, maxToolCalls: 12, maxElapsedMs: 60000, maxInputChars: 1000000, maxOutputTokensPerCall: 4096 } };
  const options = { runtimeRoot, allowedTaskRoot, taskDirectory, task, readerId: 'evaluator', evidenceMetadata: [], taskClock: { startedAt: now, deadlineAt: new Date(Date.parse(now) + 60000).toISOString(), basis: 'first_observed', sourceRef: 'synthetic-test:initial-os-clock' }, propose(operation, context) {
    if (operation === 'inspect') return proposal;
    const evidence = context.request.observations.flatMap(o => o.evidence);
    return evidence.length ? { assessments: [{ claimId: 'public-factuality-claim', evidenceIds: evidence.map(e => e.id), verdict: 'refutes', scopeMatched: true, reason: 'Structured public source records Y instead of X' }] } : {};
  }, reflect(context) { return { binding: context.request.binding, reviewedClaimIds: context.request.state.claims.map(c => c.id), completion: 'completed', limitations: ['Public structured synthetic test; no natural language or hidden evaluation'], proposal: {} }; } };
  return { options, session: await createManagedSession(options), commit, taskDirectory, startedAt: now };
}
