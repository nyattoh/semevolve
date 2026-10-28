import { inspectFileStoreOwner } from '@semevolve/core';
import { openComposedHost, envelope, epoch, taskId, take, observation } from './compose.mjs';

const options = JSON.parse(process.argv[3]);
let armed = false;
const host = await openComposedHost(process.argv[2], { ...options, storeOptions: { async onBoundary(point) {
  if (!armed || point !== 'journal_committed') return;
  armed = false;
  process.send({ event: 'boundary', point, pid: process.pid, owner: inspectFileStoreOwner(process.argv[2]) });
  await new Promise(() => {});
} } });

process.on('message', async ({ id, action, input = {} }) => {
  try {
    let result;
    switch (action) {
      case 'snapshot': result = await host.snapshot(); break;
      case 'budget': result = take(await host.policy.snapshot(taskId)); break;
      case 'count': result = host.provider.invocationCount; break;
      case 'receive': result = await host.receiver.receive(); break;
      case 'stage': result = await host.sender.stage(envelope(input)); break;
      case 'dispatch': result = await host.sender.dispatch(input.messageId ?? 'j1-message', 'peer-b'); break;
      case 'deliver': result = await host.deliver(envelope(input)); break;
      case 'apply': result = await host.receiver.apply('j1-message', { state: { output: input.output }, observation: observation() }); break;
      case 'deliverAndApply': result = await host.deliverAndApply(); break;
      case 'execute': result = await host.execute(envelope(input.envelope), input.invocationId ?? 'j1-invocation'); break;
      case 'cancel': result = await host.policy.cancel(taskId); break;
      case 'resume': result = await host.policy.resume(taskId); break;
      case 'time': host.clock.value = input.now; result = true; break;
      case 'epoch':
        host.transition.previousSendsClosed = true;
        host.transition.held = input.held ?? [];
        result = await host.registry.nextEpoch({ taskId, previousEpochId: 'j1-epoch', epoch: epoch('j1-epoch-2', 'j1-language', 1), expectedRevision: 1 });
        break;
      case 'armReservation': armed = true; result = true; break;
      case 'close':
        await host.close();
        process.send({ id, result: true }, () => process.exit(0));
        return;
      default: throw new Error('Unknown J1 process action');
    }
    process.send({ id, result });
  } catch (error) { process.send({ id, error: String(error) }); }
});
process.send({ event: 'ready', pid: process.pid });
