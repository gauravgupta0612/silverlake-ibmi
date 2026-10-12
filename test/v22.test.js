const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v22');

test('hard-coded libraries', () => {
  const src = "**FREE\ndcl-f cust extfile('PRODLIB/CUSTMAST');\n// APPLIB/X comment\nexec sql select * from devlib/orders o join qsys2/systables t on 1=1;\nx = 10/12/2026;\ny = a/b;\nz = 'QTEMP/WORK';";
  assert.deepStrictEqual(v.findHardcodedLibraries(src).map(h => h.library), ['PRODLIB', 'DEVLIB']);
  assert.deepStrictEqual(v.findHardcodedLibraries('PGM\n CALL PGM(APPLIB/ORDENT)\n CPYF FROMFILE(*LIBL/X) TOFILE(QTEMP/Y)\nENDPGM').map(h => [h.line, h.library, h.object]), [[1, 'APPLIB', 'ORDENT']]);
  assert.deepStrictEqual(v.findHardcodedLibraries("x = 'PRODLIB/CUST';", ['PRODLIB']), []);
});

test('unused RPG code', () => {
  const src = "**FREE\ndcl-s used int(10);\ndcl-s dead int(10);\ndcl-c K 5;\ndcl-pr ext extpgm('X');\nend-pr;\ndcl-proc foo;\n exsr sub1;\n used = 1;\nend-proc;\ndcl-proc bar export;\n foo();\nend-proc;\ndcl-proc lonely;\nend-proc lonely;\nbegsr sub1;\nendsr;\nbegsr sub2;\nendsr;\n";
  assert.deepStrictEqual(v.unusedRpg(src).map(u => `${u.kind}:${u.name}`), ['variable:dead', 'constant:K', 'prototype:ext', 'procedure:lonely', 'subroutine:sub2']);
});

test('table structure compare and ALTER script', () => {
  const a = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NAME', type: 'VARCHAR', length: 50, scale: 0, nullable: false },
    { name: 'BAL', type: 'DECIMAL', length: 11, scale: 2, nullable: true, dflt: '0' }];
  const b = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NAME', type: 'VARCHAR', length: 30, scale: 0, nullable: false }, { name: 'OLD', type: 'CHARACTER', length: 1, scale: 0, nullable: true }];
  const d = v.compareStructure(a, b);
  assert.deepStrictEqual(d.map(x => `${x.column}:${x.status}`), ['NAME:different', 'BAL:only in A', 'OLD:only in B']);
  assert.strictEqual(d[0].a, 'VARCHAR(50) NOT NULL'); assert.strictEqual(d[0].b, 'VARCHAR(30) NOT NULL');
  const sql = v.alterScript('prod', 'cust', a, d);
  assert.match(sql, /ALTER TABLE PROD\/CUST ALTER COLUMN "NAME" SET DATA TYPE VARCHAR\(50\);/);
  assert.match(sql, /ALTER TABLE PROD\/CUST ADD COLUMN "BAL" DECIMAL\(11,2\) DEFAULT 0;/);
  assert.match(sql, /-- ALTER TABLE PROD\/CUST DROP COLUMN "OLD";/);
});

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
