import { hostIdentity } from '@semevolve/core';
import type { JsonValue, Result, TaskId, TaskStore } from '@semevolve/core';
import { invalid, ok, records, unavailable } from './records.js';
import * as v from './validation.js';

export interface RoleDocument { readonly id: string; readonly body: JsonValue; readonly readers: readonly string[]; readonly evaluatorOnly: boolean }
export interface RoleBoundaryOptions {
  readonly taskId: TaskId;
  readonly store: TaskStore;
  readonly documents: readonly RoleDocument[];
  readonly tools: Readonly<Record<string, readonly string[]>>;
  readonly isolation: { readonly verdict: 'pass' | 'fail' | 'unverified'; readonly evidence: string | null };
}
export interface RoleBoundary {
  read(role: string, tool: string, documentId: string): Promise<Result<JsonValue>>;
  exportInput(role: string): Promise<Result<JsonValue>>;
  requireFormalBlind(): Promise<Result<void>>;
}
export function createRoleBoundary(options: RoleBoundaryOptions): RoleBoundary {
  const documents = structuredClone(options.documents);
  const tools = structuredClone(options.tools);
  const isolation = structuredClone(options.isolation);
  if (documents.some(d => !/^[a-z0-9-]+$/.test(d.id) || !v.json(d.body) || !v.strings(d.readers) || typeof d.evaluatorOnly !== 'boolean')
    || new Set(documents.map(d => d.id)).size !== documents.length || !['pass', 'fail', 'unverified'].includes(isolation.verdict)) throw new Error('Invalid role boundary configuration');
  const log = records(options.store, hostIdentity, options.taskId, 8);
  async function record<T>(operation: string, role: string, result: Result<T>): Promise<Result<T>> {
    for (let i = 0; i < 8; i++) {
      const s = await options.store.snapshot(); if (!s.ok) return s;
      const saved = await log.append(s.value, [], 'evaluator.role_boundary', { operation, role, allowed: result.ok, isolation: v.serialise(isolation) });
      if (saved.ok) return result;
      if (saved.error.code !== 'revision_conflict') return saved;
    }
    return unavailable('Role audit has no progress');
  }
  return {
    async read(role, tool, documentId) {
      const source = documents.find(d => d.id === documentId);
      const allowed = /^[a-z0-9-]+$/.test(documentId) && Object.hasOwn(tools, role) && tools[role]?.includes(tool) && tool === 'read'
        && source?.readers.includes(role) && (!source.evaluatorOnly || role === 'evaluator');
      return record('read', role, allowed && source ? ok(structuredClone(source.body)) : invalid('Role, tool or document is outside the allow-list'));
    },
    async exportInput(role) {
      if (!Object.hasOwn(tools, role) || !tools[role]?.includes('read')) return record('export', role, invalid('Unknown role'));
      const visible = documents.filter(d => d.readers.includes(role) && (!d.evaluatorOnly || role === 'evaluator')).map(d => ({ id: d.id, body: structuredClone(d.body) }));
      return record('export', role, ok({ role, documents: visible }));
    },
    async requireFormalBlind() {
      const allowed = isolation.verdict === 'pass' && v.text(isolation.evidence);
      return record('formal_blind', 'host', allowed ? ok(undefined) : invalid(`Formal blind refused: OS isolation ${isolation.verdict}`));
    },
  };
}
