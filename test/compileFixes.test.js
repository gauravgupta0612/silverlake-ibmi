const test = require('node:test');
const assert = require('node:assert');
const f = require('../out/core/compileFixes');

test('names from messages, fixed declarations', () => {
  assert.strictEqual(f.nameFromMessage('The name or indicator TOTAL is not defined.'), 'TOTAL');
  assert.strictEqual(f.nameFromMessage("Le nom 'ZZ' n'est pas défini."), 'ZZ');
  const d = f.fixedDeclaration('TOTAL', 'packed(9:2)');
  assert.strictEqual(d[5], 'D'); assert.strictEqual(d.substring(6, 21).trim(), 'TOTAL'); assert.strictEqual(d.substring(23, 24), 'S');
  assert.strictEqual(d.substring(32, 39).trim(), '9'); assert.strictEqual(d[39], 'P'); assert.strictEqual(d.substring(40, 42).trim(), '2');
  assert.match(f.fixedDeclaration('NAME', 'varchar(20)'), /20A   VARYING$/);
});

test('declare plan: global or in the procedure', () => {
  const src = ['**FREE', 'ctl-opt main(main);', 'dcl-s a int(10);', '', 'dcl-proc main;', '  dcl-pi *n;', '    p char(1);', '  end-pi;', '  x = 1;', 'end-proc;'].join('\n');
  assert.deepStrictEqual(f.declarePlan(src, 'x', 'int(10)', 8), { line: 8, where: 'procedure', text: '  dcl-s x int(10);' });
  assert.deepStrictEqual(f.declarePlan(src, 'x', 'int(10)', 8, false), { line: 3, where: 'global', text: 'dcl-s x int(10);' });
  const fixed = ['     H DFTACTGRP(*NO)', '     D A               S             10A', '     C                   EVAL      X = 1'].join('\n');
  const p = f.declarePlan(fixed, 'X', 'char(10)', 2);
  assert.strictEqual(p.line, 2); assert.strictEqual(p.text.substring(6, 21).trim(), 'X');
});

test('unused declaration line', () => {
  const src = ['**FREE', 'dcl-s unused char(10);', 'dcl-ds ds qualified;', '  x int(10);', 'end-ds;'].join('\n');
  assert.strictEqual(f.unusedLine(src, 1, 'UNUSED'), 1);
  assert.strictEqual(f.unusedLine(src, 2, 'ds'), undefined);
  const fixed = ['     D UNUSED          S             10A', '     D LONG            C                   CONST(\'abc\')', '     D                                     \'def\')'].join('\n');
  assert.strictEqual(f.unusedLine(fixed, 0, 'unused'), 0);
  assert.strictEqual(f.unusedLine(fixed, 1, 'LONG'), undefined);
});

test('RNF7031 message without a name', () => {
  assert.strictEqual(f.nameFromMessage('The name or indicator is not referenced.'), undefined);
  assert.strictEqual(f.declaredNameOn('dcl-s unused char(10);'), 'unused');
  assert.strictEqual(f.declaredNameOn('     D UNUSED          S             10A'), 'UNUSED');
  assert.strictEqual(f.declaredNameOn('x = 1;'), undefined);
});
