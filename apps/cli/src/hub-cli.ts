import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CliResponse } from './index.js';
import { createHub, prepareHub, tokenise } from './hub.js';
import { demand, HubError, keys, object, result } from './hub-store.js';
import type { Result } from './hub-store.js';

const commands = ['prepare', 'join', 'leave', 'send', 'inbox', 'ack', 'translate', 'import', 'inspect', 'record', 'measurements', 'record-readiness', 'check-m0', 'tokenise'];
function inputFile(path: string): unknown {
  demand(isAbsolute(path));
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new HubError('invalid_input', 'Input must be a readable JSON file.'); }
}
function execute(args: readonly string[]): Result<unknown> {
  if (args.length === 0 || args.length === 1 && args[0] === '--help') return {
    ok: true,
    value: {
      entrypoint: 'npm run start:hub --', commands,
      usage: '<command> --authority <absolute authority.json> --context <absolute context.json> [--input <absolute JSON file>]',
      prepare: 'prepare --input <absolute JSON file containing directory and participants>',
      tokenise: 'tokenise --input <absolute JSON file containing text>',
      inputRequired: ['prepare', 'send', 'ack', 'translate', 'import', 'record', 'measurements', 'record-readiness', 'tokenise'],
      limits: 'Local OS/session context only. No provider launch. Ack is receipt only. Translation stores provided text with meaning unverified. M0 readiness uses operator evidence.',
    },
  };
  const command = args[0];
  demand(command && commands.includes(command));
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    demand(flag && ['--authority', '--context', '--input'].includes(flag) && options[flag] === undefined && value && !value.startsWith('--'));
    options[flag] = value;
  }
  if (command === 'prepare' || command === 'tokenise') {
    demand(options['--input'] && Object.keys(options).length === 1);
    const input = inputFile(options['--input']);
    if (command === 'prepare') return prepareHub(input);
    const request = object(input);
    keys(request, ['text']);
    return tokenise(request.text);
  }
  demand(options['--authority'] && options['--context']);
  const noInput = ['leave', 'inspect', 'check-m0'].includes(command);
  const optionalInput = command === 'join' || command === 'inbox';
  demand(!noInput || options['--input'] === undefined);
  demand(noInput || optionalInput || options['--input']);
  const input = options['--input'] ? inputFile(options['--input']) : {};
  const opened = createHub({ authorityPath: options['--authority'], contextPath: options['--context'] });
  if (!opened.ok) return opened;
  const hub = opened.value;
  try {
    switch (command) {
      case 'join': return hub.join(input);
      case 'leave': return hub.leave();
      case 'send': return hub.send(input);
      case 'inbox': return hub.inbox(input);
      case 'ack': return hub.ack(input);
      case 'translate': return hub.translate(input);
      case 'import': return hub.importRecords(input);
      case 'inspect': return hub.inspect();
      case 'record': return hub.recordMeasurement(input);
      case 'measurements': return hub.measurements(input);
      case 'record-readiness': return hub.recordReadiness(input);
      case 'check-m0': return hub.checkM0();
      default: throw new HubError('invalid_input', 'Unknown hub command.');
    }
  } finally { hub.close(); }
}

export function runHubCli(args: readonly string[]): CliResponse {
  const attempt = result(() => execute(args));
  const outcome = attempt.ok ? attempt.value : attempt;
  return { exitCode: outcome.ok ? 0 : 2, stdout: JSON.stringify(outcome) + '\n', stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const response = runHubCli(process.argv.slice(2));
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.exitCode;
}
