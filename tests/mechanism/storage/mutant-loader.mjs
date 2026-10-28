export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const selected = process.env.SEMEVOLVE_STORAGE_MUTANT;
  const transforms = {
    negation: ['/packages/storage-planner/dist/planner.js', "result.literalRestoration === 'pass' && result.meaningPreservation === 'pass' && result.retrievalCorrectness === 'pass'", "result.literalRestoration === 'pass' && result.retrievalCorrectness === 'pass'", 1],
    unverified: ['/packages/storage-planner/dist/planner.js', 'if (!found)', 'if (false)', 1],
    cas: ['/packages/storage-planner/dist/migration.js', 'if (input.expectedRevision !== s.revision)', 'if (false)', 2],
    pending: ['/packages/storage-planner/dist/migration.js', "if (receipt !== undefined)\n                return v.unavailable('Pending migration and receipt disagree');\n            return state.migration;", "if (receipt !== undefined)\n                return v.unavailable('Pending migration and receipt disagree');\n            return { ...state.migration, pendingOperation: null, switchedAtRevision: s.revision };", 1],
    restore: ['/packages/storage-planner/dist/migration.js', 'const dataset = await this.dataset(s);', 'const dataset = previous.dataset;', 3],
  };
  const transform = transforms[selected];
  if (!transform || !url.endsWith(transform[0])) return result;
  let source = String(result.source).replaceAll('\r\n', '\n');
  if (source.split(transform[1]).length !== transform[3] + 1) throw new Error(`Storage mutant anchor count mismatch: ${selected}`);
  if (selected === 'restore') {
    const position = source.indexOf('async restore(request)');
    if (position < 0 || source.slice(position).split(transform[1]).length !== 2) throw new Error('Restore mutant requires one method-local anchor');
    source = source.slice(0, position) + source.slice(position).replace(transform[1], transform[2]);
  } else source = source.replace(transform[1], transform[2]);
  process.stderr.write(`[storage-mutant:${selected}:injected-once]\n`);
  return { ...result, source };
}
