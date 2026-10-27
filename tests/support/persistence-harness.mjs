import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const resources = new WeakMap();
export function cleanup(t, action) {
  if (!resources.has(t)) {
    const actions = [];
    resources.set(t, actions);
    t.after(async () => { for (const dispose of actions.toReversed()) await dispose(); });
  }
  resources.get(t).push(action);
}

export async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'semevolve-persistence-'));
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function launch(t, script, args = []) {
  const child = fork(fileURLToPath(new URL(script, import.meta.url)), args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const messages = [];
  const waiters = new Set();
  child.on('message', message => {
    const waiter = [...waiters].find(item => item.predicate(message));
    if (waiter) { waiters.delete(waiter); waiter.resolve(message); }
    else messages.push(message);
  });
  const exit = once(child, 'exit');
  exit.then(([code, signal]) => {
    for (const waiter of waiters) waiter.reject(new Error(`Child exited ${code}/${signal}: ${stderr}`));
    waiters.clear();
  });
  cleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  function receive(predicate) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error(`Child already exited: ${stderr}`));
    return new Promise((resolve, reject) => waiters.add({ predicate, resolve, reject }));
  }
  let sequence = 0;
  function request(method, argument) {
    const id = ++sequence;
    const result = receive(message => message.id === id);
    child.send({ id, method, argument });
    return result.then(message => { if (message.failure) throw Error(message.failure); return message.value; });
  }
  return { child, receive, request, exit, async kill() { child.kill('SIGKILL'); return exit; } };
}

export async function writer(t, directory, boundary = '') {
  const process = launch(t, 'persistence-process.mjs', [directory, boundary]);
  const ready = await process.receive(message => message.type === 'ready' || message.type === 'open_failed');
  return { ...process, ready };
}

export async function concurrentClients(t, server, batches) {
  const clients = batches.map(() => launch(t, 'persistence-client.mjs'));
  const ready = await Promise.all(clients.map(client => client.receive(message => message.type === 'ready')));
  const results = clients.map(async client => {
    const request = await client.receive(message => message.type === 'request');
    const result = await server.request('transact', request.argument);
    client.child.send({ type: 'result', value: result });
    const received = await client.receive(message => message.type === 'result');
    await client.exit;
    return received.value;
  });
  clients.forEach((client, index) => client.child.send({ type: 'go', argument: batches[index] }));
  return { pids: ready.map(message => message.pid), results: await Promise.all(results) };
}
