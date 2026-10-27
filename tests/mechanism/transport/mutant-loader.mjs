export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const selected = process.env.SEMEVOLVE_TRANSPORT_MUTANT;
  const transforms = {
    collision: ['endpoint.js', 'existing && existing.digest !== digestJson(envelope)', 'false'],
    duplicate: ['endpoint.js', 'inbox.appliedAt !== null', 'false'],
    acknowledgement: ['local.js', 'queues.set(recipientId, queues.get(recipientId).filter(item => item.envelope.message_id !== messageId));',
      'for (const key of queues.keys()) queues.set(key, queues.get(key).filter(item => item.envelope.message_id !== messageId));'],
  };
  const transform = transforms[selected];
  if (!transform || !url.endsWith(`/transport-adapters/dist/${transform[0]}`)) return result;
  const source = String(result.source);
  if (!source.includes(transform[1])) throw new Error('Mutation target not found');
  return { ...result, source: source.replaceAll(transform[1], transform[2]) };
}
