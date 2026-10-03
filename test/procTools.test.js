const test = require('node:test');
const assert = require('node:assert');
const t = require('../out/rpg/procTools');

const src = `**free
ctl-opt dftactgrp(*no);
/copy QCPYSRC,DATEUTIL
/copy QCPYSRC,UNUSED
dcl-s total packed(11:2);
dcl-s count int(10);

total = 0;
count = count + 1;
if count > 10;
  total = total * 2;
endif;
*inlr = *on;

dcl-proc getName export;
  dcl-pi *n varchar(50);
    custId int(10) const;
    opts char(10) options(*nopass)
                  const;
  end-pi;
  dcl-s local varchar(50);
  local = 'x';
  return local;
end-proc;

dcl-proc noParms;
  count += 1;
end-proc;
`;

test('prototype from a procedure with a return value and parameters', () => {
  const line = src.split('\n').findIndex(l => l.includes("local = 'x'"));
  const r = t.prototypeFromProcedure(src, line);
  assert.strictEqual(r.name, 'getName');
  assert.strictEqual(r.text, [
    'dcl-pr getName varchar(50);',
    '  custId int(10) const;',
    '  opts char(10) options(*nopass) const;',
    'end-pr;',
  ].join('\n'));
});

test('prototype for a procedure without interface notes it is not exported', () => {
  const line = src.split('\n').findIndex(l => l.includes('count += 1'));
  const r = t.prototypeFromProcedure(src, line);
  assert.match(r.text, /^\/\/ Note: noParms is not EXPORTed/);
  assert.match(r.text, /dcl-pr noParms end-pr;$/);
});

test('prototype outside a procedure is refused', () => {
  assert.throws(() => t.prototypeFromProcedure(src, 7), /inside a procedure/);
});

test('copybook usage finds used and unused copybooks', () => {
  const lines = src.split('\n');
  const copies = new Map([
    [lines.findIndex(l => l.includes('DATEUTIL')), '**free\ndcl-pr toIso char(10);\n  d date const;\nend-pr;\ndcl-s total2 int(10);'],
    [lines.findIndex(l => l.includes('UNUSED')), '**free\ndcl-pr neverCalled;\nend-pr;'],
  ]);
  const withCall = src.replace("total = 0;", "total = 0;\nx = toIso(%date());");
  const u = t.copybookUsage(withCall, new Map([...copies].map(([k, v]) => [k, v])));
  assert.strictEqual(u.length, 2);
  assert.deepStrictEqual(u[0].used, ['TOISO']);
  assert.strictEqual(u[1].used.length, 0);
  assert.strictEqual(u[1].declared, 1);
});

test('extract main-line code into a procedure', () => {
  const lines = src.split('\n');
  const s = lines.findIndex(l => l.startsWith('if count'));
  const e = lines.findIndex(l => l.startsWith('endif'));
  const r = t.extractProcedure(src, s, e, 'doubleTotal');
  assert.strictEqual(r.call, 'doubleTotal();');
  assert.match(r.procedure, /dcl-proc doubleTotal;\n  if count > 10;\n    total = total \* 2;\n  endif;\nend-proc;/);
});

test('extract refuses unbalanced blocks, exits and local variables', () => {
  const lines = src.split('\n');
  const ifLine = lines.findIndex(l => l.startsWith('if count'));
  assert.throws(() => t.extractProcedure(src, ifLine, ifLine + 1, 'x1'), /opens a block/);
  const ret = lines.findIndex(l => l.includes('return local'));
  assert.throws(() => t.extractProcedure(src, ret, ret, 'x2'), /RETURN/);
  const loc = lines.findIndex(l => l.includes("local = 'x'"));
  assert.throws(() => t.extractProcedure(src, loc, loc, 'x3'), /local variables of getName/);
  assert.throws(() => t.extractProcedure(src, ifLine, ifLine + 2, 'total'), /already declared/);
});

test('extract inserts before compile-time data', () => {
  const ct = src + '**ctdata arr\nAAA\n';
  const lines = ct.split('\n');
  const r = t.extractProcedure(ct, 7, 7, 'resetTotal');
  assert.strictEqual(r.insertLine, lines.findIndex(l => l.startsWith('**ctdata')));
});

test('control option check', () => {
  assert.ok(t.hasProcedureFriendlyControl(src));
  assert.ok(!t.hasProcedureFriendlyControl('**free\ndsply x;'));
});
