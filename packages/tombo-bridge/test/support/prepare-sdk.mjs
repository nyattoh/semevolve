import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

export const fixedCommit = '585a1c711d55fdcc4b380343ceba2b3534165d5b';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = {
  LICENSE: 'dc3afed46930e83b61377d058c1d5a9855a7148901c4a60aee8484162bae87f9',
  'package.json': 'db2b9e3b652d506adcb60788bb2bc454e4992f365e55a76f4a17071bbdc75cc9',
  'package-lock.json': '15eea7df340bc47f7b516728924b18bd4a6cab114cdc4d9c9c347b308670180d',
  'tsconfig.json': '87a945be68f3fa7bcb55d88d624605e50b5dd19111816c7ad8dcbbaace8e558e',
  'skills/tombo-view/scripts/session.mjs': '2c21627466772e5816fa9ab1acf60dd480c50a2dabd555fff1a1cc80f8f04044',
  'skills/tombo-view/scripts/session-store.mjs': '51d845145e5eb6ab8911bc52299e4b7256e85414fba6012ee0fc3765eb857a3f',
};
const sourceTree = 'e116c91b8eecc2f4e0700d066bb91fc0a8cef61294e9241bdc4a3d4beae9b755';
function inside(root, path) { const suffix = relative(root, path); return suffix !== '' && !suffix.startsWith('..') && !isAbsolute(suffix); }
export async function verifyFixedRuntime(path) {
  const runtime = await realpath(path);
  for (const [name, hash] of Object.entries(entries)) assert.equal(digest(await readFile(join(runtime, name))), hash, `Fixed SDK source entry ${name}`);
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'Source tree must not contain symbolic links');
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else { assert.equal(entry.isFile(), true); files.push(`${name} ${digest(await readFile(join(directory, entry.name)))}`); }
    }
  }
  await walk(join(runtime, 'src'), 'src');
  assert.equal(digest(files.sort().join('\n')), sourceTree, 'Fixed SDK source tree');
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/zod'].version, '4.6.7');
  assert.equal(lock.packages['node_modules/zod'].license, 'MIT');
  assert.equal(lock.packages['node_modules/typescript'].version, '7.0.2');
  assert.equal(lock.packages['node_modules/typescript'].license, 'Apache-2.0');
  return runtime;
}
export async function prepareFixedSdk() {
  if (process.env.SEMEVOLVE_TOMBO_RUNTIME) return verifyFixedRuntime(process.env.SEMEVOLVE_TOMBO_RUNTIME);
  const tempRoot = await realpath(process.env.RUNNER_TEMP ?? tmpdir());
  const parent = await realpath(process.env.SEMEVOLVE_E_EVIDENCE_ROOT ?? tempRoot);
  assert.ok(parent === tempRoot || inside(tempRoot, parent) || inside(await realpath(tmpdir()), parent), 'SDK output must remain in TEMP');
  const area = await mkdtemp(join(parent, 'semevolve-sdk-runtime-'));
  const runtime = join(area, 'runtime');
  await mkdir(runtime);
  const archive = join(area, 'fixed-sdk.tar.gz');
  const response = await fetch(`https://codeload.github.com/nyattoh/tombo-view/tar.gz/${fixedCommit}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.ok, true, `Fixed SDK artifact HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length < 16 * 1024 * 1024, 'Bounded fixed source artifact');
  await writeFile(archive, bytes, { flag: 'wx' });
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  function run(executable, args, cwd = runtime) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { command: [executable, ...args], cwd, startedAt, finishedAt: new Date().toISOString(), exit: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
  }
  const listing = run('tar', ['-tzf', archive]);
  assert.equal(listing.exit, 0, JSON.stringify(listing));
  for (const name of listing.stdout.trim().split(/\r?\n/)) assert.ok(name.startsWith(`tombo-view-${fixedCommit}/`) && !name.split('/').includes('..') && !name.includes('\\'), 'Archive entry stays in fixed source root');
  const detail = run('tar', ['-tvzf', archive]);
  assert.equal(detail.exit, 0, JSON.stringify(detail));
  assert.equal(detail.stdout.split(/\r?\n/).some(line => /^[lh]/.test(line)), false, 'No archive links');
  const extraction = run('tar', ['-xzf', archive, '--strip-components=1', '-C', runtime]);
  assert.equal(extraction.exit, 0, JSON.stringify(extraction));
  await verifyFixedRuntime(runtime);
  const npmCli = process.env.npm_execpath ?? process.env.SEMEVOLVE_NPM_CLI;
  assert.ok(npmCli && isAbsolute(npmCli), 'Run the SDK test through its npm script to use the selected npm CLI');
  const npmVersion = run(process.execPath, [npmCli, '--version']);
  assert.equal(npmVersion.exit, 0); assert.equal(npmVersion.stdout.trim(), '10.9.4');
  const installation = run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  await writeFile(join(area, 'installation.json'), JSON.stringify(installation, null, 2), { flag: 'wx' });
  assert.equal(installation.exit, 0, JSON.stringify(installation));
  const build = run(process.execPath, [join(runtime, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
  await writeFile(join(area, 'build.json'), JSON.stringify(build, null, 2), { flag: 'wx' });
  assert.equal(build.exit, 0, JSON.stringify(build));
  await verifyFixedRuntime(runtime);
  await writeFile(join(area, 'provenance.json'), JSON.stringify({ repository: 'https://github.com/nyattoh/tombo-view', fixedCommit, licence: 'MIT', entries, sourceTree, archiveHash: digest(bytes), node: process.version, os: process.platform, npm: npmVersion.stdout.trim(), upstreamSourceCommitted: false }, null, 2), { flag: 'wx' });
  return runtime;
}
