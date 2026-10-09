const test = require('node:test');
const assert = require('node:assert');
const { scanLanguage, findPrototypes, findProcedureCalls, findDynamicCalls, copyMembers } = require('../out/rpg/callScan');

const free = `**FREE
ctl-opt dftactgrp(*no);
/copy QPROTOSRC,CUSTPR
dcl-pr getCust extproc('CUST_GETCUSTOMER');
  id int(10) const;
end-pr;
dcl-pr runIt extpgm(pgmName);
end-pr;
dcl-pr Calc extproc(*dclcase) end-pr;
dcl-pr fixedPgm extpgm('ORD200') end-pr;
dcl-s pgmName char(10) inz('ORD100');
x = getCust(5); // getCust(9) in a comment
callp getCust(1);
msg = 'getCust(';
runIt();
x = calc() + CUST_DELETE(x);
p = %paddr('CUST_LOG');
fixedPgm();
`;

test('source types map to scanner languages', () => {
  assert.strictEqual(scanLanguage('SQLRPGLE'), 'rpg');
  assert.strictEqual(scanLanguage('RPGLE'), 'rpg');
  assert.strictEqual(scanLanguage('RPG'), 'rpg3');
  assert.strictEqual(scanLanguage('CLLE'), 'cl');
  assert.strictEqual(scanLanguage('/home/me/src/ord.clle'), 'cl');
  assert.strictEqual(scanLanguage('C'), 'other');
});

test('free-form prototypes: EXTPROC literal, *DCLCASE, EXTPGM variable and literal', () => {
  const p = findPrototypes(free).map(x => [x.name, x.isProgram, x.target, x.dynamic]);
  assert.deepStrictEqual(p, [
    ['getCust', false, 'CUST_GETCUSTOMER', undefined],
    ['runIt', true, undefined, 'pgmName'],
    ['Calc', false, 'Calc', undefined],
    ['fixedPgm', true, 'ORD200', undefined],
  ]);
  assert.deepStrictEqual(copyMembers(free).map(c => [c.file, c.member]), [['QPROTOSRC', 'CUSTPR']]);
});

test('calls to exported procedures, through prototypes, by name and by %PADDR', () => {
  const calls = findProcedureCalls(free, 'rpg', ['CUST_GETCUSTOMER', 'Calc', 'CUST_DELETE', 'CUST_LOG', 'UNUSED']);
  assert.deepStrictEqual(calls.map(c => [c.symbol, c.line, c.guessed]), [
    ['CUST_GETCUSTOMER', 12, false],
    ['CUST_GETCUSTOMER', 13, false],
    ['Calc', 16, false],
    ['CUST_DELETE', 16, true],
    ['CUST_LOG', 17, false],
  ]);
});

test('prototypes from /COPY members map local names to symbols', () => {
  const copied = findPrototypes(`**FREE\ndcl-pr delCust extproc('CUST_DELETE');\nend-pr;`);
  const calls = findProcedureCalls('**FREE\ndelCust(1);\nCUST_DELETE(2);', 'rpg', ['CUST_DELETE'], copied);
  assert.deepStrictEqual(calls.map(c => [c.via, c.line, c.guessed]), [['delCust', 2, false], ['CUST_DELETE', 3, true]]);
});

test('fixed-form: long prototype name, continued EXTPROC, CALLB and dynamic CALL', () => {
  const src = [
    '     D GetCustomerInformation...',
    '     D                 PR            10I 0 EXTPROC(',
    "     D                                     'CUST_INFO')",
    '     D  id                           10I 0 CONST',
    '     C                   EVAL      X = GetCustomerInformation(1)',
    '     C                   CALL      PGMVAR',
    "     C                   CALL      'FIXED'",
    "     C                   CALLB     'CUST_LOG'",
    '     C*                  CALL      COMMENTED',
  ].join('\n');
  assert.deepStrictEqual(findPrototypes(src).map(p => [p.name, p.target]), [['GetCustomerInformation', 'CUST_INFO']]);
  assert.deepStrictEqual(findProcedureCalls(src, 'rpg', ['CUST_INFO', 'CUST_LOG']).map(c => [c.symbol, c.line]), [['CUST_INFO', 5], ['CUST_LOG', 8]]);
  assert.deepStrictEqual(findDynamicCalls(src, 'rpg').map(c => [c.kind, c.target, c.line]), [['program', 'PGMVAR', 6]]);
});

test('dynamic calls through EXTPGM(variable) and in RPG III', () => {
  assert.deepStrictEqual(findDynamicCalls(free, 'rpg').map(c => [c.kind, c.target, c.via, c.line]), [['program', 'pgmName', 'runIt', 15]]);
  const rpg3 = ['     C                     CALL PGMNM', "     C                     CALL 'X'"].join('\n');
  assert.deepStrictEqual(findDynamicCalls(rpg3, 'rpg3').map(c => [c.target, c.line]), [['PGMNM', 1]]);
});

test('CL: CALLPRC to exports, dynamic CALL with continuation lines and comments', () => {
  const cl = `PGM
 DCL &PGM *CHAR 10
 CALL PGM(&PGM) /* dynamic */
 CALL PGM(MYLIB/STATIC)
 LOOP: CALLPRC PRC('CUST_LOG') +
          PARM(&X)
 CALL &LIB/&PGM
 CALL PGM(&LIB/FIXED)
 CALLPRC CUST_DELETE
ENDPGM`;
  assert.deepStrictEqual(findProcedureCalls(cl, 'cl', ['CUST_LOG', 'CUST_DELETE']).map(c => [c.symbol, c.line]), [['CUST_LOG', 5], ['CUST_DELETE', 9]]);
  assert.deepStrictEqual(findDynamicCalls(cl, 'cl').map(c => [c.target, c.line]), [['&PGM', 3], ['&LIB/&PGM', 7]]);
});
