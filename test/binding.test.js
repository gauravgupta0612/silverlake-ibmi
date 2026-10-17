const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/binding');

test('service program signatures', () => {
  const a = 'A'.repeat(32); const b = 'B'.repeat(32);
  assert.deepStrictEqual(v.splitSignatures(a + '00' + b.toLowerCase() + '00'), [a, b]);
  assert.deepStrictEqual(v.splitSignatures(a + '00' + b), [a, b]);
  assert.deepStrictEqual(v.splitSignatures(a + b + 'C'.repeat(32)), [a, b, 'C'.repeat(32)]);
  assert.strictEqual(v.signatureState(a, [a, b]), 'current');
  assert.strictEqual(v.signatureState(b, [a, b]), 'older');
  assert.strictEqual(v.signatureState('C'.repeat(32), [a, b]), 'mismatch');
  assert.strictEqual(v.signatureState(a, []), 'unknown');
  assert.strictEqual(v.rebindCommand('*PGM', 'app', 'ordpgm', '*LIBL', 'utils'), 'UPDPGM PGM(APP/ORDPGM) MODULE(*NONE) BNDSRVPGM((*LIBL/UTILS))');
  assert.strictEqual(v.rebindCommand('*SRVPGM', 'APP', 'X', 'APP', 'UTILS'), 'UPDSRVPGM SRVPGM(APP/X) MODULE(*NONE) BNDSRVPGM((APP/UTILS))');
  assert.throws(() => v.rebindCommand('*PGM', 'A;B', 'X', 'APP', 'U'));
});
