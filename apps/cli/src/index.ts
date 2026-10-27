import { pathToFileURL } from 'node:url';

export interface CliResponse {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(args: readonly string[]): CliResponse {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return {
      exitCode: 0,
      stdout: 'semevolve P0・機構未完了\nAT完了 0/34。実モデル接続なし。\n使い方: npm run start:cli -- --help\n',
      stderr: '',
    };
  }
  return { exitCode: 2, stdout: '', stderr: '指定されたコマンドは未実装です。--helpを参照してください。\n' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
