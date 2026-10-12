const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v21');

test('source sync status', () => {
  const base = { sourceFile: 'QRPGLESRC', sourceMember: 'ORDENT', memberExists: true };
  assert.strictEqual(v.syncStatus({ ...base, compiledFrom: '2026-10-01 10:00:00', memberChanged: '2026-10-05 09:00:00' }), 'source newer');
  assert.strictEqual(v.syncStatus({ ...base, compiledFrom: '2026-10-01 10:00:00', memberChanged: '2026-10-01 10:00:01' }), 'in sync');
  assert.strictEqual(v.syncStatus({ ...base, memberExists: false, compiledFrom: '2026-10-01 10:00:00' }), 'source missing');
  assert.strictEqual(v.syncStatus({ memberExists: false }), 'no source info');
});

test('change report and templates', () => {
  const md = v.changeReportMarkdown('APP', 7, [
    { kind: 'member', name: 'ORDENT', type: 'RPGLE', where: 'QRPGLESRC', changed: '2026-10-10 09:00', text: 'Order | entry' },
    { kind: 'object', name: 'ORDENT', type: '*PGM', where: 'APP', changed: '2026-10-10 09:05' },
  ], new Date('2026-10-12T00:00:00Z'));
  assert.match(md, /^# Changes in APP — last 7 day\(s\)/);
  assert.match(md, /\| ORDENT \| RPGLE \| QRPGLESRC \| 2026-10-10 09:00 \| Order \\\| entry \|/);
  assert.match(md, /## Objects \(1\)/);
  assert.ok(v.TEMPLATES.length >= 8 && v.TEMPLATES.every(t => t.name && t.type && t.text));
  const t = v.renderTemplate(v.TEMPLATES.find(x => x.type === 'SQL').text, { name: 'orders', text: "Client's orders", user: 'bob', date: new Date('2026-10-12T00:00:00Z') });
  assert.match(t, /CREATE OR REPLACE TABLE MYLIB\/ORDERS FOR SYSTEM NAME ORDERS/);
  assert.match(t, /LABEL ON TABLE MYLIB\/ORDERS IS 'Client''s orders';/);
  assert.match(t, /Created 2026-10-12 by BOB/);
});

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
