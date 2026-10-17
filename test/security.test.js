const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/security'),
  ...require('../out/core/binding'),
};

test('binding directory, binder source, exit points, bulk authority', () => {
  assert.strictEqual(v.addBnddirEntryCommand('APP/APPBND', '*LIBL', 'pricing', '*SRVPGM'), 'ADDBNDDIRE BNDDIR(APP/APPBND) OBJ((*LIBL/PRICING *SRVPGM))');
  assert.strictEqual(v.removeBnddirEntryCommand('APPBND', 'APP', 'PRICING', '*srvpgm'), 'RMVBNDDIRE BNDDIR(*LIBL/APPBND) OBJ((APP/PRICING *SRVPGM))');
  assert.strictEqual(v.rtvbndsrcCommand('app', 'pricing', 'app', 'qsrvsrc', 'pricing'), 'RTVBNDSRC SRVPGM(APP/PRICING) SRCFILE(APP/QSRVSRC) SRCMBR(PRICING) MBROPT(*REPLACE)');
  const open = v.unprotectedExitPoints([{ point: 'QIBM_QZDA_INIT' }, { point: 'qibm_qtf_transfer' }]);
  assert.ok(!open.some(o => o.point === 'QIBM_QZDA_INIT') && !open.some(o => o.point === 'QIBM_QTF_TRANSFER') && open.some(o => o.point === 'QIBM_QZRC_RMT'));
  assert.strictEqual(v.chgobjownCommand('app', 'x', '*pgm', 'appowner', true), 'CHGOBJOWN OBJ(APP/X) OBJTYPE(*PGM) NEWOWN(APPOWNER) CUROWNAUT(*REVOKE)');
  assert.strictEqual(v.bulkAuthorityCommand(true, 'app', 'ord*', '*file', 'devgrp', '*change'), 'GRTOBJAUT OBJ(APP/ORD*) OBJTYPE(*FILE) USER(DEVGRP) AUT(*CHANGE)');
  assert.strictEqual(v.bulkAuthorityCommand(false, 'APP', '*ALL', '*ALL', '*public', '*all'), 'RVKOBJAUT OBJ(APP/*ALL) OBJTYPE(*ALL) USER(*PUBLIC) AUT(*ALL)');
  assert.throws(() => v.bulkAuthorityCommand(true, 'APP', 'O*R', '*ALL', 'X', '*USE'), /generic/);
  assert.ok(v.matchesGeneric('ORDENT', 'ORD*') && !v.matchesGeneric('XORD', 'ORD*') && v.matchesGeneric('A', '*ALL') && v.matchesGeneric('ab', 'AB'));
});

test('public authority', () => {
  assert.strictEqual(v.publicRisk('*ALL'), 'bad'); assert.strictEqual(v.publicRisk('*CHANGE'), 'warn'); assert.strictEqual(v.publicRisk('*USE'), 'ok');
  assert.strictEqual(v.publicRisk('*AUTL', 'MYAUTL'), 'info'); assert.strictEqual(v.publicRisk('USER DEF'), 'info');
  assert.strictEqual(v.setPublicCommand('lib', 'pgm', '*pgm', '*USE'), 'GRTOBJAUT OBJ(LIB/PGM) OBJTYPE(*PGM) USER(*PUBLIC) AUT(*USE) REPLACE(*YES)');
  assert.strictEqual(v.setPublicCommand('LIB', 'F', '*FILE', '*EXCLUDE'), 'RVKOBJAUT OBJ(LIB/F) OBJTYPE(*FILE) USER(*PUBLIC) AUT(*ALL)');
  assert.throws(() => v.setPublicCommand('LIB', 'X) DLTLIB(', '*PGM', '*USE'));
});
