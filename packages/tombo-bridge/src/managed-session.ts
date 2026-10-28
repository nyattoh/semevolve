import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { digestJson } from '@semevolve/core';
import type { JsonObject, JsonValue } from '@semevolve/core';
import type { TomboInspectionInput } from './contracts/tombo.js';
import type { ManagedSessionPort } from './runtime.js';
import * as v from './validation.js';
import { mapEvidence } from './mapping.js';
import type { EvidenceMetadata } from './mapping.js';
import type { PendingTomboUpdate } from './contracts/tombo.js';

const execute = promisify(execFile);
const helperName = 'skills/tombo-view/scripts/session.mjs';
const pins = {
  LICENSE: 'dc3afed46930e83b61377d058c1d5a9855a7148901c4a60aee8484162bae87f9',
  'package-lock.json': '15eea7df340bc47f7b516728924b18bd4a6cab114cdc4d9c9c347b308670180d',
  'skills/tombo-view/scripts/session.mjs': '2c21627466772e5816fa9ab1acf60dd480c50a2dabd555fff1a1cc80f8f04044',
  'skills/tombo-view/scripts/session-store.mjs': '51d845145e5eb6ab8911bc52299e4b7256e85414fba6012ee0fc3765eb857a3f',
} as const;
export interface ManagedSessionOptions {
  readonly runtimeRoot: string;
  readonly taskDirectory: string;
  readonly allowedTaskRoot: string;
  readonly task: JsonValue;
  readonly taskClock: JsonValue;
  readonly readerId: string;
  readonly evidenceMetadata: readonly EvidenceMetadata[];
  readonly propose: (operation: 'inspect' | 'update', context: JsonValue) => JsonValue;
  readonly reflect?: (context: JsonValue) => JsonValue;
  readonly timeoutMs?: number;
}
export interface ManagedSessionRuntime extends ManagedSessionPort {
  invalidate(evidenceIds: readonly string[], reason: string): Promise<unknown>;
  reflect(): Promise<unknown>;
}
function inside(root: string, target: string): boolean { const path = relative(root, target); return path.length > 0 && !path.startsWith('..') && !isAbsolute(path); }
export async function createManagedSession(options: ManagedSessionOptions): Promise<ManagedSessionRuntime> {
  const runtime = await realpath(options.runtimeRoot);
  const directory = await realpath(options.taskDirectory);
  const allowed = await realpath(options.allowedTaskRoot);
  const tempRoots = await Promise.all([tmpdir(), ...(process.env.RUNNER_TEMP ? [process.env.RUNNER_TEMP] : [])].map(path => realpath(path)));
  if (!tempRoots.some(root => root === allowed || inside(root, allowed)) || !inside(allowed, directory) || relative(runtime, directory) === '' || inside(runtime, directory) || inside(directory, runtime)) throw new Error('Managed sessions require a separate dedicated temporary task directory');
  if (resolve(options.taskDirectory).toLowerCase() !== directory.toLowerCase()) throw new Error('Task directory must use its canonical path');
  for (let path = dirname(directory); ; path = dirname(path)) {
    if (['tombo-session.jsonl', 'tombo-session.json', 'tombo-session.jsonl.lock'].some(name => existsSync(join(path, '.session', name)))) throw new Error('An ancestor already owns a TOMBO session');
    if (dirname(path) === path) break;
  }
  for (const [name, expected] of Object.entries(pins)) {
    const actual = createHash('sha256').update(await readFile(join(runtime, name))).digest('hex');
    if (actual !== expected) throw new Error(`Fixed SDK provenance mismatch: ${name}`);
  }
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Invalid helper timeout');
  const task = v.serialise(options.task), clock = v.serialise(options.taskClock);
  if (!v.record(task) || !v.text(task.taskId) || task.reflectionRequired !== true) throw new Error('Invalid fixed task packet');
  const packetBase: JsonObject = task;
  const taskId = task.taskId;
  const marker = join(directory, '.bridge-binding.json');
  const metadata = structuredClone(options.evidenceMetadata);
  const readerId = options.readerId;
  const configuration = { schema: 1, task, clock, readerId, metadata, sdkCommit: '585a1c711d55fdcc4b380343ceba2b3534165d5b' };
  if (existsSync(marker)) {
    if (!v.same(JSON.parse(await readFile(marker, 'utf8')), configuration)) throw new Error('Task configuration changed on restart');
  } else {
    if (existsSync(join(directory, '.session'))) throw new Error('Cannot adopt an existing unmanaged session');
    await writeFile(marker, JSON.stringify(configuration), { flag: 'wx' });
  }
  await mkdir(join(directory, '.session'), { recursive: true });
  await mkdir(join(directory, 'command-evidence'), { recursive: true });
  const env: NodeJS.ProcessEnv = { TOMBO_ROOT: runtime };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  async function command(args: string[], allowAbsent = false): Promise<JsonValue | null> {
    const startedAt = new Date().toISOString();
    let stdout = '', stderr = '', exit: number | string = 0;
    try { const result = await execute(process.execPath, [join(runtime, helperName), ...args], { cwd: directory, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }); stdout = result.stdout; stderr = result.stderr; }
    catch (error) {
      const result = error as { stdout?: string; stderr?: string; code?: number | string };
      stdout = result.stdout ?? ''; stderr = result.stderr ?? ''; exit = result.code ?? 'unknown';
    }
    await writeFile(join(directory, 'command-evidence', `${randomUUID()}.json`), JSON.stringify({ command: [process.execPath, join(runtime, helperName), ...args], cwd: directory, node: process.version, os: process.platform, startedAt, finishedAt: new Date().toISOString(), exit, stdout, stderr, cost_usd: null }), { flag: 'wx' });
    if (exit !== 0) {
      if (allowAbsent) {
        let failure: unknown; try { failure = JSON.parse(stderr); } catch { failure = null; }
        if (v.record(failure) && v.record(failure.error) && failure.error.code === 'invalid_input' && failure.error.message === 'Activate this workspace before status, receive or transition.' && !existsSync(join(directory, '.session/tombo-session.jsonl'))) return null;
      }
      throw new Error(`Fixed SDK helper failed (${String(exit)}): ${stderr.slice(0, 512)}`);
    }
    const result: unknown = JSON.parse(stdout);
    if (!v.json(result)) throw new Error('Non-JSON management response');
    return result;
  }
  async function saved(name: string, data: JsonValue): Promise<string> {
    const path = `.session/${name}-${randomUUID()}.json`;
    await writeFile(join(directory, path), JSON.stringify(data), { flag: 'wx' });
    return path;
  }
  async function inspect(input: TomboInspectionInput): Promise<unknown> {
    if (input.taskId !== taskId) throw new Error('Task mismatch');
    const status = await command(['status'], true);
    if (status !== null) throw new Error('Inspect cannot reset an existing session');
    const packet = { ...packetBase, evidence: mapEvidence(input.evidence, metadata, readerId), proposedAnswer: JSON.stringify({ transmissionContract: input.transmissionContract, interpretation: input.interpretation, proposedAction: input.proposedAction, contextRevision: input.contextRevision,
      unresolvedSources: input.evidence.filter(e => e.content.kind !== 'retrieved').map(e => ({ evidenceId: e.evidenceId, source: e.source, content: e.content })) }) };
    const taskPath = await saved('task', packet);
    const clockPath = await saved('task-clock', clock);
    await command(['activate', '--input', taskPath, '--ledger', '.session/sdk.jsonl', '--out', '.session/state.json', '--task-clock', clockPath]);
    const context = await command(['prepare', '--input', taskPath, '--ledger', '.session/sdk.jsonl']);
    if (!v.record(context) || !v.record(context.binding)) throw new Error('Preparation is blocked');
    const proposal = options.propose('inspect', structuredClone(context));
    const proposalPath = await saved('proposal', { binding: context.binding, proposal });
    return command(['inspect', '--input', taskPath, '--proposal', proposalPath, '--ledger', '.session/sdk.jsonl', '--out', '.session/state.json']);
  }
  async function reflect(): Promise<unknown> {
    if (!options.reflect) return command(['status']);
    const context = await command(['prepare', '--operation', 'reflect', '--state', '.session/state.json', '--ledger', '.session/sdk.jsonl']);
    if (!v.record(context) || !v.record(context.binding)) return context;
    const reflection = options.reflect(structuredClone(context));
    const path = await saved('reflection', { binding: context.binding, reflection });
    return command(['reflect', '--state', '.session/state.json', '--proposal', path, '--ledger', '.session/sdk.jsonl', '--out', '.session/state.json']);
  }
  async function receive(update: PendingTomboUpdate): Promise<unknown> {
    if (update.taskId !== taskId || !v.update(update)) throw new Error('Invalid managed receipt');
    const path = await saved('receipt', update.payload);
    return command(['receive', '--input', path]);
  }
  async function apply(update: PendingTomboUpdate): Promise<unknown> {
    if (update.taskId !== taskId || !v.update(update)) throw new Error('Invalid managed application');
    const actual = await command(['status']);
    if (!v.management(actual) || actual.session.binding.sessionId !== update.expected.sessionRef || actual.session.accountingUncertain || actual.session.pendingOperation !== null) throw new Error('Managed application authority is unavailable');
    const applied = actual.state.appliedExecutions.find(e => e.executionId === update.executionId);
    if (applied) {
      if (applied.payloadHash !== digestJson(update.payload.observations[0])) throw new Error('Applied execution collision');
      return actual;
    }
    const observations = await saved('observations', update.payload.observations);
    const context = await command(['prepare', '--state', '.session/state.json', '--observations', observations, '--receipt', update.executionId, '--ledger', '.session/sdk.jsonl']);
    if (!v.record(context) || !v.record(context.binding)) return context;
    const proposal = options.propose('update', structuredClone(context));
    const path = await saved('update-proposal', { binding: context.binding, proposal });
    let result = await command(['update', '--state', '.session/state.json', '--observations', observations, '--receipt', update.executionId, '--proposal', path, '--ledger', '.session/sdk.jsonl', '--out', '.session/state.json']);
    if (v.record(result) && v.record(result.understandingStatus) && ['missing', 'stale'].includes(String(result.understandingStatus.reflectionStatus)) && v.record(result.session)
      && result.session.accountingUncertain === false && v.record(result.state) && !result.state.stopReason && (!Array.isArray(result.state.pendingAssessmentExecutionIds) || result.state.pendingAssessmentExecutionIds.length === 0) && options.reflect) result = v.serialise(await reflect());
    return result;
  }
  return { inspect, receive, apply, reflect,
    async status(requestedTaskId) { if (requestedTaskId !== taskId) throw new Error('Task mismatch'); return command(['status']); },
    async invalidate(evidenceIds, reason) {
      const path = await saved('invalidation', { evidenceIds: [...evidenceIds], reason });
      return command(['invalidate', '--state', '.session/state.json', '--input', path, '--ledger', '.session/sdk.jsonl', '--out', '.session/state.json']);
    },
  };
}
