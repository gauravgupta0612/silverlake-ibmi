const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/rpgFromTable');

const cols = [
  { name: 'CUSTOMER_NUMBER', system: 'CUSTNO', type: 'DECIMAL', length: 7, scale: 0, nullable: false, text: 'Customer number' },
  { name: 'NAME', system: 'NAME', type: 'CHARACTER', length: 30, scale: 0, nullable: false },
  { name: 'NOTE', system: 'NOTE', type: 'VARCHAR', length: 200, scale: 0, nullable: true },
  { name: 'OPENED', system: 'OPENED', type: 'DATE', length: 4, scale: 0, nullable: true },
  { name: 'QTY', system: 'QTY', type: 'INTEGER', length: 4, scale: 0, nullable: false },
];

test('RPG types and generated code', () => {
  assert.deepStrictEqual(cols.map(v.rpgType), ['packed(7:0)', 'char(30)', 'varchar(200)', 'date(*iso)', 'int(10)']);
  const code = v.rpgForTable('APP', 'CUSTMAST', cols, ['CUSTOMER_NUMBER']);
  assert.match(code, /dcl-ds custmast_t qualified template;/);
  assert.match(code, /custno\s+packed\(7:0\); \/\/ Customer number/);
  assert.match(code, /dcl-proc getCustmast export;/);
  assert.match(code, /where "CUSTOMER_NUMBER" = :custno;/);
  assert.match(code, /insert into APP\/CUSTMAST \("CUSTOMER_NUMBER", "NAME", "NOTE", "OPENED", "QTY"\)/);
  assert.match(code, /set "NAME" = :row\.name,/);
  assert.match(code, /declare c_custmast cursor for/);
  assert.throws(() => v.rpgForTable('A', 'T', [], []), /no columns/);
});
