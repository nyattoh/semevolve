import * as core from '@semevolve/core';
import { createServer } from 'node:net';

const [directory, boundary] = process.argv.slice(2);
const trace = [];
const record = (type, details = {}) => trace.push({ sequence: trace.length + 1, type, ...details });
let armed = false;
let held = false;
let pending = 0;
let release;
function releaseOverlap() {
  if (held && pending === 2 && release) {
    record('released', { pending });
    const unblock = release;
    release = undefined;
    unblock();
  }
}
try {
  const store = await core.openFileTaskStore(directory, {
    mutableCollections: ['state'],
    onBoundary: async point => {
      if (armed && !held && point === 'journal_before_append') {
        held = true;
        record('held', { pending });
        await new Promise(resolve => { release = resolve; releaseOverlap(); });
      }
      if (point !== boundary) return;
      process.send({ type: 'boundary', point });
      await new Promise(() => {});
    },
  });
  let nextConnection = 0;
  const sockets = new Set();
  const listener = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    const connectionId = ++nextConnection;
    let pid;
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.type === 'hello') {
          pid = message.pid;
          socket.write(JSON.stringify({ type: 'ready', connectionId }) + '\n');
        } else {
          pending++;
          const result = store.transact(message.batch);
          record('invoked', { source: 'direct_client', pid, connectionId, pending });
          releaseOverlap();
          result.then(value => {
            record('settled', { source: 'direct_client', pid, connectionId });
            pending--;
            socket.end(JSON.stringify({ type: 'result', value }) + '\n');
          }, error => {
            pending--;
            socket.end(JSON.stringify({ type: 'failure', message: error.message }) + '\n');
          });
        }
      }
    });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  process.on('message', async request => {
    try {
      let value;
      if (request.method === 'transact') {
        record('invoked', { source: 'parent_ipc' });
        value = await store.transact(request.argument);
        record('settled', { source: 'parent_ipc' });
      }
      else if (request.method === 'arm') { trace.length = 0; armed = true; held = false; value = true; }
      else if (request.method === 'trace') value = trace;
      else if (request.method === 'snapshot') value = await store.snapshot();
      else if (request.method === 'checkpoint') value = await store.checkpoint();
      else if (request.method === 'backup') value = await store.backup(request.argument);
      else if (request.method === 'close') {
        await store.close();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => listener.close(resolve));
        process.send({ id: request.id, value: 'closed' }, () => process.disconnect());
        return;
      }
      else throw Error('Unknown test request');
      process.send({ id: request.id, value });
    } catch (error) { process.send({ id: request.id, failure: error.message }); }
  });
  process.send({ type: 'ready', pid: process.pid, port: listener.address().port, owner: core.inspectFileStoreOwner(directory) });
} catch (error) {
  process.send({ type: 'open_failed', failure: error.message }, () => process.disconnect());
  process.exitCode = 2;
}
