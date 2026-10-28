import { createConnection } from 'node:net';
const [port, expectedRevision, client] = process.argv.slice(2);
const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
socket.setEncoding('utf8'); let buffer = '';
socket.on('connect', () => { socket.write(JSON.stringify({ client, pid: process.pid, input: { migrationId: 'migration-1', expectedRevision: Number(expectedRevision), authorisationRef: 'grant-switch' } }) + '\n'); process.send({ event: 'sent', client, pid: process.pid }); });
socket.on('data', chunk => { buffer += chunk; });
socket.on('end', () => { process.send({ event: 'result', client, pid: process.pid, result: JSON.parse(buffer) }, () => process.exit(0)); });
socket.on('error', error => { process.stderr.write(String(error)); process.exit(1); });
