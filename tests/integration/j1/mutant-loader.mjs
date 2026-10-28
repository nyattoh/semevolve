export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const transforms = {
    registry: ['/tests/integration/j1/compose.mjs', 'return result.ok ? { ok: true, value: undefined } : result;', 'return { ok: true, value: undefined };'],
    policy: ['/tests/integration/j1/compose.mjs', 'policy: gate,', 'policy: { async authorise() { return { allowed: true, policyRevision: 1 }; } },'],
    replay: ['/packages/policy/dist/runtime.js', 'if (!reserved.value.created)', 'if (false)'],
  };
  const selected = process.env.SEMEVOLVE_J1_MUTANT;
  const transform = transforms[selected];
  if (!transform || !url.endsWith(transform[0])) return result;
  const source = String(result.source);
  if (source.split(transform[1]).length !== 2) throw new Error('J1 mutant requires exactly one anchor');
  process.stderr.write(`[j1-mutant:${selected}:injected-once]\n`);
  return { ...result, source: source.replace(transform[1], transform[2]) };
}
