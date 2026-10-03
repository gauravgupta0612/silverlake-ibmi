const test = require('node:test');
const assert = require('node:assert');
const p = require('../out/rpg/parser');

const free = `**free
ctl-opt dftactgrp(*no);
/copy QCPYSRC,PROTOS
/include MYLIB/QRPGLESRC,UTILS
/copy '/home/me/inc/strings.rpgleinc'
dcl-f CUSTMAST keyed;
dcl-s total packed(11:2);
dcl-c MAX_ROWS 100;
dcl-ds order qualified;
  id int(10);
  amount packed(9:2);
end-ds;
dcl-pr getName varchar(50);
  custId int(10) const;
end-pr;

total = 0; // total is reset 'total'
exsr calc;
*inlr = *on;

begsr calc;
  total += order.amount;
endsr;

dcl-proc getName;
  dcl-pi *n varchar(50);
    custId int(10) const;
  end-pi;
  dcl-s total varchar(50);
  total = 'x';
  return total;
end-proc;
`;

test('finds declarations, kinds and parents', () => {
  const r = p.parseRpg(free);
  assert.ok(r.fullyFree);
  const by = n => r.definitions.filter(d => d.upper === n.toUpperCase());
  assert.strictEqual(by('CUSTMAST')[0].kind, 'file');
  assert.strictEqual(by('MAX_ROWS')[0].kind, 'constant');
  assert.strictEqual(by('order')[0].kind, 'ds');
  assert.strictEqual(by('amount')[0].kind, 'subfield');
  assert.strictEqual(by('amount')[0].parent, 'order');
  assert.strictEqual(by('calc')[0].kind, 'subroutine');
  assert.strictEqual(by('total').length, 2);
  assert.strictEqual(by('custId').length, 1, 'prototype parameter names are not definitions, PI parameters are');
  assert.strictEqual(by('custId')[0].kind, 'parameter');
  assert.deepStrictEqual(r.procedures.map(x => x.name), ['getName']);
});

test('resolves local before global', () => {
  const r = p.parseRpg(free);
  const lines = free.split('\n');
  const inProc = lines.findIndex(l => l.includes("total = 'x'"));
  const inMain = lines.findIndex(l => l.startsWith('total = 0'));
  assert.strictEqual(p.resolveDefinition(r, 'TOTAL', inProc).procedure, 'getName');
  assert.strictEqual(p.resolveDefinition(r, 'total', inMain).procedure, undefined);
});

test('copy directives', () => {
  const r = p.parseRpg(free);
  assert.strictEqual(r.copies.length, 3);
  assert.deepStrictEqual([r.copies[0].file, r.copies[0].member, r.copies[0].library], ['QCPYSRC', 'PROTOS', undefined]);
  assert.deepStrictEqual([r.copies[1].library, r.copies[1].file, r.copies[1].member], ['MYLIB', 'QRPGLESRC', 'UTILS']);
  assert.strictEqual(r.copies[2].ifsPath, '/home/me/inc/strings.rpgleinc');
  assert.strictEqual(free.split('\n')[2].substring(r.copies[0].start, r.copies[0].end), 'QCPYSRC,PROTOS');
});

test('occurrences skip strings, comments, BIFs and special values', () => {
  const occ = p.findOccurrences(free, 'total');
  const lines = free.split('\n');
  const resetLine = lines.findIndex(l => l.startsWith('total = 0'));
  assert.strictEqual(occ.filter(o => o.line === resetLine).length, 1);
  assert.strictEqual(p.findOccurrences('**free\nx = %len(len);\n', 'len').length, 1);
  assert.strictEqual(p.findOccurrences('**free\n*in = in;\n', 'in').length, 1);
});

test('fixed-format D, P and C specs', () => {
  const src = [
    '     D custName        S             30A',
    '     D cust            DS',
    '     D  custNo                        7P 0',
    '     P myProc          B                   EXPORT',
    '     C     calcTot       BEGSR',
    '     P myProc          E',
  ].join('\n');
  const r = p.parseRpg(src);
  const names = r.definitions.map(d => `${d.name}:${d.kind}`);
  assert.deepStrictEqual(names, ['custName:variable', 'cust:ds', 'custNo:subfield', 'myProc:procedure', 'calcTot:subroutine']);
  assert.strictEqual(r.procedures[0].name, 'myProc');
});

test('wordAt', () => {
  assert.deepStrictEqual(p.wordAt('  total += order.amount;', 18), { word: 'amount', start: 17, end: 23 });
  assert.strictEqual(p.wordAt('x = 12;', 5), undefined);
});

test('multiplication operand is a reference, continuation keywords are not subfields, commented /copy ignored', () => {
  assert.strictEqual(p.findOccurrences('**free\ntotal = qty*price;\n', 'price').length, 1);
  assert.strictEqual(p.findOccurrences('**free\nx = (a)*in;\n', 'in').length, 1);
  const r = p.parseRpg("**free\ndcl-ds d qualified;\n  name char(10)\n    inz('x');\n  code int(10);\nend-ds;\n// see /copy QRPGLESRC,X\n");
  assert.deepStrictEqual(r.definitions.filter(x => x.kind === 'subfield').map(x => x.name), ['name', 'code']);
  assert.strictEqual(r.copies.length, 0);
  const fixed = p.parseRpg('      /COPY QCPYSRC,PROTOS\n');
  assert.strictEqual(fixed.copies.length, 1);
});
