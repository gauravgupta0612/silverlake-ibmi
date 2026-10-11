const test = require('node:test');
const assert = require('node:assert');
const a = require('../out/core/admin');

test('journal entries pair before and after images and summarise who changed what', () => {
  const e = (seq, type, rrn, user, data, program = 'APP/ORDUPD') => ({ seq: String(seq), time: `2026-10-11 10:0${seq}:00`, type, rrn: String(rrn), user, job: `1/${user}/J`, program, data });
  const changes = a.pairJournalEntries([
    e(1, 'PT', 5, 'BOB', 'NEW ROW'),
    e(2, 'UB', 7, 'ANN', 'CUST 100 OPEN '),
    e(3, 'UP', 7, 'ANN', 'CUST 100 CLOSE'),
    e(4, 'DL', 9, 'ANN', 'OLD ROW'),
  ]);
  assert.deepStrictEqual(changes.map(c => c.action), ['added', 'updated', 'deleted']);
  assert.strictEqual(changes[1].before, 'CUST 100 OPEN ');
  assert.strictEqual(changes[1].after, 'CUST 100 CLOSE');
  const who = a.summarizeChanges(changes);
  assert.deepStrictEqual(who[0], { user: 'ANN', program: 'APP/ORDUPD', added: 0, updated: 1, deleted: 1, last: '2026-10-11 10:04:00' });
  assert.deepStrictEqual(a.diffImages('CUST 100 OPEN ', 'CUST 100 CLOSE'), ['pos 10: "OPEN" → "CLOSE"']);
});

test('journal SQL filters by table, time, user and row', () => {
  const sql = a.journalSql({ journalLibrary: 'APP', journal: 'QSQJRN', library: 'APP', table: 'ORDERS', hours: 24, user: "o'neil", rrn: 42 });
  assert.match(sql, /QSYS2\.DISPLAY_JOURNAL\('APP', 'QSQJRN'/);
  assert.match(sql, /CURRENT TIMESTAMP - 24 HOURS/);
  assert.match(sql, /OBJECT_NAME => 'ORDERS'/);
  assert.match(sql, /JOB_USER = 'O''NEIL'/);
  assert.match(sql, /COUNT_OR_RRN = 42/);
  assert.doesNotMatch(sql, /ENTRY_DATA/);
  assert.match(a.journalSql({ journalLibrary: 'A', journal: 'J', library: 'A', table: 'T', hours: 1, withData: true }), /ENTRY_DATA/);
});

test('authority is resolved in IBM i order', () => {
  const privs = [{ name: '*PUBLIC', authority: '*USE' }, { name: 'DEVGRP', authority: '*CHANGE' }, { name: 'TEMP', authority: '*EXCLUDE' }];
  const change = a.NEEDS.change.flags;
  assert.strictEqual(a.resolveAuthority({ user: 'SEC', specialAuthorities: '*ALLOBJ *SECADM', groups: [] }, privs, change).allowed, true);
  const temp = a.resolveAuthority({ user: 'TEMP', specialAuthorities: '', groups: ['DEVGRP'] }, privs, a.NEEDS.use.flags);
  assert.strictEqual(temp.allowed, false); // private *EXCLUDE wins over the group
  assert.match(temp.source, /private/);
  const dev = a.resolveAuthority({ user: 'ANN', specialAuthorities: '', groups: ['DEVGRP'] }, privs, change);
  assert.ok(dev.allowed && /group/.test(dev.source));
  const pub = a.resolveAuthority({ user: 'BOB', specialAuthorities: '', groups: [] }, privs, change);
  assert.strictEqual(pub.source, '*PUBLIC');
  assert.deepStrictEqual(pub.missing, ['ADD', 'UPD', 'DLT']);
  const viaList = a.resolveAuthority({ user: 'BOB', specialAuthorities: '', groups: [] }, [{ name: '*PUBLIC', authority: '*AUTL' }], change,
    [{ name: 'BOB', authority: '*CHANGE' }], 'PAYROLL');
  assert.ok(viaList.allowed && /PAYROLL/.test(viaList.source));
  const userDef = a.resolveAuthority({ user: 'X', specialAuthorities: '', groups: [] },
    [{ name: 'X', authority: 'USER DEF', flags: { OBJOPR: true, READ: true } }], a.NEEDS.use.flags);
  assert.deepStrictEqual(userDef.missing, ['EXECUTE']);
  assert.strictEqual(a.grantCommand('APP', 'ORDERS', '*FILE', 'BOB', '*CHANGE'), 'GRTOBJAUT OBJ(APP/ORDERS) OBJTYPE(*FILE) USER(BOB) AUT(*CHANGE)');
});

test('data area values are validated before CHGDTAARA', () => {
  assert.strictEqual(a.changeDataAreaCommand('APP', 'NEXTNO', { type: '*DEC', length: 7, decimals: 2 }, '12345.67'), 'CHGDTAARA DTAARA(APP/NEXTNO) VALUE(12345.67)');
  assert.throws(() => a.changeDataAreaCommand('APP', 'NEXTNO', { type: '*DEC', length: 7, decimals: 2 }, '123456'), /too large/);
  assert.throws(() => a.changeDataAreaCommand('APP', 'NEXTNO', { type: '*DEC', length: 7, decimals: 2 }, '1.234'), /decimal/);
  assert.strictEqual(a.changeDataAreaCommand('APP', 'FLAG', { type: '*LGL', length: 1, decimals: 0 }, '1'), "CHGDTAARA DTAARA(APP/FLAG) VALUE('1')");
  assert.strictEqual(a.changeDataAreaCommand('APP', 'CFG', { type: '*CHAR', length: 6, decimals: 0 }, "O'K"), "CHGDTAARA DTAARA(APP/CFG (1 6)) VALUE('O''K   ')");
  assert.throws(() => a.changeDataAreaCommand('APP', 'CFG', { type: '*CHAR', length: 2, decimals: 0 }, 'ABC'), /holds 2/);
  assert.strictEqual(a.printable('A\u0000B'), 'A·B');
});

test('health findings put problems first', () => {
  const f = a.healthFindings({
    aspUsedPercent: 91.2,
    groups: [{ id: 'SF99960', title: 'DB2 FOR IBM I', installed: 5, available: 7, currency: 'UPDATE AVAILABLE' }, { id: 'SF99959', title: 'JAVA', installed: 3, available: 3, currency: 'INSTALLED LEVEL IS CURRENT' }],
    pendingPtfs: [{ ptf: 'SI12345', product: '5770SS1', action: 'TEMPORARILY APPLIED', ipl: 'DELAYED' }],
    expiringCerts: [{ label: 'WEB', ends: '2026-11-01', days: 21 }],
    defaultPasswords: 0, disabledProfiles: 3,
  });
  assert.strictEqual(f[0].level, 'bad');
  assert.ok(f.some(x => x.area === 'PTF groups' && /SF99960/.test(x.text) && x.level === 'bad'));
  assert.ok(f.some(x => x.area === 'Pending PTFs' && x.level === 'warn'));
  assert.ok(f.some(x => x.area === 'Certificates' && /21 d/.test(x.text)));
  assert.strictEqual(f[f.length - 1].level, 'ok');
  assert.ok(a.healthFindings({ aspUsedPercent: 50 })[0].level === 'ok');
});
