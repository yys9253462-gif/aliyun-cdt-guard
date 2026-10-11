import assert from 'node:assert/strict';
import { configKeyMissing } from '../src/check-config-key.mjs';
assert.equal(configKeyMissing('[]'),true);
assert.equal(configKeyMissing('Proxy notice\n[]'),true);
assert.equal(configKeyMissing('[{"name":"config"}]'),false);
assert.equal(configKeyMissing('[{"name":"other"}]'),true);
assert.throws(()=>configKeyMissing('network error'));
assert.throws(()=>configKeyMissing('[{}]'));
console.log('PASS: missing config distinguished from existing config and query errors');
