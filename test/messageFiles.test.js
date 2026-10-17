const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/messageFiles');

test('message file and field finder helpers', () => {
  assert.strictEqual(v.addMessageCommand('app', 'appmsgf', { id: 'app0001', text: "Customer &1 not found", help: "Check the number.", severity: 30 }),
    "ADDMSGD MSGID(APP0001) MSGF(APP/APPMSGF) MSG('Customer &1 not found') SECLVL('Check the number.') SEV(30)");
  assert.match(v.changeMessageCommand('APP', 'M', { id: 'APP0002', text: "It's", severity: 0 }), /^CHGMSGD MSGID\(APP0002\) .*MSG\('It''s'\) SEV\(0\) SECLVL\(\*NONE\)$/);
  assert.throws(() => v.addMessageCommand('APP', 'M', { id: 'APP001', text: 'x' }), /4 hexadecimal/);
  assert.throws(() => v.addMessageCommand('APP', 'M', { id: 'APP0001', text: 'x', severity: 120 }), /0 to 99/);
  assert.strictEqual(v.removeMessageCommand('APP', 'M', 'APP0001'), 'RMVMSGD MSGID(APP0001) MSGF(APP/M)');
  assert.strictEqual(v.nextMessageId(['APP0009', 'APP000F', 'XYZ0100'], 'APP'), 'APP0010');
  assert.strictEqual(v.nextMessageId([], 'ORD'), 'ORD0001');
  assert.strictEqual(v.likePattern('custno'), '%CUSTNO%');
  assert.strictEqual(v.likePattern('CUST*'), 'CUST%');
  assert.strictEqual(v.likePattern("o'x"), "%O''X%");
});
