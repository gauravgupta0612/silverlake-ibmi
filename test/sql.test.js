const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/core/sqlContext');
const l = require('../out/core/sqlLiteral');

test('table references with aliases, schemas and comma lists', () => {
  const refs = c.tableReferences(`SELECT a.x FROM mylib.orders a JOIN "MyLib"."Lines" AS b ON a.id = b.id WHERE 'FROM x' = ''`);
  assert.deepStrictEqual(refs, [
    { schema: 'MyLib', table: 'Lines', alias: 'B' },
    { schema: 'MYLIB', table: 'ORDERS', alias: 'A' },
  ]);
  assert.deepStrictEqual(c.tableReferences('SELECT * FROM a x, lib.b AS y, c WHERE 1=1'), [
    { schema: undefined, table: 'A', alias: 'X' },
    { schema: 'LIB', table: 'B', alias: 'Y' },
    { schema: undefined, table: 'C', alias: undefined },
  ]);
  assert.deepStrictEqual(c.tableReferences('UPDATE lib/t SET x = 1'), [{ schema: 'LIB', table: 'T', alias: undefined }]);
});

test('completion context', () => {
  assert.deepStrictEqual(c.completionContext('SELECT * FROM '), { kind: 'table', prefix: '' });
  assert.deepStrictEqual(c.completionContext('SELECT * FROM ORD'), { kind: 'table', prefix: 'ORD' });
  assert.deepStrictEqual(c.completionContext('SELECT * FROM mylib.or'), { kind: 'table', schema: 'MYLIB', prefix: 'or' });
  assert.deepStrictEqual(c.completionContext('SELECT a.'), { kind: 'qualified', qualifier: 'A', prefix: '' });
  assert.deepStrictEqual(c.completionContext('SELECT x FROM a, '), { kind: 'table', prefix: '' });
  assert.deepStrictEqual(c.completionContext('SELECT x FROM t WHERE na'), { kind: 'any', prefix: 'na' });
});

const cols = [
  { name: 'ID', type: 'DECIMAL', length: 7, scale: 0, nullable: false },
  { name: 'NAME', type: 'CHAR', length: 10, scale: 0, nullable: false },
  { name: 'PRICE', type: 'DECIMAL', length: 9, scale: 2, nullable: true },
  { name: 'BORN', type: 'DATE', length: 4, scale: 0, nullable: true },
];

test('literals are validated and escaped', () => {
  assert.strictEqual(l.sqlLiteral("O'Neil", cols[1]), "'O''Neil'");
  assert.strictEqual(l.sqlLiteral('12.50', cols[2]), '12.50');
  assert.strictEqual(l.sqlLiteral('', cols[2]), 'NULL');
  assert.strictEqual(l.sqlLiteral('2026-01-31', cols[3]), "DATE('2026-01-31')");
  assert.throws(() => l.sqlLiteral('abc', cols[0]), /not a valid number/);
  assert.throws(() => l.sqlLiteral('12345678', cols[0]), /too large/);
  assert.throws(() => l.sqlLiteral('1.234', cols[2]), /decimals/);
  assert.throws(() => l.sqlLiteral('x'.repeat(11), cols[1]), /at most 10/);
  assert.throws(() => l.sqlLiteral(null, cols[0]), /NULL/);
  assert.throws(() => l.sqlLiteral('1; DROP TABLE X', cols[0]), /not a valid number/);
});

test('DML statements', () => {
  const t = l.tableName('MYLIB', 'CUST');
  assert.strictEqual(l.updateStatement(t, 5, { NAME: 'Bob', PRICE: null }, cols),
    `UPDATE MYLIB/CUST T SET "NAME" = 'Bob', "PRICE" = NULL WHERE RRN(T) = 5 WITH NC`);
  assert.strictEqual(l.insertStatement(t, { ID: '1', NAME: 'A', PRICE: '' }, cols),
    `INSERT INTO MYLIB/CUST ("ID", "NAME") VALUES (1, 'A') WITH NC`);
  assert.strictEqual(l.deleteStatement(t, 9), 'DELETE FROM MYLIB/CUST T WHERE RRN(T) = 9 WITH NC');
});
