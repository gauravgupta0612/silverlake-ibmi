const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v26');

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

test('library list of a job description', () => {
  assert.deepStrictEqual(v.parseLibraryList('APPLIB     QGPL       QTEMP      '), { libraries: ['APPLIB', 'QGPL', 'QTEMP'] });
  assert.deepStrictEqual(v.parseLibraryList('*SYSVAL'), { libraries: [], special: '*SYSVAL' });
  assert.deepStrictEqual(v.libraryListChange(['A', 'B'], ['B', 'C']), { added: ['C'], removed: ['A'], same: false });
  assert.ok(v.libraryListChange(['a'], ['A']).same);
});

test('public authority', () => {
  assert.strictEqual(v.publicRisk('*ALL'), 'bad'); assert.strictEqual(v.publicRisk('*CHANGE'), 'warn'); assert.strictEqual(v.publicRisk('*USE'), 'ok');
  assert.strictEqual(v.publicRisk('*AUTL', 'MYAUTL'), 'info'); assert.strictEqual(v.publicRisk('USER DEF'), 'info');
  assert.strictEqual(v.setPublicCommand('lib', 'pgm', '*pgm', '*USE'), 'GRTOBJAUT OBJ(LIB/PGM) OBJTYPE(*PGM) USER(*PUBLIC) AUT(*USE) REPLACE(*YES)');
  assert.strictEqual(v.setPublicCommand('LIB', 'F', '*FILE', '*EXCLUDE'), 'RVKOBJAUT OBJ(LIB/F) OBJTYPE(*FILE) USER(*PUBLIC) AUT(*ALL)');
  assert.throws(() => v.setPublicCommand('LIB', 'X) DLTLIB(', '*PGM', '*USE'));
});

test('system values on two systems', () => {
  const d = v.diffSystemValues({ QSECURITY: '40', QDATE: '1', QCCSID: '65535' }, { QSECURITY: '30', QDATE: '2', QCCSID: '65535 ' });
  assert.deepStrictEqual(d.map(x => [x.name, x.same]), [['QDATE', false], ['QSECURITY', false], ['QCCSID', true]]);
  assert.ok(v.EXPECTED_DIFFERENT.test('QDATE') && !v.EXPECTED_DIFFERENT.test('QSECURITY'));
});

test('create library and IFS', () => {
  assert.strictEqual(v.createSourceFileCommand('dev', 'qrpglesrc', 'RPG'), "CRTSRCPF FILE(DEV/QRPGLESRC) RCDLEN(112) TEXT('RPG')");
  assert.throws(() => v.createSourceFileCommand('1BAD', 'X', ''));
  assert.strictEqual(v.checkIfsPath(' /home/me/app/ '), '/home/me/app');
  for (const bad of ['rel/x', '/a/../b', '/a//b', '/a/./b']) { assert.throws(() => v.checkIfsPath(bad), bad); }
  assert.strictEqual(v.checkMode('755'), '755'); assert.throws(() => v.checkMode('999')); assert.throws(() => v.checkMode('rwx'));
});
