const test = require('node:test');
const assert = require('node:assert');
const p = require('../out/core/pdm');

test('generic names and subsets', () => {
  assert.ok(p.matchGeneric('ORD001', 'ORD*'));
  assert.ok(p.matchGeneric('XORDX', '*ORD*'));
  assert.ok(!p.matchGeneric('CUST', 'ORD*'));
  assert.ok(p.matchGeneric('A.B', 'A.B') && !p.matchGeneric('AXB', 'A.B'));
  assert.ok(p.matchGeneric('ANY', '*ALL') && p.matchGeneric('ANY', ''));
  const rows = [
    { name: 'ORD001', type: 'RPGLE', text: 'Order entry', changed: '2026-10-01 10:00' },
    { name: 'ORD002', type: 'CLLE', text: 'Order batch', changed: '2026-01-01 10:00' },
    { name: 'CUST01', type: 'RPGLE', text: 'Customer', changed: '2026-10-02 09:00' },
    { name: 'SRC', type: '*FILE', attribute: 'PF-SRC', text: '' },
  ];
  assert.deepStrictEqual(p.applySubset(rows, { name: 'ORD*', type: 'RPGLE' }).map(r => r.name), ['ORD001']);
  assert.deepStrictEqual(p.applySubset(rows, { text: 'ORDER' }).map(r => r.name), ['ORD001', 'ORD002']);
  assert.deepStrictEqual(p.applySubset(rows, { since: '2026-10-01' }).map(r => r.name), ['ORD001', 'CUST01']);
  assert.deepStrictEqual(p.applySubset(rows, { type: 'PF-SRC' }).map(r => r.name), ['SRC']);
  assert.throws(() => p.applySubset(rows, { since: '01/10/2026' }));
  assert.strictEqual(p.positionTo(rows.slice(0, 3).sort((a, b) => a.name.localeCompare(b.name)), 'ORD'), 1);
});

test('option entries', () => {
  const valid = p.optionsFor('members').map(o => o.code);
  assert.deepStrictEqual(p.parseEntries([{ index: 3, option: ' 2' }, { index: 1, option: '14' }, { index: 2, option: '' }], valid), [{ index: 1, option: '14' }, { index: 3, option: '2' }]);
  assert.throws(() => p.parseEntries([{ index: 0, option: '99' }], valid), /99/);
  assert.ok(p.validUserOptionCode('CB', 'members'));
  assert.ok(!p.validUserOptionCode('14', 'members'));
  assert.ok(!p.validUserOptionCode('ABC', 'members'));
});

test('member and object commands', () => {
  assert.strictEqual(p.addMemberCommand('lib', 'qrpglesrc', 'ord1', 'rpgle', "It's new"), "ADDPFM FILE(LIB/QRPGLESRC) MBR(ORD1) TEXT('It''s new') SRCTYPE(RPGLE)");
  assert.strictEqual(p.renameMemberCommand('L', 'F', 'A', 'b'), 'RNMM FILE(L/F) MBR(A) NEWMBR(B)');
  assert.strictEqual(p.removeMemberCommand('L', 'F', 'A'), 'RMVM FILE(L/F) MBR(A)');
  assert.match(p.copyMemberCommand('L', 'F', 'A', 'L2', 'F2', 'B'), /^CPYSRCF FROMFILE\(L\/F\) TOFILE\(L2\/F2\) FROMMBR\(A\) TOMBR\(B\) MBROPT\(\*REPLACE\)$/);
  assert.strictEqual(p.changeMemberCommand('L', 'F', 'A', 'x', 'sqlrpgle'), "CHGPFM FILE(L/F) MBR(A) TEXT('x') SRCTYPE(SQLRPGLE)");
  assert.strictEqual(p.createModuleCommand('L', 'F', 'A', 'RPGLE', 'OBJ'), 'CRTRPGMOD MODULE(OBJ/A) SRCFILE(L/F) SRCMBR(A) DBGVIEW(*SOURCE)');
  assert.match(p.createModuleCommand('L', 'F', 'A', 'SQLRPGLE', 'OBJ'), /^CRTSQLRPGI OBJ\(OBJ\/A\) .*OBJTYPE\(\*MODULE\)/);
  assert.throws(() => p.createModuleCommand('L', 'F', 'A', 'DSPF', 'O'));
  assert.throws(() => p.renameMemberCommand('L', 'F', 'A', '1BAD'));
  assert.strictEqual(p.deleteObjectCommand('L', 'P', '*PGM'), 'DLTPGM PGM(L/P)');
  assert.strictEqual(p.deleteObjectCommand('L', 'X', '*SQLPKG'), 'DLTOBJ OBJ(L/X) OBJTYPE(*SQLPKG)');
  assert.throws(() => p.deleteObjectCommand('L', 'X', 'PGM) X('));
  assert.strictEqual(p.duplicateObjectCommand('A', 'P', '*PGM', 'B', 'Q'), 'CRTDUPOBJ OBJ(P) FROMLIB(A) OBJTYPE(*PGM) TOLIB(B) NEWOBJ(Q) DATA(*YES)');
  assert.strictEqual(p.createLibraryCommand('newlib', 'Test', true), "CRTLIB LIB(NEWLIB) TYPE(*TEST) TEXT('Test')");
});

test('user option substitution', () => {
  const v = { library: 'DEV', file: 'QRPGLESRC', name: 'ORD1', type: 'RPGLE', objectLibrary: 'OBJ', user: 'ME', text: 'x' };
  assert.strictEqual(p.substitutePdm(p.DEFAULT_USER_OPTIONS.CB, v), 'CRTBNDRPG PGM(OBJ/ORD1) SRCFILE(DEV/QRPGLESRC) SRCMBR(ORD1) DBGVIEW(*SOURCE)');
  assert.strictEqual(p.substitutePdm('X &&N &u &t', v), 'X &N ME RPGLE');
});

test('PDM commands typed on a command line', () => {
  assert.deepStrictEqual(p.parsePdmCommand('wrkmbrpdm file(dev/qrpglesrc) mbr(ord*)'), { level: 'members', library: 'DEV', file: 'QRPGLESRC', name: 'ORD*', type: undefined });
  assert.deepStrictEqual(p.parsePdmCommand('WRKMBRPDM QRPGLESRC'), { level: 'members', library: '*LIBL', file: 'QRPGLESRC', name: undefined, type: undefined });
  assert.deepStrictEqual(p.parsePdmCommand('WRKOBJPDM LIB(DEV) OBJTYPE(*PGM)'), { level: 'objects', library: 'DEV', name: undefined, type: '*PGM' });
  assert.deepStrictEqual(p.parsePdmCommand('WRKLIBPDM LIB(APP*)'), { level: 'libraries', name: 'APP*' });
  assert.deepStrictEqual(p.parsePdmCommand('STRPDM'), { level: 'libraries' });
  assert.strictEqual(p.parsePdmCommand('DSPLIBL'), undefined);
});

test('CSV export', () => {
  const csv = p.rowsToCsv([{ name: 'A', type: 'RPGLE', text: 'x, "y"', changed: '2026', size: 3 }], 'members');
  assert.strictEqual(csv, 'Member,Type,Text,Changed,Lines\nA,RPGLE,"x, ""y""",2026,3\n');
});
