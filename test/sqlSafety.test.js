const test = require('node:test');
const assert = require('node:assert');
const { isReadOnlySql, limitRows } = require('../out/core/sqlSafety');
const { summarizeMonitor, createIndexSql } = require('../out/core/explainSummary');

test('read-only statements are recognised', () => {
  for (const sql of [
    'SELECT * FROM QSYS2.ACTIVE_JOB_INFO',
    'with a as (select 1 x from sysibm.sysdummy1) select * from a',
    "VALUES CURRENT TIMESTAMP",
    "select 'DELETE FROM X' as txt from sysibm.sysdummy1",
    'select update_time from mylib.orders -- delete everything',
    'SELECT * FROM T;',
  ]) { assert.ok(isReadOnlySql(sql), sql); }
});

test('anything that can change data or the system is refused', () => {
  for (const sql of [
    'DELETE FROM ORDERS',
    'UPDATE ORDERS SET X = 1',
    'DROP TABLE ORDERS',
    'CALL QSYS2.QCMDEXC(\'DLTLIB X\')',
    "SELECT QSYS2.QCMDEXC('PWRDWNSYS') FROM SYSIBM.SYSDUMMY1",
    'SELECT * FROM FINAL TABLE (INSERT INTO T VALUES 1)',
    'SELECT 1 FROM SYSIBM.SYSDUMMY1; DELETE FROM T',
    "SELECT SYSTOOLS.GENERATE_SPREADSHEET('/tmp/x', 'select 1') FROM SYSIBM.SYSDUMMY1",
    'CREATE TABLE QTEMP.X (A INT)',
    '',
  ]) { assert.ok(!isReadOnlySql(sql), sql); }
});

test('limitRows adds FETCH FIRST only when missing', () => {
  assert.strictEqual(limitRows('select * from t;', 50), 'select * from t FETCH FIRST 50 ROWS ONLY');
  assert.strictEqual(limitRows('select * from t fetch first 5 rows only', 50), 'select * from t fetch first 5 rows only');
  assert.strictEqual(limitRows('values 1', 50), 'values 1');
});

test('database monitor records are summarised', () => {
  const s = summarizeMonitor([
    { QQRID: 1000, QQ1000: 'SELECT ...' },
    { QQRID: 3000, QQTLN: 'MYLIB', QQTFN: 'ORDERS', QQTOTR: 250000, QQRCOD: 'T1', QQIDXA: 'Y', QQIDXD: 'CUSTNO, ORDDATE', QQEPT: 0.42 },
    { QQRID: 3001, QQTLN: 'MYLIB', QQTFN: 'CUSTMAST', QQILNM: 'MYLIB', QQIFNM: 'CUSTMASTL1' },
    { QQRID: 3003 },
  ]);
  assert.deepStrictEqual(s.tableScans, [{ table: 'MYLIB/ORDERS', rows: '250000', reason: 'no index exists' }]);
  assert.deepStrictEqual(s.indexesUsed, [{ table: 'MYLIB/CUSTMAST', index: 'MYLIB/CUSTMASTL1' }]);
  assert.deepStrictEqual(s.advised, [{ table: 'MYLIB/ORDERS', keys: 'CUSTNO, ORDDATE' }]);
  assert.strictEqual(s.sorts, 1);
  assert.strictEqual(s.estimatedMs, 420);
  assert.ok(s.tips.some(t => t.includes('Large table scan')));
});

test('createIndexSql builds a statement', () => {
  assert.match(createIndexSql('MYLIB/ORDERS', 'CUSTNO, ORDDATE'), /^CREATE INDEX MYLIB\.ORDERS_IX\d+\n  ON MYLIB\.ORDERS \(CUSTNO, ORDDATE\);$/);
});

test('guard is not fooled by comment markers in strings or quoted names', () => {
  assert.ok(!isReadOnlySql("SELECT '--' AS X, QSYS2.QCMDEXC('DLTLIB PROD') FROM SYSIBM.SYSDUMMY1"));
  assert.ok(!isReadOnlySql("SELECT '/*' AS A, QCMDEXC('X'), '*/' FROM SYSIBM.SYSDUMMY1"));
  assert.ok(!isReadOnlySql('SELECT "QSYS2"."QCMDEXC"(\'DLTLIB PROD\') FROM SYSIBM.SYSDUMMY1'));
  assert.ok(isReadOnlySql("SELECT 'it''s; fine' AS A FROM SYSIBM.SYSDUMMY1 -- ; comment"));
  assert.ok(isReadOnlySql('SELECT "My Column" FROM T'));
});

test('limitRows keeps trailing clauses last', () => {
  assert.strictEqual(limitRows('select * from t with ur', 10), 'select * from t FETCH FIRST 10 ROWS ONLY with ur');
  assert.strictEqual(limitRows('select * from t optimize for 5 rows for read only', 10), 'select * from t FETCH FIRST 10 ROWS ONLY optimize for 5 rows for read only');
  assert.strictEqual(limitRows("select 'with ur' from t", 3), "select 'with ur' from t FETCH FIRST 3 ROWS ONLY");
});
