const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/core/schemaObjects');

test('schema browser queries and objects', () => {
  assert.throws(() => s.checkSchema("A'B"), /not a valid/);
  assert.strictEqual(s.checkSchema('mylib'), 'MYLIB');
  const qs = s.schemaQueries('app');
  assert.strictEqual(qs.length, 6); assert.ok(qs.every(q => q.sql.includes("'APP'")));
  const o = s.toSchemaObject({ N: 'ORDERS', SN: 'ORDERS', T: 'T', D: 'Orders', O: '' });
  assert.deepStrictEqual([o.kind, o.name, o.specific], ['table', 'ORDERS', undefined]);
  assert.strictEqual(s.toSchemaObject({ N: 'P', SN: 'P00001', T: 'R' }).specific, 'P00001');
  assert.strictEqual(s.toSchemaObject({ N: 'X', T: '?' }), undefined);
  assert.deepStrictEqual(s.ddlTypes('logical'), ['VIEW', 'INDEX']);
  assert.deepStrictEqual(s.countByKind([o, o, s.toSchemaObject({ N: 'V', T: 'V' })]), [['table', 2], ['view', 1]]);
});

test('procedure call: literals, OUT parameters through global variables', () => {
  const params = [
    { position: 1, name: 'CUST', mode: 'IN', type: 'DECIMAL', precision: 7, scale: 0 },
    { position: 2, name: 'NAME', mode: 'IN', type: 'CHARACTER', length: 6 },
    { position: 3, name: 'TOTAL', mode: 'OUT', type: 'DECIMAL', precision: 11, scale: 2 },
    { position: 4, name: 'MSG', mode: 'INOUT', type: 'VARCHAR', length: 100 },
    { position: 5, name: 'OPT', mode: 'IN', type: 'INTEGER', hasDefault: true },
  ];
  const p = s.callPlan('app', 'GETTOTAL', params, { 1: '42', 2: "O'Hara", 4: 'hi' });
  assert.deepStrictEqual(p.setup, ['CREATE OR REPLACE VARIABLE QTEMP.VX_CALL_P3 DECIMAL(11, 2)', 'CREATE OR REPLACE VARIABLE QTEMP.VX_CALL_P4 VARCHAR(100)', "SET QTEMP.VX_CALL_P4 = 'hi'"]);
  assert.strictEqual(p.call, "CALL APP.GETTOTAL(42, 'O''Hara', QTEMP.VX_CALL_P3, QTEMP.VX_CALL_P4, DEFAULT)");
  assert.strictEqual(p.read, 'SELECT QTEMP.VX_CALL_P3 AS "TOTAL", QTEMP.VX_CALL_P4 AS "MSG" FROM SYSIBM.SYSDUMMY1');
  assert.deepStrictEqual(p.cleanup, ['DROP VARIABLE QTEMP.VX_CALL_P3', 'DROP VARIABLE QTEMP.VX_CALL_P4']);
  assert.throws(() => s.callPlan('app', 'X', params, { 1: 'abc' }), /needs a number/);
  assert.throws(() => s.paramLiteral(params[1], 'toolong'), /at most 6/);
  assert.throws(() => s.paramLiteral(params[0], 'default'), /no default/);
  assert.strictEqual(s.paramLiteral(params[0], 'null'), 'NULL');
  assert.strictEqual(s.callPlan('app', 'X', [params[0]], { 1: '1' }).read, undefined);
  assert.match(s.parametersSql('app', 'p00001'), /SPECIFIC_NAME = 'P00001'/);
  assert.doesNotMatch(s.parametersSql('app', 'p', false), /DEFAULT IS NULL/);
  assert.deepStrictEqual(s.toProcParam({ P: 2, N: 'X ', M: 'INOUT', T: 'char', L: 3, DF: 1 }), { position: 2, name: 'X', mode: 'INOUT', type: 'CHAR', length: 3, precision: undefined, scale: undefined, hasDefault: true });
});
