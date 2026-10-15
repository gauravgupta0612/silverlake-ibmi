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

test('robustness helpers', () => {
  assert.strictEqual(p.clError('', 'qsh: 001-0055 Error found\nCPF3220: Cannot do operation on file X.\n'), 'CPF3220: Cannot do operation on file X.');
  assert.strictEqual(p.clError('CPC2191: Object deleted.\nCPF2105: Object not found.', ''), 'CPF2105: Object not found.');
  assert.strictEqual(p.clError('', ''), 'The command failed.');
  assert.ok(p.changesSomething('members', '4', []) && p.changesSomething('members', 'CB', ['CB']) && !p.changesSomething('members', '2', []));
  assert.strictEqual(p.printMemberCommand('L', 'F', 'M'), 'CPYSRCF FROMFILE(L/F) TOFILE(*PRINT) FROMMBR(M)');
  assert.ok(p.DEFAULT_USER_OPTIONS.RS.startsWith('RUNSQLSTM'));
});

test('compile status', () => {
  const pgm = [{ type: '*PGM', created: '2026-10-01-10.00.00.000000' }];
  assert.strictEqual(p.objectStatus('RPGLE', '2026-10-02-08.00.00.000000', pgm), 'stale');
  assert.strictEqual(p.objectStatus('RPGLE', '2026-09-30-08.00.00', pgm), 'current');
  assert.strictEqual(p.objectStatus('RPGLE', '2026-09-30-08.00.00', []), 'none');
  assert.strictEqual(p.objectStatus('DSPF', '2026-09-30-08.00.00', pgm), 'none');
  assert.strictEqual(p.objectStatus('RPGLEINC', '2026-09-30', pgm), '');
  assert.strictEqual(p.objectStatus('', '2026-09-30', pgm), '');
  assert.strictEqual(p.objectStatus('SQLRPGLE', '2026-10-02 08:00:00', [{ type: '*MODULE', created: '2026-10-01-10.00.00' }, { type: '*PGM', created: '2026-10-03-10.00.00' }]), 'current');
});

test('subset by compile status and locks, type counts', () => {
  const rows = [{ name: 'A', type: 'RPGLE', text: '', objStatus: 'stale' }, { name: 'B', type: 'RPGLE', text: '', objStatus: 'current', lockedBy: '1/U/J' }, { name: 'C', type: 'CLLE', text: '', objStatus: 'none' }];
  assert.deepStrictEqual(p.applySubset(rows, { needsCompile: true }).map(r => r.name), ['A', 'C']);
  assert.deepStrictEqual(p.applySubset(rows, { locked: true }).map(r => r.name), ['B']);
  assert.deepStrictEqual(p.typeCounts(rows), [['RPGLE', 2], ['CLLE', 1]]);
});

test('several source files', () => {
  assert.ok(p.isMultiFile('*ALL') && p.isMultiFile('q*src') && !p.isMultiFile('QRPGLESRC') && !p.isMultiFile(undefined));
  assert.strictEqual(p.likePattern('*ALL'), '%');
  assert.strictEqual(p.likePattern('q*src'), 'Q%SRC');
  assert.throws(() => p.likePattern("A' OR 1=1"));
  assert.ok(p.optionsFor('libraries').some(o => o.code === 'AM'));
});
