const test = require('node:test');
const assert = require('node:assert');
const { convertDeclarations, splitKeywords } = require('../out/rpg/fixedDecls');
const { convertFixedToFree } = require('../out/rpg/fixedToFree');

// Build a fixed-format line by 1-based column positions.
function at(spec, fields) {
  let l = '     ' + spec;
  for (const [colNo, text] of fields) { l = l.padEnd(colNo - 1, ' '); l = l.substring(0, colNo - 1) + text + l.substring(colNo - 1 + text.length); }
  return l.trimEnd();
}
const D = ({ name = '', ext = '', dsType = '', def = '', from = '', to = '', type = '', dec = '', kw = '' } = {}) =>
  at('D', [[7, name], [22, ext], [23, dsType], [24, def], [26, from.padStart(7)], [33, to.padStart(7)], [40, type], [41, dec.padStart(2)], [44, kw]]);
const F = ({ name = '', type = 'I', des = 'F', add = '', fmt = 'E', rec = '', klen = '', key = '', dev = 'DISK', kw = '' } = {}) =>
  at('F', [[7, name], [17, type], [18, des], [20, add], [22, fmt], [23, rec.padStart(5)], [29, klen.padStart(5)], [34, key], [36, dev], [44, kw]]);

test('splitKeywords respects parentheses and quotes', () => {
  assert.deepStrictEqual(splitKeywords("DIM(10) INZ('a b') QUALIFIED"), ['DIM(10)', "INZ('a b')", 'QUALIFIED']);
});

test('H spec becomes ctl-opt', () => {
  const r = convertDeclarations(["     H DFTACTGRP(*NO) ACTGRP('QILE')"], '');
  assert.deepStrictEqual(r.lines, ["ctl-opt DFTACTGRP(*NO) ACTGRP('QILE');"]);
});

test('F specs: keyed update file, workstation, printer, program described', () => {
  const r = convertDeclarations([
    F({ name: 'CUSTMAST', type: 'U', key: 'K' }),
    F({ name: 'ORDERS', type: 'I', add: 'A', key: 'K' }),
    F({ name: 'SCREEN', type: 'C', dev: 'WORKSTN', kw: 'INDDS(Ind)' }),
    F({ name: 'QSYSPRT', type: 'O', dev: 'PRINTER', fmt: 'F', rec: '132' }),
  ], '');
  assert.deepStrictEqual(r.lines, [
    'dcl-f CUSTMAST keyed usage(*update:*delete);',
    'dcl-f ORDERS keyed usage(*input:*output);',
    'dcl-f SCREEN workstn INDDS(Ind);',
    'dcl-f QSYSPRT printer(132);',
  ]);
  assert.strictEqual(r.todo, 0);
});

test('D specs: standalone fields, constants and types', () => {
  const r = convertDeclarations([
    D({ name: 'Count', def: 'S', to: '10', type: 'I', dec: '0' }),
    D({ name: 'Total', def: 'S', to: '11', dec: '2' }),
    D({ name: 'Name', def: 'S', to: '50', kw: 'VARYING' }),
    D({ name: 'Today', def: 'S', type: 'D', kw: 'DATFMT(*ISO) INZ(*SYS)' }),
    D({ name: 'Flag', def: 'S', type: 'N' }),
    D({ name: 'Ptr', def: 'S', type: '*' }),
    D({ name: 'Copy', def: 'S', kw: 'LIKE(Name)' }),
    D({ name: 'MAX', def: 'C', kw: 'CONST(100)' }),
    D({ name: 'TITLE', def: 'C', kw: "'Orders'" }),
  ], '');
  assert.deepStrictEqual(r.lines, [
    'dcl-s Count int(10);',
    'dcl-s Total packed(11:2);',
    'dcl-s Name varchar(50);',
    'dcl-s Today date(*ISO) INZ(*SYS);',
    'dcl-s Flag ind;',
    'dcl-s Ptr pointer;',
    'dcl-s Copy LIKE(Name);',
    'dcl-c MAX 100;',
    "dcl-c TITLE 'Orders';",
  ]);
});

test('data structure with subfields, positions and overlay', () => {
  const r = convertDeclarations([
    D({ name: 'Cust', def: 'DS', kw: 'QUALIFIED' }),
    D({ name: 'Id', to: '7', dec: '0' }),
    D({ name: 'Name', to: '30' }),
    D({ name: 'Code', from: '38', to: '40' }),
    D({ name: 'Region', to: '2', kw: 'OVERLAY(Cust:38)' }),
    D({ name: 'Total', def: 'S', to: '9', type: 'P', dec: '2' }),
  ], '');
  assert.deepStrictEqual(r.lines, [
    'dcl-ds Cust QUALIFIED;',
    '  Id zoned(7:0);',
    '  Name char(30);',
    '  Code char(3) pos(38);',
    '  Region char(2) pos(38);',
    'end-ds;',
    'dcl-s Total packed(9:2);',
  ]);
});

test('LIKEDS data structure has no END-DS; externally described DS', () => {
  const r = convertDeclarations([
    D({ name: 'Copy', def: 'DS', kw: 'LIKEDS(Cust)' }),
    D({ name: 'CUSTMAST', ext: 'E', def: 'DS' }),
    D({ name: 'Total', def: 'S', to: '5', type: 'I', dec: '0' }),
  ], '');
  assert.deepStrictEqual(r.lines, [
    'dcl-ds Copy LIKEDS(Cust);',
    "dcl-ds CUSTMAST extname('CUSTMAST');",
    'end-ds;',
    'dcl-s Total int(5);',
  ]);
});

test('procedure with interface, prototype, long names and continuation keywords', () => {
  const r = convertDeclarations([
    D({ name: 'GetCustomer', def: 'PR', to: '30', kw: "EXTPROC('GETCUST')" }),
    D({ name: 'id', to: '7', dec: '0', kw: 'CONST' }),
    at('P', [[7, 'CalculateOrderTo...']]),
    at('P', [[7, 'tal'], [24, 'B'], [44, 'EXPORT']]),
    D({ def: 'PI', to: '11', dec: '2' }),
    D({ name: 'orderId', to: '9', type: 'P', dec: '0', kw: 'CONST' }),
    D({ name: 'Read', to: '1' }),
    D({ kw: 'OPTIONS(*NOPASS)' }),
    at('P', [[7, 'CalculateOrderTotal'], [24, 'E']]),
  ], '');
  assert.deepStrictEqual(r.lines, [
    "dcl-pr GetCustomer char(30) EXTPROC('GETCUST');",
    '  id packed(7:0) CONST;',
    'end-pr;',
    'dcl-proc CalculateOrderTotal EXPORT;',
    'dcl-pi *n packed(11:2);',
    '  orderId packed(9:0) CONST;',
    '  dcl-parm Read char(1) OPTIONS(*NOPASS);',
    'end-pi;',
    'end-proc;',
  ]);
});

test('whole program: declarations and C-specs together', () => {
  const src = [
    '     H DFTACTGRP(*NO)',
    F({ name: 'CUSTMAST', key: 'K' }),
    '      * Work fields',
    D({ name: 'Total', def: 'S', to: '9', type: 'P', dec: '2' }),
    '     C                   EVAL      Total = 0',
    '     C                   RETURN',
  ];
  const { lines, todo } = convertFixedToFree(src, { baseIndent: '' });
  assert.deepStrictEqual(lines, [
    'ctl-opt DFTACTGRP(*NO);',
    'dcl-f CUSTMAST keyed;',
    '// Work fields',
    'dcl-s Total packed(9:2);',
    'Total = 0;',
    'return;',
  ]);
  assert.strictEqual(todo, 0);
});

test('declarations can be left alone', () => {
  const src = [D({ name: 'Total', def: 'S', to: '9', type: 'P', dec: '2' })];
  assert.deepStrictEqual(convertFixedToFree(src, { declarations: false }).lines, src);
});

test('review fixes: OVERLAY *NEXT, continued literals, LIKE +n, EXTNAME case, program-described keys', () => {
  const r = convertDeclarations([
    D({ name: 'myDs', def: 'DS' }),
    D({ name: 'a', to: '5' }),
    D({ name: 'b', to: '10', kw: 'OVERLAY(myDs:*next)' }),
    D({ name: 'Msg', def: 'C', kw: "'This is a long -" }),
    D({ kw: 'continued text\'' }),
    D({ name: 'Wide', def: 'S', to: '+2', kw: 'LIKE(Name)' }),
    D({ name: 'custmast', ext: 'E', def: 'DS' }),
    F({ name: 'CUSTPD', fmt: 'F', rec: '200', klen: '7', key: 'A', kw: 'KEYLOC(1)' }),
    D({ name: 'Name', def: 'S', to: '10' }),
    D({ kw: 'VARYING' }),
  ], '');
  assert.deepStrictEqual(r.lines, [
    'dcl-ds myDs;',
    '  a char(5);',
    '  b char(10);',
    'end-ds;',
    "dcl-c Msg 'This is a long continued text';",
    'dcl-s Wide LIKE(Name:+2);',
    "dcl-ds custmast extname('CUSTMAST');",
    'end-ds;',
    'dcl-f CUSTPD disk(200) keyed(*char:7) KEYLOC(1);',
    'dcl-s Name varchar(10);',
  ]);
});

test('directives inside a data structure, compile-time data and wrapping at column 80', () => {
  const src = [
    D({ name: 'Cust', def: 'DS' }),
    '      /IF DEFINED(EXTRA)',
    D({ name: 'Extra', to: '10' }),
    '      /ENDIF',
    D({ name: 'Name', to: '30' }),
    '     C                   EVAL      Name = \'a very long literal that goes on\' + \'and on and on beyond col 80\'',
    '**CTDATA Months',
    '     D not a spec',
  ];
  const { lines } = convertFixedToFree(src);
  assert.deepStrictEqual(lines.slice(0, 6), [
    '       dcl-ds Cust;',
    '         /IF DEFINED(EXTRA)',
    '         Extra char(10);',
    '         /ENDIF',
    '         Name char(30);',
    '       end-ds;',
  ]);
  assert.ok(lines.every(l => l.startsWith('**') || l.startsWith('     D') || l.length <= 80), lines.join('\n'));
  assert.deepStrictEqual(lines.slice(-2), ['**CTDATA Months', '     D not a spec']);
});
