import type { BudgetLimits, InvocationId, ReservationId, Result, TaskId, Usage, UtcTimestamp } from '@semevolve/core';

export interface Operation {
  readonly taskId: TaskId;
  readonly name: string;
  readonly target: string;
}
export type Authorisation =
  | { readonly allowed: true; readonly policyRevision: number }
  | { readonly allowed: false; readonly reason: string };

export interface PolicyGate {
  authorise(operation: Operation): Promise<Authorisation>;
}

export interface ReservationAmount {
  readonly invocations: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costYen: number | null;
}

export interface BudgetReservation {
  readonly reservationId: ReservationId;
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly amount: ReservationAmount;
  readonly reservedAt: UtcTimestamp;
  readonly startedAt: UtcTimestamp;
  readonly outcome:
    | { readonly kind: 'pending' }
    | { readonly kind: 'unknown_outcome'; readonly reason: string; readonly usage: Usage }
    | { readonly kind: 'completed'; readonly usage: Usage };
}

export type MeasuredTotal =
  | {
    readonly kind: 'complete';
    readonly total: number;
    readonly missingInvocationIds?: never;
  }
  | {
    readonly kind: 'partial';
    readonly knownSubtotal: number;
    readonly missingInvocationIds: readonly [InvocationId, ...InvocationId[]];
    readonly total?: never;
  };
export interface UsageSummary {
  readonly invocations: number;
  readonly inputTokens: MeasuredTotal;
  readonly outputTokens: MeasuredTotal;
  readonly reasoningTokens: MeasuredTotal;
  readonly costYen: MeasuredTotal;
  readonly elapsedMs: number;
}

export interface BudgetSnapshot {
  readonly taskId: TaskId;
  readonly revision: number;
  readonly limits: BudgetLimits;
  readonly startedAt: UtcTimestamp;
  readonly deadline: UtcTimestamp;
  readonly reservations: readonly BudgetReservation[];
  readonly usage: UsageSummary;
  readonly cancellationRequestedAt: UtcTimestamp | null;
}

export type BudgetRefusal = { readonly code: 'budget_refused'; readonly reason: 'exhausted' | 'expired' | 'cancelled' | 'unknown_upper_bound' | 'no_progress' };

export interface Budget {
  snapshot(taskId: TaskId): Promise<Result<BudgetSnapshot>>;
  reserveAndStart(request: {
    readonly taskId: TaskId;
    readonly invocationId: InvocationId;
    readonly reservationId: ReservationId;
    readonly amount: ReservationAmount;
    readonly expectedRevision: number;
  }): Promise<Result<BudgetReservation, import('@semevolve/core').ContractError | BudgetRefusal>>;
  settle(reservationId: ReservationId, outcome: Exclude<BudgetReservation['outcome'], { readonly kind: 'pending' }>): Promise<Result<BudgetReservation>>;
  cancel(taskId: TaskId): Promise<Result<BudgetSnapshot>>;
}
