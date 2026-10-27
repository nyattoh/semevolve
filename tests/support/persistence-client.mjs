process.on('message', message => {
  if (message.type === 'go') process.send({ type: 'request', argument: message.argument, pid: process.pid });
  if (message.type === 'result') process.send({ type: 'result', value: message.value, pid: process.pid }, () => process.disconnect());
});
process.send({ type: 'ready', pid: process.pid });
