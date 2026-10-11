const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/core/codeTools');

const FREE = `**FREE
// Order entry: calculates the price of an order.
ctl-opt nomain;
dcl-f CUSTMAST usage(*input) keyed;
/copy QPROTOSRC,PRICING
// Price of one line
dcl-proc getPrice export;
  dcl-pi *n packed(9:2);
    item char(10) const;
    qty int(10) const;
  end-pi;
  dcl-s p packed(9:2);
  if qty > 10 and item <> '';
    p = 1;
  elseif qty > 0;
    for i = 1 to 3;
      p += 1;
    endfor;
  endif;
  exec sql select price into :p from items where id = :item;
  return p * qty;
end-proc;
`;

test('metrics of a free-form source', () => {
  const m = c.rpgMetrics(FREE);
  assert.strictEqual(m.procedures, 1);
  assert.strictEqual(m.copies, 1);
  assert.strictEqual(m.sqlStatements, 1);
  assert.strictEqual(m.fixed, 0);
  assert.strictEqual(m.procs[0].name, 'getPrice');
  assert.strictEqual(m.procs[0].complexity, 5); // 1 + IF + AND + ELSEIF + FOR
  assert.strictEqual(m.maxNesting, 2);
  assert.strictEqual(m.grade, 'A');
});

test('metrics of fixed format with indicators and GOTO', () => {
  const fixed = ['     H DFTACTGRP(*NO)', '     C     *ENTRY        PLIST', '     C                   PARM                    CUST              7 0',
    '     C     TAG1          TAG', '     C                   IF        *IN03 = *ON', '     C                   GOTO      TAG1', '     C                   ENDIF', '     C                   SETON                                        LR'].join('\n');
  const m = c.rpgMetrics(fixed);
  assert.ok(m.fixed >= 7 && m.free === 0);
  assert.strictEqual(m.gotos, 1);
  assert.ok(m.indicators >= 1);
  assert.ok(['B', 'C'].includes(m.grade));
  assert.ok(m.notes.some(n => /fixed format/.test(n)));
});

test('documentation from the source', () => {
  const md = c.generateDocs({ library: 'APP', file: 'QRPGLESRC', member: 'ORDPRICE', type: 'rpgle', text: FREE, memberText: 'Order pricing' });
  assert.match(md, /^# ORDPRICE/);
  assert.match(md, /## Description\n\nOrder entry: calculates the price of an order\./);
  assert.match(md, /`CUSTMAST` — usage \*input/);
  assert.match(md, /### getPrice \*\(exported\)\*\n\nPrice of one line/);
  assert.match(md, /`QPROTOSRC,PRICING`/);
});

test('RPGUnit skeleton and results', () => {
  const procs = c.exportedProcedures(FREE);
  assert.deepStrictEqual(procs.map(p => p.name), ['getPrice']);
  assert.strictEqual(procs[0].returns, 'packed(9:2)');
  assert.deepStrictEqual(procs[0].params.map(p => p.name), ['item', 'qty']);
  const sk = c.rpgUnitSkeleton('ORDPRICE', procs, 'QPROTOSRC,PRICING');
  assert.match(sk, /\/include qinclude,TESTCASE/);
  assert.match(sk, /dcl-proc test_getPrice export;/);
  assert.match(sk, /dcl-s item char\(10\) inz\(''\);/);
  assert.match(sk, /actual = getPrice\(item : qty\);/);
  assert.match(sk, /iEqual\(expected : actual\);/);
  const res = c.parseJUnit('<testsuite><testcase name="TEST_GETPRICE" time="0.012"/><testcase name="TEST_X"><failure message="Expected 5, but was 4."/></testcase><testcase name="TEST_Y"><error>MCH1211</error></testcase></testsuite>');
  assert.deepStrictEqual(res.map(r => r.status), ['passed', 'failed', 'error']);
  assert.strictEqual(res[1].message, 'Expected 5, but was 4.');
  assert.deepStrictEqual(c.parseRuSummary('Success. 3 test cases, 7 assertions, 0 failure, 0 error.'), { ok: true, tests: 3, failures: 0, errors: 0 });
  assert.strictEqual(c.parseRuSummary('FAILURE. 2 test cases, 2 assertions, 1 failure, 0 error.').ok, false);
});

test('sparklines', () => {
  assert.strictEqual(c.sparkPoints([0, 50, 100], 100, 10, 100), '0.0,10.0 50.0,5.0 100.0,0.0');
  assert.strictEqual(c.pushSample([1, 2, 3], 4, 3).join(), '2,3,4');
});
