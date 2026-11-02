import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { participants, ready, value, message } from './helpers.mjs';

const cli = resolve('apps/cli/dist/hub-cli.js');
function execute(args, expectedExit = 0) {
  const response = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(response.status, expectedExit, response.stderr + response.stdout);
  return JSON.parse(response.stdout);
}
function json(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const bound = (options, command, input) => [command, '--authority', options.authorityPath, '--context', options.contextPath, ...(input ? ['--input', input] : [])];

test('CLI prepares private contexts then joins, inspects and leaves with JSON stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'semevolve-cli-'));
  const file = json(dir, 'prepare.json', { directory: join(dir, 'hub'), participants });
  const prepared = value(execute(['prepare', '--input', file]));
  const options = { authorityPath: prepared.authorityPath, contextPath: prepared.contexts[0].path };
  assert.deepEqual(value(execute(bound(options, 'join'))), { actorId: 'sender@canary', state: 'joined' });
  assert.equal(value(execute(bound(options, 'inspect'))).identity.actorId, 'sender@canary');
  assert.deepEqual(value(execute(bound(options, 'leave'))), { actorId: 'sender@canary', state: 'left' });
  assert.equal(execute(bound(options, 'inbox'), 2).error.code, 'not_joined');
  assert.equal(existsSync(prepared.databasePath), true);
  const context = JSON.parse(readFileSync(options.contextPath, 'utf8'));
  assert.equal(JSON.stringify(prepared).includes(context.secret), false);
});

test('CLI send, reopen inbox, per-recipient ack and provided translation keep the original', t => {
  const f = ready(t);
  const dir = mkdtempSync(join(tmpdir(), 'semevolve-cli-messages-'));
  const sendFile = json(dir, 'send.json', message);
  assert.equal(value(execute(bound(f.options[0], 'send', sendFile))).body, 'M0_SYNTHETIC_A');
  assert.equal(value(execute(bound(f.options[0], 'send', sendFile))).body, 'M0_SYNTHETIC_A');
  assert.deepEqual(value(execute(bound(f.options[1], 'inbox'))).map(m => m.body), ['M0_SYNTHETIC_A']);
  const ackFile = json(dir, 'ack.json', { messageId: 'message-1' });
  assert.equal(value(execute(bound(f.options[1], 'ack', ackFile))).understanding, null);
  assert.deepEqual(value(execute(bound(f.options[1], 'inbox'))), []);
  assert.equal(value(execute(bound(f.options[2], 'inbox'))).length, 1);
  const translate = json(dir, 'translation.json', { id: 'cli-translation', sourceMessageId: 'message-1', runId: 'run-1', languageVersion: 'synthetic-v1', targetLanguage: 'ja', text: '合成CLI原文', sourceRef: 'synthetic-provided-text' });
  assert.equal(value(execute(bound(f.options[1], 'translate', translate)))[0].meaningVerified, false);
  assert.equal(value(execute(bound(f.options[0], 'inspect'))).messages[0].body, 'M0_SYNTHETIC_A');
});

test('CLI rejects spoofed recipient, malformed input and unknown arguments without writes', t => {
  const f = ready(t);
  value(f.sender.send(message));
  const dir = mkdtempSync(join(tmpdir(), 'semevolve-cli-reject-'));
  const spoof = json(dir, 'spoof.json', { recipientId: 'receiver@canary' });
  assert.equal(execute(bound(f.options[0], 'inbox', spoof), 2).error.code, 'unauthorised');
  const bad = json(dir, 'bad.json', { ...message, body: null });
  assert.equal(execute(bound(f.options[0], 'send', bad), 2).error.code, 'invalid_input');
  writeFileSync(bad, '{');
  assert.equal(execute(bound(f.options[0], 'send', bad), 2).error.code, 'invalid_input');
  assert.equal(execute(['inbox', '--as', 'receiver@canary'], 2).error.code, 'invalid_input');
  assert.equal(execute([...bound(f.options[0], 'inbox'), '--context', f.options[1].contextPath], 2).error.code, 'invalid_input');
  assert.equal(execute(bound(f.options[0], 'leave', spoof), 2).error.code, 'invalid_input');
  assert.deepEqual(value(f.receiver.inbox()).map(m => m.body), ['M0_SYNTHETIC_A']);
});

test('CLI tokenise, record, measurements and M0 check preserve usage and unknowns', t => {
  const f = ready(t);
  const dir = mkdtempSync(join(tmpdir(), 'semevolve-cli-measure-'));
  const text = json(dir, 'text.json', { text: '日本語' });
  assert.deepEqual(value(execute(['tokenise', '--input', text])).tokenIds, [9080, 22656, 45918, 252]);
  const event = json(dir, 'event.json', { runId: 'run-1', eventId: 'cli-event', occurrenceId: 'cli-occurrence', messageId: null, recipientId: null, phase: 'task', direction: 'output', category: 'request', text: '日本語', textRef: 'synthetic-text', providerUsage: null, startedAt: null, endedAt: null, actualCost: null, sourceRef: 'synthetic-observation' });
  assert.equal(value(execute(bound(f.options[0], 'record', event))).tokens, 4);
  assert.equal(value(execute(bound(f.options[0], 'record', event))).tokens, 4);
  const selection = json(dir, 'selection.json', { runIds: ['run-1'] });
  const report = value(execute(bound(f.options[0], 'measurements', selection)));
  assert.equal(report.events.length, 1);
  assert.equal(report.phases.task.elapsedMs, null);
  const check = value(execute(bound(f.options[0], 'check-m0')));
  assert.equal(check.M0ready, false);
  assert.equal(check.conditions[0].facts.grokModel, null);
});

test('CLI imports generic records and records evidence without running any task', t => {
  const f = ready(t);
  const dir = mkdtempSync(join(tmpdir(), 'semevolve-cli-import-'));
  const records = json(dir, 'import.json', [{ kind: 'language', value: { id: 'cli-synthetic', definition: 'CLI synthetic definition.', sourceRef: 'synthetic-text' } }]);
  assert.deepEqual(value(execute(bound(f.options[0], 'import', records))), { imported: 1 });
  const evidence = json(dir, 'readiness.json', { id: 'cli-evidence', condition: 'connection', facts: { grokModel: null }, evidenceRefs: [], fixtureIds: [], sourceRef: 'synthetic-unknown', observedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(value(execute(bound(f.options[0], 'record-readiness', evidence))).facts.grokModel, null);
  assert.equal(value(execute(bound(f.options[0], 'check-m0'))).M0ready, false);
  assert.equal(value(execute(bound(f.options[0], 'inspect'))).runs[0].status, 'prepared');
});

test('CLI help is JSON and lists the separate M0 entrypoint', () => {
  const help = value(execute(['--help']));
  assert.equal(help.entrypoint, 'npm run start:hub --');
  assert.deepEqual(help.commands, ['prepare', 'join', 'leave', 'send', 'inbox', 'ack', 'translate', 'import', 'inspect', 'record', 'measurements', 'record-readiness', 'check-m0', 'tokenise']);
  assert.equal(execute(['launch-agent'], 2).error.code, 'invalid_input');
});
