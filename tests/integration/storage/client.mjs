import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { inspectFileStoreOwner, recoverFileStoreOwner } from '@semevolve/core';

export async function start(t, directory, options = {}) {
  const child = fork(new URL('./process.mjs', import.meta.url), [directory, JSON.stringify(options)], { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 30000 });
  const pending = new Map(); let next = 0; let ready; let reached; let stderr = '';
  child.stdout.on('data', () => {}); child.stderr.on('data', d => { stderr += d; });
  const prepared = new Promise(resolve => { ready = resolve; });
  const boundary = new Promise(resolve => { reached = resolve; });
  const exited = once(child, 'exit');
  child.on('message', message => {
    if (message.event === 'ready') ready(message);
    else if (message.event === 'boundary') reached(message);
    else if (pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); if (message.error) reject(new Error(message.error)); else resolve(message.result); }
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  await Promise.race([prepared, exited.then(([code, signal]) => { throw new Error(`Storage process failed ${code}/${signal}: ${stderr}`); })]);
  const call = (action, input = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, action, input }); });
  t.diagnostic(JSON.stringify({ phase: 'ready', pid: child.pid, node: process.version, platform: process.platform }));
  return { child, call, boundary,
    async kill() { child.kill('SIGKILL'); const [code, signal] = await exited; assert.ok(signal !== null || code !== 0); t.diagnostic(JSON.stringify({ phase: 'killed', pid: child.pid, code, signal })); },
    async close() { assert.equal(await call('close'), true); const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null); },
  };
}
export function recoverDead(t, directory, pid) {
  const owner = inspectFileStoreOwner(directory); assert.equal(owner.pid, pid);
  recoverFileStoreOwner(directory, owner.token);
  t.diagnostic(JSON.stringify({ phase: 'dead-owner-recovered', pid, tokenDigestOnly: true }));
}
