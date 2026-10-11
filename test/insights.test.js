const test = require('node:test');
const assert = require('node:assert');
const i = require('../out/core/insights');

test('index names fit in 10 characters', () => {
  assert.strictEqual(i.indexName('CUSTMAST'), 'CUSTMASIX1');
  assert.strictEqual(i.indexName('ORD', 12), 'ORDIX12');
  assert.ok(i.indexName('VERYLONGTABLENAME', 3).length <= 10);
});

test('index statements quote unusual column names and support EVIs', () => {
  assert.strictEqual(i.indexStatement('MYLIB', 'CUSTMAST', 'CUSTNO, REGION', 'RADIX', 'CUSTMASIX1'),
    'CREATE INDEX MYLIB/CUSTMASIX1 ON MYLIB/CUSTMAST (CUSTNO, REGION)');
  assert.strictEqual(i.indexStatement('MYLIB', 'ORDERS', 'status', 'EVI', 'ORDERSIX1'),
    'CREATE ENCODED VECTOR INDEX MYLIB/ORDERSIX1 ON MYLIB/ORDERS ("status")');
  assert.throws(() => i.indexStatement('L', 'T', ' ', 'RADIX', 'X'), /no key columns/);
});

test('data compare SQL', () => {
  const s = { libA: 'DEV', libB: 'PROD', table: 'CUSTMAST', keys: ['CUSTNO'], columns: ['CUSTNO', 'NAME', 'BALANCE'] };
  assert.strictEqual(i.dataCompareSql(s, 'onlyA', 50),
    'SELECT A.* FROM DEV/CUSTMAST A EXCEPTION JOIN PROD/CUSTMAST B ON A.CUSTNO = B.CUSTNO ORDER BY A.CUSTNO FETCH FIRST 50 ROWS ONLY');
  const changed = i.dataCompareSql(s, 'changed');
  assert.match(changed, /A\.NAME IS DISTINCT FROM B\.NAME OR A\.BALANCE IS DISTINCT FROM B\.BALANCE/);
  assert.match(changed, /A\.NAME AS "A_NAME", B\.NAME AS "B_NAME"/);
  assert.match(i.dataCompareSql(s, 'count'), /AS ONLY_A/);
  assert.throws(() => i.dataCompareSql({ ...s, keys: [] }, 'onlyA'), /key column/);
  assert.deepStrictEqual(i.changedColumns({ CUSTNO: 1, A_NAME: 'Bob  ', B_NAME: 'Bob', A_BALANCE: '1.00', B_BALANCE: '2.00' }, s.columns, s.keys), ['BALANCE']);
});

test('message files and hints', () => {
  assert.deepStrictEqual(i.messageFileFor('CPF9801'), { library: 'QSYS', file: 'QCPFMSG' });
  assert.deepStrictEqual(i.messageFileFor('RNQ0102'), { library: 'QSYS', file: 'QRNXMSG' });
  assert.deepStrictEqual(i.messageFileFor('SQL0204'), { library: 'QSYS', file: 'QSQLMSG' });
  assert.strictEqual(i.messageFileFor('XYZ1234'), undefined);
  assert.match(i.messageHint('cpf4131'), /Recompile/);
  assert.ok(i.MESSAGE_ID.test('error CPF9801 in job'));
});

test('job log analysis finds the root cause before the function check', () => {
  const r = i.analyzeJobLog([
    { id: 'CPF1124', type: 'INFORMATIONAL', severity: 0, text: 'Job started' },
    { id: 'MCH1211', type: 'ESCAPE', severity: 40, text: 'Attempt made to divide by zero', time: '1' },
    { id: 'RNQ0102', type: 'INQUIRY', severity: 99, text: 'Attempt to divide by zero', time: '2' },
    { id: 'CPF9999', type: 'ESCAPE', severity: 40, text: 'Function check', time: '3' },
    { id: 'CPF9999', type: 'ESCAPE', severity: 40, text: 'Function check', time: '4' },
  ]);
  assert.strictEqual(r.rootCause.id, 'MCH1211');
  assert.match(r.rootCause.hint, /divide by zero/);
  assert.strictEqual(r.findings.find(f => f.id === 'CPF9999').count, 2);
  assert.ok(!r.findings.some(f => f.id === 'CPF1124'));
});
