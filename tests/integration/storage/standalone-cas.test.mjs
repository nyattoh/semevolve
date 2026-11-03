import test from 'node:test';
import { standaloneCase } from '../../mechanism/storage/standalone-cas-fixtures.mjs';

for (const operation of ['inspect', 'compare', 'conformance']) for (const change of ['cancel', 'revoke', 'none']) {
  test(`D27 standalone file ${operation} ${change}`, { timeout: 30000 }, t => standaloneCase(t, 'file', operation, change));
}
