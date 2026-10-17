const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/systemCommands'),
  ...require('../out/core/ifsTools'),
};

test('IFS, journal, message queue and PTF helpers', () => {
  assert.strictEqual(v.chgautCommand('/home/app', 'devgrp', '*rx', true), "CHGAUT OBJ('/home/app') USER(DEVGRP) DTAAUT(*RX) OBJAUT(*NONE) SUBTREE(*ALL)");
  assert.throws(() => v.chgautCommand('home', 'X', '*RX', false), /start with/);
  assert.throws(() => v.chgautCommand('/x', 'X', '*FULL', false), /Unknown/);
  assert.strictEqual(v.chgownCommand("/home/o'k", 'bob', false), "CHGOWN OBJ('/home/o''k') NEWOWN(BOB) RVKOLDAUT(*YES)");
  assert.strictEqual(v.chgjrnCommand('app', 'qsqjrn'), 'CHGJRN JRN(APP/QSQJRN) JRNRCV(*GEN)');
  assert.match(v.strjrnlibCommand('APP', 'APP', 'QSQJRN'), /^STRJRNLIB LIB\(APP\) JRN\(APP\/QSQJRN\)/);
  assert.strictEqual(v.removeMessageCommand('QSYS', 'QSYSOPR', '0000abcd'), "RMVMSG MSGQ(QSYS/QSYSOPR) MSGKEY(X'0000ABCD')");
  assert.strictEqual(v.sendMessageCommand('QUSRSYS', 'BOB', "It's done", false), "SNDMSG MSG('It''s done') TOMSGQ(QUSRSYS/BOB)");
  assert.deepStrictEqual(v.parsePtfIds('Please install si84519, SI84521 and SI84519 (MF12345)'), ['SI84519', 'SI84521', 'MF12345']);
});

test('library list of a job description', () => {
  assert.deepStrictEqual(v.parseLibraryList('APPLIB     QGPL       QTEMP      '), { libraries: ['APPLIB', 'QGPL', 'QTEMP'] });
  assert.deepStrictEqual(v.parseLibraryList('*SYSVAL'), { libraries: [], special: '*SYSVAL' });
  assert.deepStrictEqual(v.libraryListChange(['A', 'B'], ['B', 'C']), { added: ['C'], removed: ['A'], same: false });
  assert.ok(v.libraryListChange(['a'], ['A']).same);
});

test('system values on two systems', () => {
  const d = v.diffSystemValues({ QSECURITY: '40', QDATE: '1', QCCSID: '65535' }, { QSECURITY: '30', QDATE: '2', QCCSID: '65535 ' });
  assert.deepStrictEqual(d.map(x => [x.name, x.same]), [['QDATE', false], ['QSECURITY', false], ['QCCSID', true]]);
  assert.ok(v.EXPECTED_DIFFERENT.test('QDATE') && !v.EXPECTED_DIFFERENT.test('QSECURITY'));
});
