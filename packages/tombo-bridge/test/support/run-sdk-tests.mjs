import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareFixedSdk } from './prepare-sdk.mjs';

const runtime = await prepareFixedSdk();
const env = { SEMEVOLVE_TOMBO_RUNTIME: runtime };
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'RUNNER_TEMP', 'SEMEVOLVE_E_EVIDENCE_ROOT']) if (process.env[key] !== undefined) env[key] = process.env[key];
const tests = ['fixed-sdk.test.mjs', 'restart.test.mjs'].map(name => fileURLToPath(new URL(`../${name}`, import.meta.url)));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.signal) throw new Error(`SDK checks terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
