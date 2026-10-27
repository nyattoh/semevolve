import { openFileTaskStore, hostIdentity } from '@semevolve/core';
import { createPolicyRuntime, policyMutableCollections } from '@semevolve/policy';
import { createFixedFakeProvider } from '@semevolve/provider-adapters';
import { createAllowListPolicyGate } from '@semevolve/policy';
import { amount, initialTime, request, task, usage } from '../../mechanism/policy/fixtures.mjs';

const directory = process.argv[2];
let now = initialTime;
let boundary = null;
const store = await openFileTaskStore(directory, { mutableCollections: policyMutableCollections,
  async onBoundary(point) {
    if (point !== boundary) return;
    process.send({ event: 'boundary', point });
    await new Promise(() => {});
  } });
const runtime = createPolicyRuntime({ store, identity: { ...hostIdentity, now: () => now } });
const gate = createAllowListPolicyGate({ policyRevision: 1,
  grants: [{ taskId: 'task-public', name: 'synthetic-read', target: 'public-fixture' }] });
let provider = createFixedFakeProvider({ usage });
process.on('message', async message => {
  const { id, action, input = {} } = message;
  try {
    let result;
    switch (action) {
      case 'register': result = await runtime.registerTask(task(input)); break;
      case 'time': now = input.now; result = now; break;
      case 'arm': boundary = input.boundary; result = boundary; break;
      case 'provider': provider = createFixedFakeProvider({ usage, ...input }); result = true; break;
      case 'run': result = await runtime.execute({ request: request(input.invocationId ?? 'invocation-public'),
        reservationId: input.reservationId ?? 'reservation-public', amount,
        operation: { taskId: 'task-public', name: 'synthetic-read', target: 'public-fixture' }, gate, provider }); break;
      case 'snapshot': result = await runtime.snapshot('task-public'); break;
      case 'resume': result = await runtime.resume('task-public'); break;
      case 'cancel': result = await runtime.cancel('task-public'); break;
      case 'progress': result = await runtime.noteProgress('task-public', input.progressed); break;
      case 'settle': result = await runtime.settle(input.reservationId ?? 'reservation-public', input.outcome); break;
      case 'count': result = provider.invocationCount; break;
      case 'close': await store.close(); process.send({ id, result: true }, () => process.exit(0)); return;
      default: throw new Error('Unknown process test action');
    }
    process.send({ id, result });
  } catch (error) { process.send({ id, error: String(error) }); }
});
process.send({ event: 'ready', pid: process.pid });
