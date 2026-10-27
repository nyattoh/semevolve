import type { InvocationId, Usage } from '@semevolve/core';
import type { PeerRequest, PeerResult, ProviderAdapter, ProviderCapabilities } from './contracts/provider.js';

export type FakeScenario = 'success' | 'timeout' | 'delayed' | 'cancellation_unsupported' | 'response_lost';
export interface FixedFakeOptions {
  readonly scenario?: FakeScenario;
  readonly usage?: Usage;
  readonly capabilities?: Partial<ProviderCapabilities>;
}
export interface FixedFakeProvider extends ProviderAdapter {
  readonly invocationCount: number;
  readonly requests: readonly PeerRequest[];
  waitForInvocation(): Promise<void>;
  complete(invocationId: InvocationId): PeerResult;
}

export function createFixedFakeProvider(options: FixedFakeOptions = {}): FixedFakeProvider {
  const scenario = options.scenario ?? 'success';
  if (!['success', 'timeout', 'delayed', 'cancellation_unsupported', 'response_lost'].includes(scenario)) throw new TypeError('Invalid fake scenario');
  const usage: Usage = structuredClone(options.usage ?? { inputTokens: null, outputTokens: null, reasoningTokens: null,
    costYen: null, elapsedMs: 0, source: 'unavailable' });
  const capabilities: ProviderCapabilities = { provider: 'fixed-fake', cliVersion: null, modelId: 'synthetic-v1',
    authMode: 'other', billingStatus: 'disabled', evidenceStatus: 'verified', ...structuredClone(options.capabilities) };
  const requests: PeerRequest[] = [];
  const pending = new Map<string, (value: PeerResult) => void>();
  const waiters: (() => void)[] = [];
  const completed = (invocationId: InvocationId): PeerResult => ({ outcome: 'completed', invocationId, output: 'Public synthetic result', usage: structuredClone(usage) });
  const unknown = (invocationId: InvocationId, reason: string): PeerResult => ({ outcome: 'unknown_outcome', invocationId, reason,
    usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null, elapsedMs: 0, source: 'unavailable' } });
  return {
    get invocationCount() { return requests.length; },
    get requests() { return structuredClone(requests); },
    async inspectCapabilities() { return structuredClone(capabilities); },
    waitForInvocation() { return requests.length > 0 ? Promise.resolve() : new Promise(resolve => waiters.push(resolve)); },
    async invoke(request, signal) {
      if (signal.aborted) return unknown(request.invocationId, 'cancelled_before_start');
      requests.push(structuredClone(request));
      for (const resolve of waiters.splice(0)) resolve();
      if (scenario === 'success') return completed(request.invocationId);
      if (scenario === 'timeout') return unknown(request.invocationId, 'timeout');
      if (scenario === 'response_lost') throw new Error('Synthetic response loss');
      return new Promise(resolve => {
        const abort = () => {
          if (scenario === 'cancellation_unsupported') return;
          pending.delete(request.invocationId);
          resolve(unknown(request.invocationId, 'cancelled'));
        };
        pending.set(request.invocationId, result => { signal.removeEventListener('abort', abort); resolve(result); });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    complete(invocationId) {
      const resolve = pending.get(invocationId);
      if (!resolve) throw new Error('No delayed fake invocation');
      pending.delete(invocationId);
      const result = completed(invocationId);
      resolve(result);
      return result;
    },
  };
}
