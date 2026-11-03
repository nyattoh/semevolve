import { createRequire } from 'node:module';
import { actorId, demand, identifier, keys, object, string } from './hub-store.js';
import { nullableId, number } from './hub-data.js';
import type { Run } from './hub-data.js';

export const tokenizer = {
  name: 'gpt-tokenizer', version: '4.1.0', encoding: 'cl100k_base',
  normalisation: 'none', specialTokens: 'ordinary_text', chatOverhead: false, providerBillingTokens: false,
} as const;
const require = createRequire(import.meta.url);
export function encodeWith(input: unknown, dependency: unknown): number[] {
  const text = string(input, true);
  demand(dependency !== null && typeof dependency === 'object' && 'encode' in dependency && typeof dependency.encode === 'function', 'tokenizer_contract');
  const encoded: unknown = Reflect.apply(dependency.encode, dependency, [text, { disallowedSpecial: new Set<string>() }]);
  demand(Array.isArray(encoded), 'tokenizer_contract');
  const tokenIds: number[] = [];
  for (const token of encoded) {
    demand(typeof token === 'number' && Number.isSafeInteger(token) && token >= 0, 'tokenizer_contract');
    tokenIds.push(token);
  }
  return tokenIds;
}
export function encodeText(input: unknown) {
  const dependency: unknown = require('gpt-tokenizer/encoding/cl100k_base');
  const tokenIds = encodeWith(input, dependency);
  return { tokenizer, tokenIds, tokens: tokenIds.length };
}
export const phases = ['v0_formation', 'task', 'revision', 'human_translation', 'paste_waiting'] as const;
export type Phase = typeof phases[number];
export interface Measurement {
  runId: string; eventId: string; occurrenceId: string; actorId: string; languageVersion: string;
  messageId: string | null; recipientId: string | null; phase: Phase; direction: 'input' | 'output' | 'none';
  category: string; text: string | null; textRef: string | null; tokenizerRef: string; tokens: number | null;
  providerUsage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
  startedAt: string | null; endedAt: string | null;
  actualCost: { amount: number; currency: string } | null; sourceRef: string;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const text = string(value);
  demand(Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text);
  return text;
}
function count(value: unknown): number | null {
  if (value === null) return null;
  const n = number(value);
  demand(Number.isSafeInteger(n));
  return n;
}
export function measurement(input: unknown, actor: string, languageVersion: string): Measurement {
  const v = object(input);
  keys(v, ['runId', 'eventId', 'occurrenceId', 'messageId', 'recipientId', 'phase', 'direction', 'category', 'text', 'textRef', 'providerUsage', 'startedAt', 'endedAt', 'actualCost', 'sourceRef']);
  demand(phases.includes(v.phase as Phase));
  demand(v.direction === 'input' || v.direction === 'output' || v.direction === 'none');
  const category = string(v.category);
  demand(['language_introduction', 'request', 'understanding', 'correction', 'result', 'mismatch', 'translation', 'waiting', 'canary'].includes(category));
  demand(v.phase !== 'paste_waiting' || (category === 'waiting' && v.direction === 'none' && v.text === null));
  demand(v.phase !== 'human_translation' || category === 'translation');
  demand(category !== 'waiting' || v.phase === 'paste_waiting');
  demand(category !== 'translation' || v.phase === 'human_translation');
  const text = v.text === null ? null : string(v.text, true);
  const textRef = nullableId(v.textRef);
  demand(text === null || textRef !== null);
  const startedAt = timestamp(v.startedAt);
  const endedAt = timestamp(v.endedAt);
  demand(startedAt === null || endedAt === null || Date.parse(endedAt) >= Date.parse(startedAt));
  let providerUsage: Measurement['providerUsage'] = null;
  if (v.providerUsage !== null) {
    const usage = object(v.providerUsage);
    keys(usage, ['inputTokens', 'outputTokens', 'totalTokens']);
    providerUsage = { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), totalTokens: count(usage.totalTokens) };
  }
  let actualCost: Measurement['actualCost'] = null;
  if (v.actualCost !== null) {
    const cost = object(v.actualCost);
    keys(cost, ['amount', 'currency']);
    actualCost = { amount: number(cost.amount), currency: string(cost.currency) };
  }
  return {
    runId: identifier(v.runId), eventId: identifier(v.eventId), occurrenceId: identifier(v.occurrenceId), actorId: actor, languageVersion,
    messageId: nullableId(v.messageId), recipientId: v.recipientId === null ? null : actorId(v.recipientId),
    phase: v.phase as Phase, direction: v.direction, category, text, textRef, tokenizerRef: 'gpt-tokenizer@4.1.0/cl100k_base/ordinary-text',
    tokens: text === null ? null : encodeText(text).tokens, providerUsage, startedAt, endedAt, actualCost, sourceRef: identifier(v.sourceRef),
  };
}

type Interval = [number, number];
function intervals(events: Measurement[]): Interval[] {
  return events.flatMap(e => e.startedAt === null || e.endedAt === null ? [] : [[Date.parse(e.startedAt), Date.parse(e.endedAt)] as Interval]);
}
function union(input: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const [start, end] of input.slice().sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged;
}
const duration = (input: Interval[]): number => union(input).reduce((sum, [start, end]) => sum + end - start, 0);
function elapsed(events: Measurement[]): number | null {
  if (!events.length || events.some(e => e.startedAt === null || e.endedAt === null)) return null;
  return duration(intervals(events));
}
function tokens(events: Measurement[]): number | null {
  if (!events.length || events.some(e => e.tokens === null)) return null;
  return events.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
}
export function summarise(events: Measurement[], formationRunIds: string[], requiredRuns: readonly Pick<Run, 'id' | 'condition'>[]) {
  const taskIds = requiredRuns.filter(r => r.condition !== 'formation').map(r => r.id);
  const formationIds = requiredRuns.filter(r => r.condition === 'formation').map(r => r.id);
  const covered = (ids: readonly string[], selected: Measurement[]): boolean => ids.every(id => selected.some(e => e.runId === id));
  const byPhase = Object.fromEntries(phases.map(phase => {
    const selected = events.filter(e => e.phase === phase);
    const complete = covered(phase === 'task' ? taskIds : phase === 'v0_formation' ? formationIds : [], selected);
    return [phase, { occurrences: selected.length, tokens: complete ? tokens(selected) : null, elapsedMs: complete ? elapsed(selected) : null, mismatches: selected.filter(e => e.category === 'mismatch').length }];
  }));
  const withoutFormation = events.filter(e => e.phase === 'task' || e.phase === 'revision');
  const withFormation = events.filter(e => e.phase === 'task' || e.phase === 'revision' || e.phase === 'v0_formation');
  const taskCovered = covered(taskIds, withoutFormation);
  const formationCovered = covered(formationIds, events.filter(e => e.phase === 'v0_formation'));
  const elapsedUnionMs = covered(requiredRuns.map(r => r.id), events) ? elapsed(events) : null;
  const waiting = union(intervals(events.filter(e => e.phase === 'paste_waiting')));
  const processing = union(intervals(events.filter(e => e.phase !== 'paste_waiting')));
  const overlap = processing.flatMap(([a, b]) => waiting.map(([c, d]) => [Math.max(a, c), Math.min(b, d)] as Interval).filter(([a, b]) => b > a));
  return {
    formationRunIds, phases: byPhase, elapsedUnionMs,
    processingMsWithoutPasteWaiting: elapsedUnionMs === null ? null : duration(processing) - duration(overlap),
    comparison: {
      tokensWithoutFormation: taskCovered ? tokens(withoutFormation) : null,
      tokensWithFormation: taskCovered && formationCovered ? tokens(withFormation) : null,
      elapsedMsWithoutFormation: taskCovered ? elapsed(withoutFormation) : null,
      elapsedMsWithFormation: taskCovered && formationCovered ? elapsed(withFormation) : null,
    },
  };
}
