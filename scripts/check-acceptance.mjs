import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';

const schema = JSON.parse(readFileSync(new URL('../evaluation/manifests/acceptance.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);

export function validateAcceptance(ledger) {
  if (!validate(ledger)) return { valid: false, errors: validate.errors.map((error) => `${error.instancePath} ${error.message}`) };
  const expected = Array.from({ length: 34 }, (_, index) => `AT-${String(index + 1).padStart(2, '0')}`);
  if (ledger.entries.some((entry, index) => entry.at_id !== expected[index])) {
    return { valid: false, errors: ['AT-01 through AT-34 must occur exactly once in order'] };
  }
  return { valid: true, errors: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? new URL('../tests/support/acceptance-unrun.json', import.meta.url);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const result = validateAcceptance(ledger);
  if (!result.valid) {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries(['not_run', 'pass', 'fail', 'inconclusive'].map((verdict) =>
      [verdict, ledger.entries.filter((entry) => entry.mechanism_verdict === verdict).length]));
    process.stdout.write(`${JSON.stringify({ schema_valid: true, mechanism_results: counts })}\n`);
  }
}
