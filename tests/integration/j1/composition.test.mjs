import test from 'node:test';
import { compositionCases } from './composition-cases.mjs';
import { validateCases } from './detection-runner.mjs';

for (const c of validateCases(compositionCases)) test(c.name, c.options, c.run);
