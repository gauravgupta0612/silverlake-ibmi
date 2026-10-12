const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/core/secadm');
const r = require('../out/core/robust');

test('*SECADM detection and password redaction', () => {
  assert.ok(s.hasSecadm('*JOBCTL *SECADM'));
  assert.ok(s.hasSecadm('*NONE', ['*ALLOBJ *SECADM']));
  assert.ok(!s.hasSecadm('*ALLOBJ *JOBCTL', ['*NONE']));
  assert.strictEqual(s.redactPasswords("CRTUSRPRF USRPRF(BOB) PASSWORD('S3cr''et') PWDEXP(*YES)"), 'CRTUSRPRF USRPRF(BOB) PASSWORD(*****) PWDEXP(*YES)');
  assert.strictEqual(s.redactPasswords('CHGUSRPRF USRPRF(A) PASSWORD(abc123)'), 'CHGUSRPRF USRPRF(A) PASSWORD(*****)');
  assert.doesNotMatch(s.redactPasswords("CHGPWD OLDPWD(x) NEWPWD('y z')"), /y z/);
  assert.ok(!r.isReadOnlyCommand("CRTUSRPRF USRPRF(BOB) PASSWORD('x')"));
});

test('user profile commands', () => {
  assert.strictEqual(s.createProfileCommand({ user: 'jdoe', password: 'Temp1234', passwordExpired: true, userClass: '*PGMR', specialAuthorities: ['*JOBCTL'], groupProfile: 'devgrp', currentLibrary: 'devlib', text: "John O'Doe" }),
    "CRTUSRPRF USRPRF(JDOE) PASSWORD('Temp1234') PWDEXP(*YES) USRCLS(*PGMR) SPCAUT(*JOBCTL) GRPPRF(DEVGRP) CURLIB(DEVLIB) TEXT('John O''Doe')");
  assert.strictEqual(s.createProfileCommand({ user: 'SVCACCT', password: '', specialAuthorities: [] }), 'CRTUSRPRF USRPRF(SVCACCT) PASSWORD(*NONE) SPCAUT(*NONE)');
  assert.throws(() => s.createProfileCommand({ user: 'QBAD' }), /reserved/);
  assert.throws(() => s.createProfileCommand({ user: 'A', specialAuthorities: ['*GODMODE'] }), /Unknown special/);
  assert.throws(() => s.createProfileCommand({ user: 'A', password: "it's" }), /Quotes/);
  assert.strictEqual(s.changeProfileCommand({ user: 'JDOE', status: '*DISABLED' }), 'CHGUSRPRF USRPRF(JDOE) STATUS(*DISABLED)');
  assert.strictEqual(s.changeProfileCommand({ user: 'JDOE', initialProgram: 'app/menu', initialMenu: '*SIGNOFF', passwordExpirationInterval: -1 }),
    'CHGUSRPRF USRPRF(JDOE) INLPGM(APP/MENU) INLMNU(*SIGNOFF) PWDEXPITV(*NOMAX)');
  assert.throws(() => s.changeProfileCommand({ user: 'JDOE' }), /Nothing/);
  assert.strictEqual(s.deleteProfileCommand('jdoe', { newOwner: 'qdftown' }), 'DLTUSRPRF USRPRF(JDOE) OWNOBJOPT(*CHGOWN QDFTOWN) PGPOPT(*NOCHG)');
  assert.strictEqual(s.deleteProfileCommand('JDOE', '*DLT'), 'DLTUSRPRF USRPRF(JDOE) OWNOBJOPT(*DLT) PGPOPT(*NOCHG)');
  const copy = s.specFromExisting({ USER_CLASS_NAME: '*PGMR', SPECIAL_AUTHORITIES: '*JOBCTL *SPLCTL', GROUP_PROFILE_NAME: 'DEVGRP', SUPPLEMENTAL_GROUP_LIST: 'TESTGRP', OWNER: '*GRPPRF',
    CURRENT_LIBRARY_NAME: 'DEVLIB', INITIAL_PROGRAM_NAME: '*NONE', INITIAL_MENU_LIBRARY_NAME: '*LIBL', INITIAL_MENU_NAME: 'MAIN', LIMIT_CAPABILITIES: '*NO', JOB_DESCRIPTION_LIBRARY_NAME: 'QGPL', JOB_DESCRIPTION_NAME: 'QDFTJOBD' }, 'NEWBIE');
  assert.strictEqual(s.createProfileCommand({ ...copy, password: '' }),
    'CRTUSRPRF USRPRF(NEWBIE) PASSWORD(*NONE) USRCLS(*PGMR) SPCAUT(*JOBCTL *SPLCTL) GRPPRF(DEVGRP) OWNER(*GRPPRF) SUPGRPPRF(TESTGRP) CURLIB(DEVLIB) INLPGM(*NONE) INLMNU(*LIBL/MAIN) LMTCPB(*NO) JOBD(QGPL/QDFTJOBD)');
});

test('unused profiles and authorization lists', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  const idle = s.inactiveProfiles([
    { user: 'ANN', status: '*ENABLED', lastSignon: '2026-10-01 08:00' },
    { user: 'BOB', status: '*ENABLED', lastSignon: '2026-01-01 08:00' },
    { user: 'NEW', status: '*ENABLED', created: '2025-01-01 08:00' },
    { user: 'OLD', status: '*DISABLED', lastSignon: '2020-01-01 08:00' },
    { user: 'QSYSOPR', status: '*ENABLED', lastSignon: '2020-01-01 08:00' },
  ], now, 90);
  assert.deepStrictEqual(idle.map(x => x.user), ['NEW', 'BOB']);
  assert.strictEqual(s.createAutlCommand('payroll', 'Payroll'), "CRTAUTL AUTL(PAYROLL) TEXT('Payroll') AUT(*EXCLUDE)");
  assert.strictEqual(s.addAutlEntryCommand('PAYROLL', 'hr', '*change'), 'ADDAUTLE AUTL(PAYROLL) USER(HR) AUT(*CHANGE)');
  assert.strictEqual(s.changeAutlEntryCommand('PAYROLL', '*PUBLIC', '*USE'), 'CHGAUTLE AUTL(PAYROLL) USER(*PUBLIC) AUT(*USE)');
  assert.strictEqual(s.removeAutlEntryCommand('PAYROLL', 'HR'), 'RMVAUTLE AUTL(PAYROLL) USER(HR)');
});
