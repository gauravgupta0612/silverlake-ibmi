const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/sourceAnalysis');

test('hard-coded libraries', () => {
  const src = "**FREE\ndcl-f cust extfile('PRODLIB/CUSTMAST');\n// APPLIB/X comment\nexec sql select * from devlib/orders o join qsys2/systables t on 1=1;\nx = 10/12/2026;\ny = a/b;\nz = 'QTEMP/WORK';";
  assert.deepStrictEqual(v.findHardcodedLibraries(src).map(h => h.library), ['PRODLIB', 'DEVLIB']);
  assert.deepStrictEqual(v.findHardcodedLibraries('PGM\n CALL PGM(APPLIB/ORDENT)\n CPYF FROMFILE(*LIBL/X) TOFILE(QTEMP/Y)\nENDPGM').map(h => [h.line, h.library, h.object]), [[1, 'APPLIB', 'ORDENT']]);
  assert.deepStrictEqual(v.findHardcodedLibraries("x = 'PRODLIB/CUST';", ['PRODLIB']), []);
});

test('unused RPG code', () => {
  const src = "**FREE\ndcl-s used int(10);\ndcl-s dead int(10);\ndcl-c K 5;\ndcl-pr ext extpgm('X');\nend-pr;\ndcl-proc foo;\n exsr sub1;\n used = 1;\nend-proc;\ndcl-proc bar export;\n foo();\nend-proc;\ndcl-proc lonely;\nend-proc lonely;\nbegsr sub1;\nendsr;\nbegsr sub2;\nendsr;\n";
  assert.deepStrictEqual(v.unusedRpg(src).map(u => `${u.kind}:${u.name}`), ['variable:dead', 'constant:K', 'prototype:ext', 'procedure:lonely', 'subroutine:sub2']);
});

test('indicatorUsage: fixed-form C spec and *INxx', () => {
  const src = [
    '     C     KEY           CHAIN     CUSTF                              90',
    '     C  N90              EXSR      SHOW',
    '     C                   EVAL      *IN50 = *ON',
    '     C                   IF        *IN50',
    '     C                   SETON                                        LR',
  ].join('\n');
  const u = v.indicatorUsage(src);
  const by = Object.fromEntries(u.map(x => [x.indicator, x]));
  assert.deepStrictEqual(by['90'].set, [0]);
  assert.deepStrictEqual(by['90'].tested, [1]);
  assert.ok(by['50'].set.includes(2));
  assert.ok(by['50'].tested.includes(3));
  assert.ok(!by.KE, 'factor 1 text is not an indicator');
});

test('indicatorUsage: free form and DDS', () => {
  const free = v.indicatorUsage('**FREE\n*IN33 = *ON;\nif *in33;\nendif;\n*in44 = *off;');
  const f = Object.fromEntries(free.map(x => [x.indicator, x]));
  assert.deepStrictEqual(f['33'].set, [1]);
  assert.deepStrictEqual(f['33'].tested, [2]);
  const dds = v.indicatorUsage('     A                                      CA03(03 \'Exit\')\n     A  40                                  DSPATR(HI)');
  const d = Object.fromEntries(dds.map(x => [x.indicator, x]));
  assert.deepStrictEqual(d['03'].set, [0]);
  assert.deepStrictEqual(d['40'].tested, [1]);
  const probs = v.indicatorProblems(free);
  assert.ok(probs.some(p => p.indicator === '44' && /never tested/.test(p.problem)));
});

test('source quality', () => {
  const free = '**FREE\ndcl-s total packed(9:2);\ntotal = 1;\n*inlr = *on;\n';
  const h = v.sourceHealth(free);
  assert.strictEqual(h.fixed, 0); assert.strictEqual(h.fixedPct, 0); assert.ok(h.score >= 80, String(h.score));
  const fixed = [
    '     C     KEY           CHAIN     CUSTF                              90',
    '     C   90              GOTO      END',
    '     C                   SETON                                        LR',
    '     C     END           TAG',
  ].join('\n');
  const f = v.sourceHealth(fixed);
  assert.strictEqual(f.fixedPct, 100); assert.strictEqual(f.gotos, 1); assert.ok(f.indicators >= 1); assert.ok(f.score < h.score);
  assert.deepStrictEqual([95, 80, 65, 45, 10].map(v.grade), ['A', 'B', 'C', 'D', 'E']);
  assert.ok(v.isRpgType('sqlrpgle') && !v.isRpgType('CLLE'));
});
