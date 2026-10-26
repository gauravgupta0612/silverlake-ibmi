const test = require('node:test');
const assert = require('node:assert');
const e = require('../out/rpg/editing');

const FREE = [
  '**FREE',                       // 0
  'dcl-ds cust qualified;',      // 1
  '  id int(10);',                // 2
  'end-ds;',                      // 3
  'dcl-ds copy likeds(cust);',   // 4
  'dcl-pr getName varchar(50);', // 5
  '  id int(10) const;',          // 6
  '  opt ind options(*nopass);',  // 7
  'end-pr;',                      // 8
  'dcl-proc main;',               // 9
  'if x = 1;',                    // 10
  'dow not %eof(f);',             // 11
  'read f;',                      // 12
  'enddo;',                       // 13
  'else;',                        // 14
  'select;',                      // 15
  'when a = 1;',                  // 16
  'x = getName(1:',               // 17
  '   *on);',                     // 18
  'other;',                       // 19
  'endsl;',                       // 20
  'endif;',                       // 21
  'end-proc;',                    // 22
];

test('RPG folding: free, fixed, single-line declarations', () => {
  assert.deepStrictEqual(e.rpgFolds(FREE.join('\n')), [
    { start: 1, end: 3 }, { start: 5, end: 8 }, { start: 9, end: 22 }, { start: 10, end: 21 }, { start: 11, end: 13 }, { start: 15, end: 20 },
  ]);
  const fixed = [
    '     C     X             IFEQ      1',
    '     C                   DO        10',
    '     C                   ENDDO',
    '     C                   END',
    '     P myProc          B',
    '     P myProc          E',
  ].join('\n');
  assert.deepStrictEqual(e.rpgFolds(fixed), [{ start: 0, end: 3 }, { start: 1, end: 2 }, { start: 4, end: 5 }]);
});

test('RPG parameter hints', () => {
  const sigs = e.rpgSignatures(FREE.join('\n'));
  const g = sigs.find(s => s.name === 'getName');
  assert.deepStrictEqual(g.params.map(p => p.name), ['id', 'opt']);
  assert.strictEqual(g.returns, 'varchar(50)');
  assert.match(g.params[1].definition, /options\(\*nopass\)/);
  const fixed = e.rpgSignatures(['     D addTax          PR             9P 2', '     D  amount                        9P 2 CONST', '     D  rate                          5P 3 CONST'].join('\n'));
  assert.deepStrictEqual(fixed[0].params.map(p => p.name), ['amount', 'rate']);
  assert.deepStrictEqual(e.activeCall('x = getName(1: %trim(a'), { name: '%trim', index: 0 });
  assert.deepStrictEqual(e.activeCall("x = getName(1: 'a:b'"), { name: 'getName', index: 1 });
  assert.deepStrictEqual(e.activeCall('x = getName(f(1:2): '), { name: 'getName', index: 1 });
  assert.strictEqual(e.activeCall('x = 1;'), undefined);
  assert.ok(e.BIF_SIGNATURES['%SUBST'].length === 3);
});

test('RPG formatter (fully free only)', () => {
  const out = e.formatFreeRpg(FREE.join('\n'), 2);
  assert.strictEqual(out.length, FREE.length);
  assert.deepStrictEqual(out.slice(9, 23), [
    'dcl-proc main;', '  if x = 1;', '    dow not %eof(f);', '      read f;', '    enddo;', '  else;', '    select;', '      when a = 1;',
    '        x = getName(1:', '           *on);', '      other;', '    endsl;', '  endif;', 'end-proc;',
  ]);
  assert.strictEqual(out[2], '  id int(10);'); assert.strictEqual(out[4], 'dcl-ds copy likeds(cust);'); assert.strictEqual(out[5], 'dcl-pr getName varchar(50);');
  assert.strictEqual(e.formatFreeRpg('     C                   EVAL      X = 1'), undefined);
  const data = e.formatFreeRpg('**FREE\nif a;\nx=1;\nendif;\n**CTDATA arr\n  keep  ');
  assert.deepStrictEqual(data, ['**FREE', 'if a;', '  x=1;', 'endif;', '**CTDATA arr', '  keep  ']);
});

test('fixed-format field under the cursor', () => {
  const line = '     C     KEY           CHAIN     CUSTF';
  const at = e.fieldAt(line, 26, 'rpgle');
  assert.strictEqual(at.spec, 'C'); assert.ok(at.field); assert.ok(at.field.from <= 27 && at.field.to >= 27);
  assert.strictEqual(e.fieldAt('dcl-s x int(10);', 3, 'rpgle'), undefined);
  const next = e.nextFieldColumn(line, 26, 'rpgle');
  assert.ok(next > 26);
  assert.ok(e.nextFieldColumn(line, 26, 'rpgle', true) < 26);
});
