import {
  digestJson, hostIdentity, isUtcTimestamp,
  type ContractError, type HostIdentity, type InvocationId, type JsonValue, type ReservationId, type Result,
  type StoreMutation, type StoreSnapshot, type TaskId, type TaskRecord, type TaskStore, type UtcTimestamp,
} from '@semevolve/core';
import type { Budget, BudgetRefusal, BudgetReservation, BudgetSnapshot, MeasuredTotal, Operation, PolicyGate, ReservationAmount, UsageSummary } from './contracts/policy.js';
import { integer, json, limits, metrics, nonempty, object, unknownUsage, validAmount, validOutcome, validReservation, validTask, validUsage } from './validation.js';

export const policyMutableCollections: readonly string[] = Object.freeze(['policy.tasks', 'policy.reservations']);
export interface PolicyTaskState {
  readonly task: TaskRecord;
  readonly noProgressSteps: number;
  readonly lastObservedAt: UtcTimestamp;
}
interface Start {
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly reservationId: ReservationId;
  readonly amount: ReservationAmount;
  readonly binding: JsonValue;
}
interface State {
  readonly snapshot: StoreSnapshot;
  readonly tasks: Map<string, PolicyTaskState>;
  readonly reservations: Map<string, BudgetReservation>;
  readonly starts: Map<string, Start>;
}
type ReserveRequest = Parameters<Budget['reserveAndStart']>[0];
type Settled = Exclude<BudgetReservation['outcome'], { readonly kind: 'pending' }>;
type Decision<T> = Result<T, ContractError | BudgetRefusal>;
type InvocationRequest = { readonly taskId: TaskId; readonly invocationId: InvocationId };
export interface PolicyExecution<Request extends InvocationRequest> {
  readonly request: Request;
  readonly reservationId: ReservationId;
  readonly amount: ReservationAmount;
  readonly operation: Operation;
  readonly gate: PolicyGate;
  readonly provider: {
    inspectCapabilities(): Promise<unknown>;
    invoke(request: Request, signal: AbortSignal): Promise<unknown>;
  };
}
export interface PolicyExecutionResult {
  readonly reservation: BudgetReservation;
  readonly invocation: 'started' | 'replayed';
  readonly output: string | null;
}
const invalid = (issue: string): { ok: false; error: ContractError } => ({ ok: false, error: { code: 'invalid_input', issues: [issue] } });
const unavailable = (reason: string): { ok: false; error: ContractError } => ({ ok: false, error: { code: 'unavailable', reason } });
const collision = (id: string): { ok: false; error: ContractError } => ({ ok: false, error: { code: 'id_collision', id } });
const refused = (reason: BudgetRefusal['reason']): { ok: false; error: BudgetRefusal } => ({ ok: false, error: { code: 'budget_refused', reason } });
const insert = (collection: string, id: string, value: unknown): StoreMutation => ({ kind: 'insert', entry: { key: { collection, id }, value: json(value) } });
const replace = (collection: string, id: string, previous: unknown, value: unknown): StoreMutation => ({ kind: 'replace', entry: { key: { collection, id }, value: json(value) }, expectedDigest: digestJson(previous) });

function readState(snapshot: StoreSnapshot): State {
  const tasks = new Map<string, PolicyTaskState>();
  const reservations = new Map<string, BudgetReservation>();
  const starts = new Map<string, Start>();
  for (const { key, value } of snapshot.entries) {
    if (key.collection === 'policy.tasks') {
      if (!object(value) || !validTask(value.task) || value.task.taskId !== key.id || !integer(value.noProgressSteps)
        || !isUtcTimestamp(value.lastObservedAt) || value.lastObservedAt < value.task.startedAt) throw new Error('Invalid persisted policy task');
      tasks.set(key.id, value as unknown as PolicyTaskState);
    } else if (key.collection === 'policy.reservations') {
      if (!validReservation(value) || value.reservationId !== key.id) throw new Error('Invalid persisted reservation');
      reservations.set(key.id, value);
    } else if (key.collection === 'policy.starts') {
      if (!object(value) || !nonempty(value.taskId) || !nonempty(value.invocationId) || value.invocationId !== key.id
        || !nonempty(value.reservationId) || !validAmount(value.amount) || !Object.hasOwn(value, 'binding')) throw new Error('Invalid persisted start');
      starts.set(key.id, value as unknown as Start);
    }
  }
  for (const reservation of reservations.values()) {
    const task = tasks.get(reservation.taskId);
    const start = starts.get(reservation.invocationId);
    if (!task || !start || start.reservationId !== reservation.reservationId || start.taskId !== reservation.taskId
      || digestJson(start.amount) !== digestJson(reservation.amount) || reservation.startedAt < task.task.startedAt
      || reservation.startedAt >= task.task.deadline) throw new Error('Reservation linkage mismatch');
  }
  if (starts.size !== reservations.size) throw new Error('Start linkage mismatch');
  return { snapshot, tasks, reservations, starts };
}

export function summariseUsage(reservations: readonly BudgetReservation[]): UsageSummary {
  const ids = new Set<string>();
  for (const r of reservations) {
    if (!validReservation(r) || ids.has(r.invocationId)) throw new TypeError('Invalid or duplicate invocation');
    ids.add(r.invocationId);
  }
  const total = (key: typeof metrics[number]): MeasuredTotal => {
    let knownSubtotal = 0;
    const missingInvocationIds: InvocationId[] = [];
    for (const r of reservations) {
      const value = r.outcome.kind === 'pending' ? null : r.outcome.usage[key];
      if (value === null) missingInvocationIds.push(r.invocationId);
      else knownSubtotal += value;
    }
    if (!Number.isFinite(knownSubtotal) || knownSubtotal > Number.MAX_SAFE_INTEGER) throw new TypeError('Usage total exceeds supported range');
    const [first, ...rest] = missingInvocationIds;
    return first === undefined ? { kind: 'complete', total: knownSubtotal }
      : { kind: 'partial', knownSubtotal, missingInvocationIds: [first, ...rest] };
  };
  const elapsedMs = reservations.reduce((sum, r) => sum + (r.outcome.kind === 'pending' ? 0 : r.outcome.usage.elapsedMs), 0);
  if (!Number.isFinite(elapsedMs) || elapsedMs > Number.MAX_SAFE_INTEGER) throw new TypeError('Elapsed total exceeds supported range');
  return { invocations: reservations.length, inputTokens: total('inputTokens'), outputTokens: total('outputTokens'),
    reasoningTokens: total('reasoningTokens'), costYen: total('costYen'), elapsedMs };
}

export class PolicyRuntime implements Budget {
  private readonly active = new Map<string, { taskId: TaskId; controller: AbortController }>();
  constructor(private readonly store: TaskStore, private readonly identity: HostIdentity) {}

  private now(): UtcTimestamp {
    const now = this.identity.now();
    if (!isUtcTimestamp(now)) throw new TypeError('Host clock is invalid');
    return now;
  }

  private async read(): Promise<Result<State>> {
    const snapshot = await this.store.snapshot();
    if (!snapshot.ok) return snapshot;
    try { return { ok: true, value: readState(snapshot.value) }; }
    catch { return unavailable('Persisted policy state is invalid; preserve and reconcile'); }
  }

  private commit(state: State, taskId: TaskId, kind: string, mutations: readonly StoreMutation[], data: JsonValue = null) {
    return this.store.transact({ transactionId: this.identity.newId('transaction'), expectedRevision: state.snapshot.revision,
      mutations, events: [{ eventId: this.identity.newId('event'), taskId, actor: 'host', kind, occurredAt: this.now(), data }] });
  }

  private view(state: State, taskId: TaskId): Result<BudgetSnapshot> {
    const current = state.tasks.get(taskId);
    if (!current) return invalid('Unknown task');
    const reservations = [...state.reservations.values()].filter(r => r.taskId === taskId);
    try {
      return { ok: true, value: { taskId, revision: state.snapshot.revision, limits: current.task.budget,
        startedAt: current.task.startedAt, deadline: current.task.deadline, reservations,
        usage: summariseUsage(reservations), cancellationRequestedAt: current.task.cancellationRequestedAt } };
    } catch { return unavailable('Usage total cannot be represented'); }
  }

  async snapshot(taskId: TaskId): Promise<Result<BudgetSnapshot>> {
    const state = await this.read();
    return state.ok ? this.view(state.value, taskId) : state;
  }

  async registerTask(input: TaskRecord): Promise<Result<PolicyTaskState>> {
    let task: TaskRecord;
    try {
      const clean: unknown = json(input);
      if (!validTask(clean)) return invalid('Invalid finite task');
      task = clean;
    } catch { return invalid('Invalid task JSON'); }
    const state = await this.read();
    if (!state.ok) return state;
    const previous = state.value.tasks.get(task.taskId);
    if (previous) return digestJson(previous.task) === digestJson(task) ? { ok: true, value: previous } : collision(task.taskId);
    if (task.revision !== 0 || task.cancellationRequestedAt !== null || task.stopReason !== null) return invalid('New task must start at revision zero');
    const now = this.now();
    if (now < task.startedAt) return invalid('Task starts after the host clock');
    const value: PolicyTaskState = { task, noProgressSteps: 0, lastObservedAt: now };
    const result = await this.commit(state.value, task.taskId, 'policy.task_registered', [insert('policy.tasks', task.taskId, value)]);
    return result.ok ? { ok: true, value } : result;
  }

  private stopped(current: PolicyTaskState, now: UtcTimestamp): BudgetRefusal['reason'] | null {
    if (current.task.cancellationRequestedAt !== null) return 'cancelled';
    if (current.task.stopReason !== null) return ['expired', 'no_progress'].includes(current.task.stopReason)
      ? current.task.stopReason as 'expired' | 'no_progress' : 'exhausted';
    if (now >= current.task.deadline || Date.parse(now) - Date.parse(current.task.startedAt) >= current.task.budget.maxElapsedMs) return 'expired';
    if (current.noProgressSteps >= current.task.budget.maxNoProgressSteps) return 'no_progress';
    return null;
  }

  private async stopBudget(state: State, current: PolicyTaskState, reason: BudgetRefusal['reason'], now: UtcTimestamp): Promise<{ ok: false; error: ContractError | BudgetRefusal }> {
    if (current.task.stopReason !== null) return refused(reason);
    const next = { ...current, lastObservedAt: now, task: { ...current.task, revision: current.task.revision + 1, stopReason: reason } };
    const saved = await this.commit(state, current.task.taskId, 'policy.budget_stopped',
      [replace('policy.tasks', current.task.taskId, current, next)], { reason });
    return saved.ok ? refused(reason) : saved;
  }

  private async reserve(request: ReserveRequest, binding: JsonValue): Promise<Decision<{ reservation: BudgetReservation; created: boolean }>> {
    let input: ReserveRequest;
    try {
      input = json(request) as unknown as ReserveRequest;
      if (!object(input) || ![input.taskId, input.invocationId, input.reservationId].every(nonempty)
        || !validAmount(input.amount) || !integer(input.expectedRevision)) return invalid('Invalid reservation request');
    } catch { return invalid('Invalid reservation JSON'); }
    const state = await this.read();
    if (!state.ok) return state;
    const start: Start = { taskId: input.taskId, invocationId: input.invocationId, reservationId: input.reservationId, amount: input.amount, binding };
    const existing = state.value.starts.get(input.invocationId);
    const previous = state.value.reservations.get(input.reservationId);
    if (existing || previous) {
      if (!existing || !previous || digestJson(existing) !== digestJson(start)) return collision(input.invocationId);
      return { ok: true, value: { reservation: previous, created: false } };
    }
    if (input.expectedRevision !== state.value.snapshot.revision) return { ok: false, error: { code: 'revision_conflict', expected: input.expectedRevision, actual: state.value.snapshot.revision } };
    const current = state.value.tasks.get(input.taskId);
    if (!current) return invalid('Unknown task');
    const now = this.now();
    if (now < current.lastObservedAt) return unavailable('Host clock moved backwards');
    const reason = this.stopped(current, now);
    if (reason) return this.stopBudget(state.value, current, reason, now);
    const reservations = [...state.value.reservations.values()].filter(r => r.taskId === input.taskId);
    if (reservations.length + 1 > current.task.budget.maxInvocations) return this.stopBudget(state.value, current, 'exhausted', now);
    for (const metric of metrics) {
      const cap = current.task.budget[limits[metric]];
      if (cap === null) continue;
      const upper = input.amount[metric];
      if (upper === null) return refused('unknown_upper_bound');
      let spent = upper;
      for (const reservation of reservations) {
        const charge = reservation.outcome.kind === 'completed' && reservation.outcome.usage.source === 'provider'
          ? reservation.outcome.usage[metric] : reservation.amount[metric];
        if (charge === null) return refused('unknown_upper_bound');
        spent += charge;
      }
      if (spent > cap) return this.stopBudget(state.value, current, 'exhausted', now);
    }
    const reservation: BudgetReservation = { reservationId: input.reservationId, taskId: input.taskId,
      invocationId: input.invocationId, amount: input.amount, reservedAt: now, startedAt: now, outcome: { kind: 'pending' } };
    const next = { ...current, lastObservedAt: now, task: { ...current.task, revision: current.task.revision + 1 } };
    const committed = await this.commit(state.value, input.taskId, 'policy.invocation_started', [
      insert('policy.reservations', input.reservationId, reservation), insert('policy.starts', input.invocationId, start),
      replace('policy.tasks', input.taskId, current, next),
    ], { invocationId: input.invocationId, reservationId: input.reservationId });
    return committed.ok ? { ok: true, value: { reservation, created: true } } : committed;
  }

  async reserveAndStart(request: ReserveRequest): Promise<Decision<BudgetReservation>> {
    const result = await this.reserve(request, null);
    return result.ok ? { ok: true, value: result.value.reservation } : result;
  }

  async settle(reservationId: ReservationId, input: Settled): Promise<Result<BudgetReservation>> {
    let outcome: Settled;
    try {
      const clean: unknown = json(input);
      if (!validOutcome(clean) || clean.kind === 'pending') return invalid('Invalid settlement');
      outcome = clean.kind === 'completed' && (metrics.some(key => clean.usage[key] === null) || clean.usage.source !== 'provider')
        ? { kind: 'unknown_outcome', reason: 'usage_not_fully_observed', usage: clean.usage } : clean;
    } catch { return invalid('Invalid settlement JSON'); }
    const observationId = digestJson({ reservationId, outcome });
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.read();
      if (!state.ok) return state;
      const previous = state.value.reservations.get(reservationId);
      if (!previous) return invalid('Unknown reservation');
      const observed = state.value.snapshot.entries.find(e => e.key.collection === 'policy.settlements' && e.key.id === observationId);
      if (observed || digestJson(previous.outcome) === digestJson(outcome)) return { ok: true, value: previous };
      if (previous.outcome.kind === 'completed') return collision(reservationId);
      if (previous.outcome.kind === 'unknown_outcome') {
        for (const key of metrics) {
          const known = previous.outcome.usage[key];
          if (known !== null && known !== outcome.usage[key]) return collision(reservationId);
        }
        if (outcome.usage.elapsedMs < previous.outcome.usage.elapsedMs) return collision(reservationId);
      }
      const next: BudgetReservation = { ...previous, outcome };
      const mutations: StoreMutation[] = [replace('policy.reservations', reservationId, previous, next),
        insert('policy.settlements', observationId, { reservationId, outcome })];
      const current = state.value.tasks.get(previous.taskId)!;
      if (metrics.some(key => previous.amount[key] !== null && outcome.usage[key] !== null && outcome.usage[key]! > previous.amount[key]!)) {
        mutations.push(replace('policy.tasks', previous.taskId, current,
          { ...current, task: { ...current.task, revision: current.task.revision + 1, stopReason: current.task.stopReason ?? 'upper_bound_exceeded' } }));
      }
      const committed = await this.commit(state.value, previous.taskId, 'policy.settled', mutations, { reservationId, observationId });
      if (committed.ok) return { ok: true, value: next };
      if (committed.error.code !== 'revision_conflict') return committed;
    }
    return unavailable('Settlement contention limit reached; reservation retained');
  }

  private async updateTask(taskId: TaskId, action: 'resume' | 'cancel' | 'progress' | 'no_progress'): Promise<Result<PolicyTaskState>> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.read();
      if (!state.ok) return state;
      const current = state.value.tasks.get(taskId);
      if (!current) return invalid('Unknown task');
      const now = this.now();
      if (now < current.lastObservedAt) return unavailable('Host clock moved backwards');
      const noProgressSteps = current.task.stopReason !== null ? current.noProgressSteps
        : action === 'progress' ? 0 : action === 'no_progress' ? current.noProgressSteps + 1 : current.noProgressSteps;
      const reason = current.task.stopReason ?? (action === 'cancel' ? 'cancelled' : this.stopped({ ...current, noProgressSteps }, now));
      const cancellationRequestedAt = current.task.cancellationRequestedAt ?? (action === 'cancel' ? now : null);
      if (current.noProgressSteps === noProgressSteps && current.task.stopReason === reason
        && current.task.cancellationRequestedAt === cancellationRequestedAt && current.lastObservedAt === now) return { ok: true, value: current };
      const next: PolicyTaskState = { task: { ...current.task, revision: current.task.revision + 1, stopReason: reason, cancellationRequestedAt }, noProgressSteps, lastObservedAt: now };
      const mutations: StoreMutation[] = [replace('policy.tasks', taskId, current, next)];
      if (reason || cancellationRequestedAt) {
        for (const previous of state.value.reservations.values()) {
          if (previous.taskId !== taskId || previous.outcome.kind !== 'pending') continue;
          const outcome: Settled = { kind: 'unknown_outcome', reason: reason ?? 'cancelled', usage: unknownUsage(0) };
          mutations.push(replace('policy.reservations', previous.reservationId, previous, { ...previous, outcome }));
        }
      }
      const committed = await this.commit(state.value, taskId, `policy.${action}`, mutations);
      if (committed.ok) {
        if (reason || cancellationRequestedAt) for (const active of this.active.values()) if (active.taskId === taskId) active.controller.abort(reason ?? 'cancelled');
        return { ok: true, value: next };
      }
      if (committed.error.code !== 'revision_conflict') return committed;
    }
    return unavailable('Task contention limit reached');
  }

  resume(taskId: TaskId): Promise<Result<PolicyTaskState>> { return this.updateTask(taskId, 'resume'); }
  noteProgress(taskId: TaskId, progressed: boolean): Promise<Result<PolicyTaskState>> {
    return typeof progressed === 'boolean' ? this.updateTask(taskId, progressed ? 'progress' : 'no_progress') : Promise.resolve(invalid('Progress must be boolean'));
  }
  async cancel(taskId: TaskId): Promise<Result<BudgetSnapshot>> {
    const updated = await this.updateTask(taskId, 'cancel');
    return updated.ok ? this.snapshot(taskId) : updated;
  }

  private async deny(taskId: TaskId, reason: string): Promise<{ ok: false; error: ContractError }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.read();
      if (!state.ok) return state;
      if (!state.value.tasks.has(taskId)) return invalid('Unknown task');
      const saved = await this.commit(state.value, taskId, 'policy.denied', [], { reason });
      if (saved.ok) return unavailable(reason);
      if (saved.error.code !== 'revision_conflict') return saved;
    }
    return unavailable('Denial audit contention limit reached');
  }

  async execute<Request extends InvocationRequest>(execution: PolicyExecution<Request>): Promise<Decision<PolicyExecutionResult>> {
    let request: Request;
    let operation: Operation;
    let reservationId: ReservationId;
    let amount: ReservationAmount;
    let inspect: PolicyExecution<Request>['provider']['inspectCapabilities'];
    let invoke: PolicyExecution<Request>['provider']['invoke'];
    let authorise: PolicyGate['authorise'];
    let binding: JsonValue;
    try {
      const input = json({ request: execution.request, operation: execution.operation,
        reservationId: execution.reservationId, amount: execution.amount }) as unknown as {
          request: Request; operation: Operation; reservationId: ReservationId; amount: ReservationAmount;
        };
      ({ request, operation, reservationId, amount } = input);
      if (!object(request) || !nonempty(request.taskId) || !nonempty(request.invocationId)
        || !object(operation) || operation.taskId !== request.taskId) return invalid('Execution task mismatch');
      const provider = execution.provider;
      const gate = execution.gate;
      inspect = provider.inspectCapabilities.bind(provider);
      invoke = provider.invoke.bind(provider);
      authorise = gate.authorise.bind(gate);
      binding = json({ request, operation });
    } catch { return invalid('Invalid execution JSON'); }
    let capabilities: unknown;
    try { capabilities = await inspect(); }
    catch { return this.deny(request.taskId, 'Capability inspection failed'); }
    if (!object(capabilities) || capabilities.provider !== 'fixed-fake' || capabilities.modelId !== 'synthetic-v1'
      || !['subscription', 'other'].includes(String(capabilities.authMode)) || capabilities.billingStatus !== 'disabled'
      || capabilities.evidenceStatus !== 'verified') return this.deny(request.taskId, 'Provider route is not verified for P0');
    let authorisation;
    try { authorisation = await authorise(json(operation) as unknown as Operation); }
    catch { return this.deny(request.taskId, 'Policy inspection failed'); }
    if (authorisation.allowed !== true || !integer(authorisation.policyRevision)) return this.deny(request.taskId, 'Operation is not authorised');
    const snapshot = await this.snapshot(request.taskId);
    if (!snapshot.ok) return snapshot;
    const reserved = await this.reserve({ taskId: request.taskId, invocationId: request.invocationId,
      reservationId, amount, expectedRevision: snapshot.value.revision }, binding);
    if (!reserved.ok) return reserved;
    if (!reserved.value.created) return { ok: true, value: { reservation: reserved.value.reservation, invocation: 'replayed', output: null } };
    const controller = new AbortController();
    this.active.set(request.invocationId, { taskId: request.taskId, controller });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => {};
    try {
      const latest = await this.read();
      if (!latest.ok) return latest;
      const current = latest.value.tasks.get(request.taskId)!;
      const now = this.now();
      const reason = now < current.lastObservedAt ? 'clock_uncertain' : this.stopped(current, now);
      if (reason) controller.abort(reason);
      const remaining = Date.parse(current.task.deadline) - Date.parse(now);
      const aborted = new Promise<unknown>(resolve => {
        const abort = () => resolve({ outcome: 'unknown_outcome', invocationId: request.invocationId,
          reason: String(controller.signal.reason ?? 'cancelled'), usage: unknownUsage(0) });
        removeAbort = () => controller.signal.removeEventListener('abort', abort);
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      if (!controller.signal.aborted) timer = setTimeout(() => controller.abort('expired'), Math.min(remaining, 2147483647));
      const invocation = controller.signal.aborted ? aborted : Promise.resolve().then(() => {
        if (controller.signal.aborted) return aborted;
        return invoke(json(request) as unknown as Request, controller.signal);
      }).catch(() => ({ outcome: 'unknown_outcome', invocationId: request.invocationId, reason: 'provider_response_lost', usage: unknownUsage(0) }));
      const result = await Promise.race([invocation, aborted]);
      let outcome: Settled;
      let output: string | null = null;
      if (!object(result) || result.invocationId !== request.invocationId || !validUsage(result.usage)
        || !['completed', 'unknown_outcome'].includes(String(result.outcome))
        || (result.outcome === 'completed' ? typeof result.output !== 'string' : !nonempty(result.reason))) {
        outcome = { kind: 'unknown_outcome', reason: 'invalid_provider_response', usage: unknownUsage(0) };
      } else if (result.outcome === 'completed') {
        outcome = { kind: 'completed', usage: result.usage };
        output = result.output as string;
      } else outcome = { kind: 'unknown_outcome', reason: result.reason as string, usage: result.usage };
      const settled = await this.settle(reserved.value.reservation.reservationId, outcome);
      return settled.ok ? { ok: true, value: { reservation: settled.value, invocation: 'started', output } } : settled;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
      this.active.delete(request.invocationId);
    }
  }
}

export function createPolicyRuntime(options: { readonly store: TaskStore; readonly identity?: HostIdentity }): PolicyRuntime {
  return new PolicyRuntime(options.store, options.identity ?? hostIdentity);
}
