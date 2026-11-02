import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, prepareHub } from '../../../apps/cli/dist/hub.js';

export const participants = [
  { id: 'sender@canary', role: 'pm', connectionRef: 'conn-s', sessionRef: 'session-s', capabilities: ['local_cli'], languageVersions: ['synthetic-v1'] },
  { id: 'receiver@canary', role: 'worker', connectionRef: 'conn-r', sessionRef: 'session-r', capabilities: ['local_cli'], languageVersions: ['synthetic-v1'] },
  { id: 'other@canary', role: 'worker', connectionRef: 'conn-o', sessionRef: 'session-o', capabilities: ['local_cli'], languageVersions: ['synthetic-v1'] },
];
export function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
export function fixture(t) {
  const directory = join(mkdtempSync(join(tmpdir(), 'semevolve-m0-test-')), 'hub');
  const prepared = value(prepareHub({ directory, participants }));
  const options = prepared.contexts.map(c => ({ authorityPath: prepared.authorityPath, contextPath: c.path }));
  const hubs = options.map(o => value(createHub(o)));
  t.after(() => hubs.forEach(hub => hub.close()));
  return { prepared, options, hubs, sender: hubs[0], receiver: hubs[1], other: hubs[2] };
}

export function ready(t) {
  const f = fixture(t);
  f.hubs.forEach(h => value(h.join()));
  value(f.sender.importRecords([
    { kind: 'language', value: { id: 'synthetic-v1', definition: 'Synthetic transport canary only.', sourceRef: 'synthetic-source' } },
    { kind: 'run', value: { id: 'run-1', taskId: 'canary', condition: 'canary', languageVersion: 'synthetic-v1', actors: participants.map(p => p.id), modelSettings: null, rerunOf: null, formationRunId: null } },
  ]));
  return f;
}
export const message = { id: 'message-1', runId: 'run-1', languageVersion: 'synthetic-v1', recipients: ['receiver@canary', 'other@canary'], body: 'M0_SYNTHETIC_A', kind: 'canary' };
