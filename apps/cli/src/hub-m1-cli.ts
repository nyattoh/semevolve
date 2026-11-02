import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliResponse } from './index.js';
import { createHub } from './hub.js';
import { demand, HubError, result } from './hub-store.js';
import type { Result } from './hub-store.js';

export function runM1Cli(args: readonly string[]): CliResponse {
  const processRef = randomUUID();
  const origin = process.hrtime.bigint();
  const samples: { boundary: string; observedAt: string; monotonicMs: number; rssBytes: number; heapUsedBytes: number }[] = [];
  const sample = (boundary: string): void => {
    const usage = process.memoryUsage();
    samples.push({ boundary, observedAt: new Date().toISOString(), monotonicMs: Number(process.hrtime.bigint() - origin) / 1e6, rssBytes: usage.rss, heapUsedBytes: usage.heapUsed });
  };
  const attempt = result((): Result<unknown> => {
    if (args.length === 1 && args[0] === '--help') return { ok: true, value: {
      entrypoint: 'node apps/cli/dist/hub-m1-cli.js', commands: ['capture', 'report'],
      usage: '<command> --authority <absolute authority.json> --context <absolute context.json> --input <absolute JSON file>',
      limits: 'PM-only local capture. No provider launch. Raw boundary memory samples require a later explicit import.',
    } };
    const command = args[0];
    demand(command === 'capture' || command === 'report');
    const options: Record<string, string> = {};
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      demand(flag && ['--authority', '--context', '--input'].includes(flag) && options[flag] === undefined && value && isAbsolute(value));
      options[flag] = value;
    }
    demand(options['--authority'] && options['--context'] && options['--input']);
    let input: unknown;
    try { input = JSON.parse(readFileSync(options['--input'], 'utf8')); }
    catch { throw new HubError('invalid_input', 'Input must be a readable UTF-8 JSON file.'); }
    sample('before-open');
    const opened = createHub({ authorityPath: options['--authority'], contextPath: options['--context'] });
    if (!opened.ok) return opened;
    const hub = opened.value;
    sample('after-open');
    let outcome: Result<unknown>;
    try {
      outcome = command === 'capture' ? hub.captureM1(input) : hub.reportM1(input);
      sample('after-operation');
    } finally {
      sample('before-close');
      const closed = hub.close();
      demand(closed.ok, 'storage_error');
      sample('after-close');
    }
    return outcome;
  });
  const outcome = attempt.ok ? attempt.value : attempt;
  const localMemoryRaw = { target: 'm1-cli', samplingScheme: 'operation-boundaries', samplingIntervalMs: null, pid: process.pid, processRef, processStartRef: 'capture-process:' + processRef, nodeVersion: process.version, operation: args[0] ?? 'unknown', parentIncluded: false, childrenIncluded: false, sourceRef: 'm1-cli-raw:' + processRef, samples };
  return { exitCode: outcome.ok ? 0 : 2, stdout: JSON.stringify({ ...outcome, localMemoryRaw }) + '\n', stderr: '' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const response = runM1Cli(process.argv.slice(2));
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.exitCode;
}
