const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/friendlyErrors');

test('plain-language error hints', () => {
  assert.match(v.explainError('SQL0204 ACTIVE_QUERY_INFO in QSYS2 type *N not found.'), /PTF group/);
  assert.match(v.explainError('[SQL0204] CUSTMAST in APPLIB type *FILE not found.'), /library list/);
  assert.match(v.explainError('SQL0551: Not authorized to object ORDERS in APP type *FILE.'), /Check Authority/);
  assert.match(v.explainError('SQL7008 ORDERS in APP not valid for operation.'), /WITH NC/);
  assert.match(v.explainError('Error: All configured authentication methods failed'), /password/);
  assert.match(v.explainError('/QOpenSys/usr/bin/sh: java: not found'), /Java 11/);
  assert.match(v.explainError('Read-only connection: PROD is protected'), /Protection/);
  assert.strictEqual(v.explainError('Everything is fine'), undefined);
});
