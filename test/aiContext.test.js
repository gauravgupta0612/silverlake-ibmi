const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/ai/context');
const p = require('../out/ai/prompts');

test('compile errors: snippets around each line, merged when close, message IDs', () => {
  const src = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
  const out = c.errorSnippets(src, [{ line: 5, message: 'x' }, { line: 7, message: 'y' }, { line: 25, message: 'z' }], 2);
  assert.strictEqual(out, ['  3| line3', '  4| line4', '>>5| line5', '  6| line6', '>>7| line7', '  8| line8', '  9| line9'].map(l => l.replace(/^(..)/, '$1 ')).join('\n') + '\n   …\n' + ['  23| line23', '  24| line24', '>>25| line25', '  26| line26', '  27| line27'].join('\n'));
  assert.deepStrictEqual(c.messageIds([{ line: 1, message: '', code: 'RNF7030' }, { line: 2, message: '', code: 'rnf7030' }, { line: 3, message: '', code: 'SQL0206' }, { line: 4, message: '', code: 'oops' }]), ['RNF7030', 'SQL0206']);
  assert.strictEqual(c.plainHelp('Cause . . :   A.&N Recovery:   B.&B one&B two'), 'Cause . . :   A.\nRecovery:   B.\n- one\n- two');
});

test('job log: failing user program, statement to line, model text', () => {
  const rows = [
    { id: 'CPF1124', type: 'INFORMATIONAL', severity: 0, text: 'Job started', fromLib: 'QSYS', fromPgm: 'QWTPIIPP' },
    { id: 'MCH1211', type: 'ESCAPE', severity: 40, text: 'Attempt made to divide by zero', fromLib: 'APP', fromPgm: 'ORDPGM', fromModule: 'ORDPGM', fromProc: 'calcTotal', fromStmt: '1200', toLib: 'APP', toPgm: 'ORDPGM' },
    { id: 'RNQ0102', type: 'INQUIRY', severity: 99, text: 'Attempt to divide by zero (C G D F).', fromLib: 'QSYS', fromPgm: 'QRNXIE', toLib: 'APP', toPgm: 'ORDPGM', toStmt: '1200' },
    { id: 'CPF9999', type: 'ESCAPE', severity: 40, text: 'Function check.', fromLib: 'QSYS', fromPgm: 'QMHUNMON' },
  ];
  const f = c.failingProgram(rows);
  assert.deepStrictEqual([f.lib, f.pgm, f.module, f.proc, f.stmt, f.message.id], ['APP', 'ORDPGM', 'ORDPGM', 'calcTotal', '1200', 'MCH1211']);
  // RPG runtime message sent TO the user program
  assert.strictEqual(c.failingProgram([rows[2]]).stmt, '1200');
  assert.strictEqual(c.failingProgram([rows[0], rows[3]]), undefined);
  assert.deepStrictEqual(c.lineForStatement('1200', [1, 2, 3, 10, 11, 12, 13], 7), { line: 6, how: 'statement 1200 = source sequence number 12.00' });
  assert.strictEqual(c.lineForStatement('1200', undefined, 40).line, 12);
  assert.strictEqual(c.lineForStatement('37', undefined, 40).line, 37);
  assert.strictEqual(c.lineForStatement('', undefined, 40).line, undefined);
  const w = c.sourceWindow('a\nb\nc\nd\ne', 3, 1);
  assert.strictEqual(w, '  2| b\n>>3| c\n  4| d');
  const m = c.jobLogForModel(rows.map(r => ({ ...r, help: r.id === 'MCH1211' ? 'Cause . . :   divisor 0.&N Recovery . . :   check it.' : '' })));
  assert.match(m, /^Most likely cause: MCH1211 Attempt made to divide by zero/);
  assert.match(m, /IBM help: Cause/);
  assert.match(m, /Last job log messages in order:\n.*CPF1124/);
});

test('spooled job log (QPJOBLOG) is parsed', () => {
  const spool = [
    '5770SS1 V7R5M0  220415                    Display Job Log                        DEV       10/15/26  10:00:02 CET     Page    1',
    ' Job name . . . . . . . . . . :   NIGHTLY         User  . . . . . . :   BATCH        Number . . . . . . . . . . . :   223456',
    'MSGID      TYPE                    SEV  DATE      TIME             FROM PGM     LIBRARY     INST     TO PGM      LIBRARY     INST',
    'CPF1124    Information             00   10/15/26  10:00:00.123456  QWTPIIPP    QSYS        0638     *EXT                    *N',
    '                                     Message . . . . :   Job 223456/BATCH/NIGHTLY started on 10/15/26 at',
    '                                       10:00:00 in subsystem QBATCH.',
    'MCH1211    Escape                  40   10/15/26  10:00:01.000000  ORDPGM      APP         *STMT    ORDPGM      APP         *STMT',
    '                                     From module . . . . . . . . :   ORDPGM',
    '                                     From procedure  . . . . . . :   CALCTOTAL',
    '                                     Statement . . . . . . . . . :   1200',
    '                                     To module . . . . . . . . . :   ORDPGM',
    '                                     To procedure  . . . . . . . :   CALCTOTAL',
    '                                     Statement . . . . . . . . . :   1200',
    '                                     Message . . . . :   Attempt made to divide by zero for fixed point',
    '                                       operation.',
    '                                     Cause . . . . . :   A fixed point divide by zero was attempted.',
  ].join('\n');
  const r = c.parseSpooledJobLog(spool);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual([r[0].id, r[0].type, r[0].severity, r[0].fromPgm, r[0].fromLib, r[0].toPgm], ['CPF1124', 'INFORMATION', 0, 'QWTPIIPP', 'QSYS', '*EXT']);
  assert.strictEqual(r[0].text, 'Job 223456/BATCH/NIGHTLY started on 10/15/26 at 10:00:00 in subsystem QBATCH.');
  assert.deepStrictEqual([r[1].id, r[1].fromLib, r[1].fromPgm, r[1].fromModule, r[1].fromProc, r[1].fromStmt, r[1].toStmt], ['MCH1211', 'APP', 'ORDPGM', 'ORDPGM', 'CALCTOTAL', '1200', '1200']);
  assert.strictEqual(r[1].text, 'Attempt made to divide by zero for fixed point operation.');
  assert.match(r[1].help, /^Cause: A fixed point/);
  assert.strictEqual(c.failingProgram(r).pgm, 'ORDPGM');
});

test('dependencies for the model', () => {
  const t = c.dependenciesForModel({ object: 'APP/ORDPGM', type: '*PGM', attribute: 'RPGLE', text: 'Order entry', activationGroup: '*CALLER',
    modules: [{ lib: 'APP', name: 'ORDPGM', attribute: 'RPGLE', source: 'APP/QRPGLESRC(ORDPGM)' }], servicePrograms: [{ lib: '*LIBL', name: 'UTILS', activation: '*IMMED' }],
    refs: [{ lib: '*LIBL', name: 'ORDHDR', type: '*FILE', usage: c.fileUsage('4') }, { lib: 'APP', name: 'PRICEPGM', type: '*PGM' }], usedBy: [] });
  assert.match(t, /^\*PGM APP\/ORDPGM \(RPGLE\) — Order entry\nActivation group: \*CALLER/);
  assert.match(t, /Modules bound in \(1\):\n- APP\/ORDPGM RPGLE from APP\/QRPGLESRC\(ORDPGM\)/);
  assert.match(t, /Files used \(1\):\n- \*LIBL\/ORDHDR \(update\)/);
  assert.match(t, /referenced \(1\):\n- APP\/PRICEPGM \*PGM/);
  assert.match(t, /Used by .*\(0\):\n- nothing found/);
});

test('new AI commands have instructions and default questions', () => {
  for (const cmd of ['errors', 'depends', 'joblog']) {
    assert.ok(p.COMMAND_HELP[cmd]);
    assert.ok(p.instructions(cmd).includes('Task: '));
    assert.notStrictEqual(p.defaultQuestion(cmd), 'Help me with this.');
  }
  assert.match(p.instructions('test'), /behaviours worth testing/);
});

test('tables in a query, dated changes', () => {
  assert.deepStrictEqual(c.tablesInSql("WITH T AS (SELECT * FROM APP.ORDERS) SELECT * FROM T JOIN cust C ON 1=1, TABLE(QSYS2.X()) Y JOIN QSYS2.SYSCOLUMNS Z ON 1=1 WHERE A = 'FROM FAKE.T'"),
    [{ library: 'APP', name: 'ORDERS' }, { name: 'CUST' }]);
  assert.deepStrictEqual(c.tablesInSql('select * from app/x'), [{ library: 'APP', name: 'X' }]);
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const d = c.datedChanges(lines, [1, 1, 261020, 1, 1, 1, 1, 1, 261020, 1], 261020, 1);
  assert.strictEqual(d, '@@ line 2 @@\n      2| b\n>>    3| c\n      4| d\n@@ line 8 @@\n      8| h\n>>    9| i\n     10| j');
  assert.strictEqual(c.datedChanges(lines, [], 1), '');
});
