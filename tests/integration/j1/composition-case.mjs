import test from 'node:test';
import { compositionCases } from './composition-cases.mjs';
import { selectCase } from './detection-runner.mjs';

const c = selectCase(compositionCases, process.argv.slice(2));
test(c.name, c.options, c.run);
