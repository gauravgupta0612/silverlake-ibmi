const test = require('node:test');
const assert = require('node:assert');
const r = require('../out/core/robust');

test('read-only command classification', () => {
  for (const c of ['DSPPGMREF PGM(APP/*ALL) OUTPUT(*OUTFILE) OUTFILE(QTEMP/REFS)', 'RTVMBRD FILE(A/B)', 'CHKOBJ OBJ(QSYS/QCMD) OBJTYPE(*PGM)',
    "CPYTOSTMF FROMMBR('/QSYS.LIB/A.LIB/F.FILE/M.MBR') TOSTMF('/tmp/slk_BOB_1.txt') STMFOPT(*REPLACE)", 'CRTPF FILE(QTEMP/WORK) RCDLEN(80)',
    'CHGJOB LOG(4 00 *SECLVL)', 'STRDBMON OUTFILE(QTEMP/MON) JOB(*)']) {
    assert.ok(r.isReadOnlyCommand(c), c);
  }
  for (const c of ['CHGJOB JOB(123456/BOB/X) JOBPTY(1)', 'CALL PGM(APP/X)', 'DLTF FILE(APP/OLD)', 'CPYF FROMFILE(QTEMP/W) TOFILE(APP/SRC)',
    "CPYTOSTMF FROMMBR('/QSYS.LIB/A.LIB/F.FILE/M.MBR') TOSTMF('/home/bob/x.txt')", 'ENDSBS SBS(QBATCH)', 'CRTSAVF FILE(QGPL/S)']) {
    assert.ok(!r.isReadOnlyCommand(c), c);
  }
});

test('changing SQL classification', () => {
  for (const s of ['SELECT * FROM A/B', 'with x as (values 1) select * from x', 'VALUES 1', 'CREATE OR REPLACE ALIAS QTEMP/SLKA1 FOR APP/SRC(MBR)',
    'DROP TABLE QTEMP/SLKW1', 'INSERT INTO QTEMP/SLKW1 (A) VALUES (1)', "CALL QSYS2.QCMDEXC('DSPPGMREF PGM(A/*ALL) OUTPUT(*OUTFILE) OUTFILE(QTEMP/R)')",
    'DECLARE GLOBAL TEMPORARY TABLE X (A INT)']) {
    assert.ok(!r.isChangingSql(s), s);
  }
  for (const s of ['UPDATE APP/CUST SET A = 1 WHERE B = 2', 'DELETE FROM APP/CUST WITH NC', "CALL QSYS2.QCMDEXC('DLTF FILE(APP/X)')",
    'CREATE INDEX APP/IX1 ON APP/CUST (A)', 'CALL QSYS2.SEND_DATA_QUEUE(MESSAGE_DATA => \'x\', DATA_QUEUE => \'Q\', DATA_QUEUE_LIBRARY => \'L\')', 'merge into app/t using x on 1=1 when matched then delete']) {
    assert.ok(r.isChangingSql(s), s);
  }
  assert.ok(r.isTempPath('/tmp/slk_BOB_abc.txt') && !r.isTempPath('/tmp/other.txt') && !r.isTempPath('/home/bob/slk_x'));
});

test('plain-language error hints', () => {
  assert.match(r.explainError('SQL0204 ACTIVE_QUERY_INFO in QSYS2 type *N not found.'), /PTF group/);
  assert.match(r.explainError('[SQL0204] CUSTMAST in APPLIB type *FILE not found.'), /library list/);
  assert.match(r.explainError('SQL0551: Not authorized to object ORDERS in APP type *FILE.'), /Check Authority/);
  assert.match(r.explainError('SQL7008 ORDERS in APP not valid for operation.'), /WITH NC/);
  assert.match(r.explainError('Error: All configured authentication methods failed'), /password/);
  assert.match(r.explainError('/QOpenSys/usr/bin/sh: java: not found'), /Java 11/);
  assert.match(r.explainError('Read-only connection: PROD is protected'), /Protection/);
  assert.strictEqual(r.explainError('Everything is fine'), undefined);
});

test('self-check evaluation and service catalog', () => {
  const res = r.evaluateSelfCheck({ qsh: true, sqlEngine: 'Mapepire (SSH)', javaVersion: 'openjdk version "1.8.0_391"', ccsid: 65535, homeWritable: false,
    missingLibraries: ['OLDLIB'], release: '7.3', specialAuthorities: '*NONE', rpgUnit: false, debugService: true });
  const by = a => res.find(x => x.area === a);
  assert.strictEqual(by('QSH / CL commands').ok, true);
  assert.strictEqual(by('Java').ok, 'warn');
  assert.strictEqual(by('CCSID').ok, 'warn');
  assert.match(by('Library list').detail, /OLDLIB/);
  assert.strictEqual(by('IBM i release').ok, 'warn');
  assert.strictEqual(by('Special authorities').ok, 'warn');
  assert.strictEqual(r.evaluateSelfCheck({ sqlEngine: 'not started' })[1].ok, false);
  assert.strictEqual(r.evaluateSelfCheck({ javaVersion: 'openjdk version "17.0.2"' }).find(x => x.area === 'Java').ok, true);
  const miss = r.missingServices(r.SERVICES.filter(s => s.name !== 'SAVE_FILE_OBJECTS').map(s => `${s.schema}.${s.name}`));
  assert.deepStrictEqual(miss.map(m => m.name), ['SAVE_FILE_OBJECTS']);
});
