const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/protection');

test('read-only command classification', () => {
  for (const c of ['DSPPGMREF PGM(APP/*ALL) OUTPUT(*OUTFILE) OUTFILE(QTEMP/REFS)', 'RTVMBRD FILE(A/B)', 'CHKOBJ OBJ(QSYS/QCMD) OBJTYPE(*PGM)',
    "CPYTOSTMF FROMMBR('/QSYS.LIB/A.LIB/F.FILE/M.MBR') TOSTMF('/tmp/slk_BOB_1.txt') STMFOPT(*REPLACE)", 'CRTPF FILE(QTEMP/WORK) RCDLEN(80)',
    'CHGJOB LOG(4 00 *SECLVL)', 'STRDBMON OUTFILE(QTEMP/MON) JOB(*)']) {
    assert.ok(v.isReadOnlyCommand(c), c);
  }
  for (const c of ['CHGJOB JOB(123456/BOB/X) JOBPTY(1)', 'CALL PGM(APP/X)', 'DLTF FILE(APP/OLD)', 'CPYF FROMFILE(QTEMP/W) TOFILE(APP/SRC)',
    "CPYTOSTMF FROMMBR('/QSYS.LIB/A.LIB/F.FILE/M.MBR') TOSTMF('/home/bob/x.txt')", 'ENDSBS SBS(QBATCH)', 'CRTSAVF FILE(QGPL/S)']) {
    assert.ok(!v.isReadOnlyCommand(c), c);
  }
});

test('changing SQL classification', () => {
  for (const s of ['SELECT * FROM A/B', 'with x as (values 1) select * from x', 'VALUES 1', 'CREATE OR REPLACE ALIAS QTEMP/SLKA1 FOR APP/SRC(MBR)',
    'DROP TABLE QTEMP/SLKW1', 'INSERT INTO QTEMP/SLKW1 (A) VALUES (1)', "CALL QSYS2.QCMDEXC('DSPPGMREF PGM(A/*ALL) OUTPUT(*OUTFILE) OUTFILE(QTEMP/R)')",
    'DECLARE GLOBAL TEMPORARY TABLE X (A INT)']) {
    assert.ok(!v.isChangingSql(s), s);
  }
  for (const s of ['UPDATE APP/CUST SET A = 1 WHERE B = 2', 'DELETE FROM APP/CUST WITH NC', "CALL QSYS2.QCMDEXC('DLTF FILE(APP/X)')",
    'CREATE INDEX APP/IX1 ON APP/CUST (A)', 'CALL QSYS2.SEND_DATA_QUEUE(MESSAGE_DATA => \'x\', DATA_QUEUE => \'Q\', DATA_QUEUE_LIBRARY => \'L\')', 'merge into app/t using x on 1=1 when matched then delete']) {
    assert.ok(v.isChangingSql(s), s);
  }
  assert.ok(v.isTempPath('/tmp/slk_BOB_abc.txt') && !v.isTempPath('/tmp/other.txt') && !v.isTempPath('/home/bob/slk_x'));
});
