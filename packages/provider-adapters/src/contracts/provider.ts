import type { Envelope, EvidenceStatus, InvocationId, JsonValue, TaskId, Usage } from '@semevolve/core';

export interface ProviderCapabilities {
  readonly provider: string;
  readonly cliVersion: string | null;
  readonly modelId: string | null;
  readonly authMode: 'subscription' | 'api_key' | 'other' | 'unknown';
  readonly billingStatus: 'disabled' | 'possible' | 'unknown';
  readonly evidenceStatus: EvidenceStatus;
}

export interface PeerRequest {
  readonly invocationId: InvocationId;
  readonly taskId: TaskId;
  readonly envelope: Envelope;
  readonly permittedContext: JsonValue;
}

export type PeerResult =
  | { readonly outcome: 'completed'; readonly invocationId: InvocationId; readonly output: string; readonly usage: Usage }
  | { readonly outcome: 'unknown_outcome'; readonly invocationId: InvocationId; readonly reason: string; readonly usage: Usage };

export interface ProviderAdapter {
  inspectCapabilities(): Promise<ProviderCapabilities>;
  invoke(request: PeerRequest, signal: AbortSignal): Promise<PeerResult>;
}
