import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { encodeWith } from '../../../apps/cli/dist/hub-measurement.js';
import { tokenise } from '../../../apps/cli/dist/hub.js';
import { value } from './helpers.mjs';

test('Node runtime boundary uses the actual fixed encoding export and literal token IDs', () => {
  const require = createRequire(import.meta.url);
  const dependency = require('gpt-tokenizer/encoding/cl100k_base');
  assert.deepEqual(encodeWith('Hello, world!', dependency), [9906, 11, 1917, 0]);
  assert.deepEqual(value(tokenise('日本語')).tokenIds, [9080, 22656, 45918, 252]);
});

test('Node boundary rejects missing encode and malformed token arrays', () => {
  for (const dependency of [null, undefined, {}, { encode: 1 }]) {
    assert.throws(() => encodeWith('x', dependency), { code: 'tokenizer_contract' });
  }
  for (const returned of [undefined, null, false, {}, '1', [1, '2'], [-1], [0.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], Array(1)]) {
    assert.throws(() => encodeWith('x', { encode: () => returned }), { code: 'tokenizer_contract' });
  }
  assert.throws(() => encodeWith({}, { encode: () => [1] }), { code: 'invalid_input' });
});

test('Node boundary preserves text and uses ordinary-text special-token settings', () => {
  let received;
  const dependency = { encode(text, options) { received = { text, options }; return [9906, 11]; } };
  assert.deepEqual(encodeWith(' raw\n日本語 ', dependency), [9906, 11]);
  assert.equal(received.text, ' raw\n日本語 ');
  assert.deepEqual([...received.options.disallowedSpecial], []);
  assert.deepEqual(encodeWith('', { encode: () => [] }), []);
});
