import assert from 'node:assert/strict';
import test from 'node:test';
import { cases } from './detection-cases.mjs';
assert.equal(process.argv.length, 3, 'Exactly one storage detection case is required');
const selected = cases.find(c => c.id === process.argv[2]);
assert.ok(selected, 'Unknown storage detection case');
test(selected.name, { timeout: 30000 }, selected.run);
