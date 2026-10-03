const test = require('node:test');
const assert = require('node:assert');
const { convertFixedToFree } = require('../out/rpg/fixedToFree');

// Build a C-spec with exact column positions (1-based like the RPG manuals).
function c({ ind = '', f1 = '', op = '', f2 = '', res = '', hi = '', lo = '', eq = '', ext = '' } = {}) {
  let l = '     C'.padEnd(8, ' ');
  l = l.padEnd(8, ' ') + ind.padEnd(3, ' ');
  l = l + f1.padEnd(14, ' ') + op.padEnd(10, ' ');
  if (ext) { return (l + ext).trimEnd(); }
  l = l + f2.padEnd(14, ' ') + res.padEnd(14, ' ') + ''.padEnd(7, ' ') + hi.padEnd(2, ' ') + lo.padEnd(2, ' ') + eq.padEnd(2, ' ');
  return l.trimEnd();
}

test('column builder matches RPG layout', () => {
  const line = c({ f1: 'KEY', op: 'CHAIN', f2: 'CUSTMAST', hi: '90' });
  assert.strictEqual(line[5], 'C');
  assert.strictEqual(line.substring(11, 25).trim(), 'KEY');
  assert.strictEqual(line.substring(25, 35).trim(), 'CHAIN');
  assert.strictEqual(line.substring(35, 49).trim(), 'CUSTMAST');
  assert.strictEqual(line.substring(70, 72), '90');
});

test('converts structured logic with indentation', () => {
  const src = [
    c({ op: 'IF', ext: 'total > 100' }),
    c({ op: 'EVAL', ext: "msg = 'big'" }),
    c({ op: 'ELSE' }),
    c({ f1: 'A', op: 'ADD', f2: 'B', res: 'C' }),
    c({ op: 'ENDIF' }),
  ];
  const { lines, todo } = convertFixedToFree(src, { baseIndent: '' });
  assert.deepStrictEqual(lines, ['if total > 100;', "  msg = 'big';", 'else;', '  C = A + B;', 'endif;']);
  assert.strictEqual(todo, 0);
});

test('CHAIN with not-found indicator and IFEQ/ANDNE', () => {
  const src = [
    c({ f1: 'KEY', op: 'CHAIN', f2: 'CUSTMAST', hi: '90' }),
    c({ f1: '*IN90', op: 'IFEQ', f2: '*OFF' }),
    c({ f1: 'STATUS', op: 'ANDNE', f2: "'X'" }),
    c({ op: 'EXSR', f2: 'PROCESS' }),
    c({ op: 'END' }),
  ];
  const { lines } = convertFixedToFree(src, { baseIndent: '' });
  assert.deepStrictEqual(lines, [
    'chain KEY CUSTMAST;',
    '*in90 = not %found(CUSTMAST);',
    "if *IN90 = *OFF and STATUS <> 'X';",
    '  exsr PROCESS;',
    'endif;',
  ]);
});

test('SELECT/WHEN/OTHER and READ loop with EOF indicator', () => {
  const src = [
    c({ op: 'SELECT' }),
    c({ op: 'WHEN', ext: 'code = 1' }),
    c({ op: 'READ', f2: 'ORDERS', eq: '99' }),
    c({ op: 'OTHER' }),
    c({ op: 'LEAVE' }),
    c({ op: 'ENDSL' }),
  ];
  const { lines } = convertFixedToFree(src, { baseIndent: '' });
  assert.deepStrictEqual(lines, [
    'select;',
    '  when code = 1;',
    '    read ORDERS;',
    '    *in99 = %eof(ORDERS);',
    '  other;',
    '    leave;',
    'endsl;',
  ]);
});

test('conditioning indicator wraps the statement; comments and unknown opcodes', () => {
  const src = [
    '     C* a fixed comment',
    c({ ind: 'N50', op: 'EVAL', ext: 'x = 1' }),
    c({ f1: 'A', op: 'XFOOT', f2: 'ARR', res: 'TOT' }),
    c({ op: 'MOVEL', f2: 'NAME', res: 'OUT' }),
  ];
  const { lines, todo } = convertFixedToFree(src, { baseIndent: '' });
  assert.strictEqual(lines[0], '// a fixed comment');
  assert.deepStrictEqual(lines.slice(1, 4), ['if not *in50;', '  x = 1;', 'endif;']);
  assert.ok(lines[4].startsWith('// TODO: A XFOOT ARR TOT'));
  assert.strictEqual(lines[5], 'OUT = NAME;');
  assert.strictEqual(todo, 2);
});

test('CALL with PARMs becomes one TODO with the parameter list', () => {
  const src = [c({ op: 'CALL', f2: "'PGMA'" }), c({ op: 'PARM', res: 'P1' }), c({ op: 'PARM', res: 'P2' }), c({ op: 'RETURN' })];
  const { lines } = convertFixedToFree(src, { baseIndent: '' });
  assert.ok(lines[0].includes("CALL 'PGMA'") && lines[0].endsWith('parms: P1, P2'));
  assert.strictEqual(lines[1], 'return;');
});

test('mixed-format sources get column-8 indentation', () => {
  const { lines } = convertFixedToFree([c({ op: 'EVAL', ext: 'a = b' })]);
  assert.strictEqual(lines[0], '       a = b;');
});
