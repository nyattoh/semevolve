import { createConnection } from 'node:net';

const socket = createConnection({ host: '127.0.0.1', port: Number(process.argv[2]) });
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', pid: process.pid }) + '\n'));
let buffer = '';
socket.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.type === 'ready') process.send({ ...message, pid: process.pid });
    else process.send({ ...message, pid: process.pid }, () => process.disconnect());
  }
});
process.on('message', message => {
  if (message.type === 'go') socket.write(JSON.stringify({ batch: message.argument }) + '\n');
});
