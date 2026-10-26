const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/core/clLanguage');

const SRC = [
  'PGM PARM(&LIB &OPT)            /* entry */',     // 0
  '  DCL VAR(&LIB) TYPE(*CHAR) LEN(10)',            // 1
  '  DCL &OPT *CHAR 1',                             // 2
  '  DCL VAR(&COUNT) TYPE(*DEC) +',                 // 3
  '        LEN(5 0) VALUE(0)',                      // 4
  '  DCLF FILE(QADSPOBJ) OPNID(OBJ)',               // 5
  '  IF COND(&OPT *EQ \'Y\') THEN(DO)',             // 6
  '    CALLSUBR SUBR(COUNTIT)',                     // 7
  '  ENDDO',                                        // 8
  '  ELSE CMD(DO)',                                 // 9
  '    GOTO CMDLBL(DONE)',                          // 10
  '  ENDDO',                                        // 11
  '  SELECT',                                       // 12
  '    WHEN COND(&COUNT *GT 0) THEN(CHGVAR &OPT \'N\')', // 13
  '  ENDSELECT',                                    // 14
  'DONE: RETURN',                                   // 15
  '  SUBR SUBR(COUNTIT)',                           // 16
  '    CHGVAR VAR(&COUNT) VALUE(&COUNT + 1)',       // 17
  '  ENDSUBR',                                      // 18
  'ENDPGM',                                         // 19
].join('\n');

test('CL statements and outline', () => {
  const st = c.clStatements(SRC);
  const cnt = st.find(s => s.line === 3);
  assert.strictEqual(cnt.endLine, 4); assert.match(cnt.text, /TYPE\(\*DEC\) LEN\(5 0\)/);
  assert.strictEqual(st.find(s => s.line === 15).label, 'DONE');
  assert.strictEqual(c.clParam("CHGVAR VAR(&X) VALUE('a(b)' *CAT &Y)", 'VALUE'), "'a(b)' *CAT &Y");
  const sy = c.clSymbols(SRC);
  assert.deepStrictEqual(sy.map(s => [s.kind, s.name, s.line]), [
    ['program', 'PGM', 0], ['variable', '&LIB', 1], ['variable', '&OPT', 2], ['variable', '&COUNT', 3], ['file', 'QADSPOBJ', 5], ['label', 'DONE', 15], ['subroutine', 'COUNTIT', 16],
  ]);
  assert.strictEqual(sy[2].detail, '*CHAR LEN(1)');
  assert.strictEqual(sy[3].detail, '*DEC LEN(5 0) VALUE(0)');
  assert.strictEqual(sy.find(s => s.name === 'COUNTIT').endLine, 18);
});

test('CL folding, definitions, references', () => {
  assert.deepStrictEqual(c.clFolds(SRC), [{ start: 6, end: 8 }, { start: 9, end: 11 }, { start: 12, end: 14 }, { start: 16, end: 18 }]);
  assert.strictEqual(c.clDefinition(SRC, '&count').line, 3);
  assert.strictEqual(c.clDefinition(SRC, 'DONE').line, 15);
  assert.strictEqual(c.clDefinition(SRC, 'countit').line, 16);
  assert.strictEqual(c.clDefinition(SRC, '&NOPE'), undefined);
  const refs = c.clReferences(SRC, '&COUNT');
  assert.deepStrictEqual(refs.map(r => r.line), [3, 13, 17, 17]);
  assert.strictEqual(c.clReferences(SRC, '&OPT').filter(r => r.line === 13).length, 1);
});
