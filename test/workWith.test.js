const test = require('node:test');
const assert = require('node:assert');
const w = require('../out/core/workWith');

test('job schedule entries are validated', () => {
  assert.strictEqual(w.addJobScheduleCommand({ name: 'nightly', command: 'CALL PGM(APP/NIGHT)', frequency: '*WEEKLY', days: ['*ALL'], time: '22:30' }),
    'ADDJOBSCDE JOB(NIGHTLY) CMD(CALL PGM(APP/NIGHT)) FRQ(*WEEKLY) SCDTIME(223000) SCDDATE(*NONE) SCDDAY(*ALL)');
  assert.match(w.addJobScheduleCommand({ name: 'MEND', command: 'X', frequency: '*MONTHLY', date: '*MONTHEND', time: '0100', text: "it's" }), /SCDDATE\(\*MONTHEND\).*TEXT\('it''s'\)/);
  assert.match(w.addJobScheduleCommand({ name: 'ONE', command: 'X', frequency: '*ONCE', time: '07:05' }), /SCDDATE\(\*CURRENT\)/);
  assert.throws(() => w.addJobScheduleCommand({ name: 'A', command: 'X', frequency: '*ONCE', time: '25:00' }), /HH:MM/);
  assert.throws(() => w.addJobScheduleCommand({ name: 'A', command: 'X', frequency: '*WEEKLY', days: [], time: '10:00' }), /days/);
  assert.throws(() => w.addJobScheduleCommand({ name: '1BAD', command: 'X', frequency: '*ONCE', time: '10:00' }), /valid/);
});

test('save and restore commands', () => {
  assert.strictEqual(w.saveCommand({ what: 'library', library: 'applib', savfLibrary: 'qgpl', savf: 'applib', targetRelease: 'V7R4M0', compress: true }),
    'SAVLIB LIB(APPLIB) DEV(*SAVF) SAVF(QGPL/APPLIB) TGTRLS(V7R4M0) DTACPR(*YES)');
  assert.strictEqual(w.saveCommand({ what: 'objects', library: 'APP', objects: ['ord*', 'CUSTMAST'], savfLibrary: 'QGPL', savf: 'S1', targetRelease: '*CURRENT' }),
    'SAVOBJ OBJ(ORD* CUSTMAST) LIB(APP) DEV(*SAVF) SAVF(QGPL/S1) OBJTYPE(*ALL)');
  assert.throws(() => w.saveCommand({ what: 'objects', library: 'APP', objects: [], savfLibrary: 'Q', savf: 'S' }), /at least one/);
  assert.strictEqual(w.restoreCommand({ what: 'library', savedLibrary: 'APP', savfLibrary: 'QGPL', savf: 'S1', restoreInto: 'APPCOPY' }),
    'RSTLIB SAVLIB(APP) DEV(*SAVF) SAVF(QGPL/S1) RSTLIB(APPCOPY)');
  assert.strictEqual(w.restoreCommand({ what: 'objects', savedLibrary: 'APP', objects: ['*ALL'], savfLibrary: 'QGPL', savf: 'S1', restoreInto: 'app' }),
    'RSTOBJ OBJ(*ALL) SAVLIB(APP) DEV(*SAVF) SAVF(QGPL/S1) OBJTYPE(*ALL)');
  assert.deepStrictEqual(w.targetReleases('7.5'), ['*CURRENT', '*PRV', 'V7R4M0', 'V7R3M0']);
  assert.deepStrictEqual(w.targetReleases(''), ['*CURRENT', '*PRV']);
});

test('audit journal SQL', () => {
  const sql = w.auditJournalSql(['af', 'PW'], 24, 'bob');
  assert.match(sql, /DISPLAY_JOURNAL\('QSYS', 'QAUDJRN'/);
  assert.match(sql, /JOURNAL_ENTRY_TYPES => 'AF PW'/);
  assert.match(sql, /JOB_USER = 'BOB'/);
  assert.throws(() => w.auditJournalSql([], 1), /entry type/);
  assert.throws(() => w.auditJournalSql(['AF'], 1, "x'"), /valid/);
  assert.ok(w.SYSTEM_VALUES.QSECURITY && w.AUDIT_TYPES.AF);
});

test('server status from listening ports and ENDTCPCNN', () => {
  const st = w.serverStatus([22, 8471, 446]);
  assert.ok(st.find(x => x.server === '*SSHD').listening);
  assert.deepStrictEqual(st.find(x => x.server === '*HOSTSVR').open, [8471]);
  assert.strictEqual(st.find(x => x.server === '*FTP').listening, false);
  assert.strictEqual(w.endConnectionCommand('10.0.0.5', 22, '10.0.0.9', 51234),
    "ENDTCPCNN PROTOCOL(*TCP) LCLINTNETA('10.0.0.5') LCLPORT(22) RMTINTNETA('10.0.0.9') RMTPORT(51234)");
  assert.throws(() => w.endConnectionCommand("1'; X", 1, '1.1.1.1', 2), /IP address/);
  assert.ok(w.isQualifiedJob('123456/QUSER/QZDASOINIT') && !w.isQualifiedJob('QZDASOINIT'));
});
