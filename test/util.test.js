const test = require('node:test');
const assert = require('node:assert');
const u = require('../out/core/util');

test('system names', () => {
  assert.ok(u.isValidSystemName('QGPL'));
  assert.ok(u.isValidSystemName('#MY$LIB'));
  assert.ok(!u.isValidSystemName('1LIB'));
  assert.ok(!u.isValidSystemName('TOOLONGNAME1'));
  assert.throws(() => u.assertSystemName('bad name'));
});

test('quoting', () => {
  assert.strictEqual(u.sqlString("O'Brien"), "'O''Brien'");
  assert.strictEqual(u.shDoubleQuote('CALL PGM(X) PARM("$a")'), '"CALL PGM(X) PARM(\\"\\$a\\")"');
  assert.strictEqual(u.shSingleQuote("it's"), "'it'\\''s'");
});

test('member path parsing', () => {
  assert.deepStrictEqual(u.parseMemberPath('/mylib/qrpglesrc/hello.rpgle'),
    { library: 'MYLIB', file: 'QRPGLESRC', member: 'HELLO', extension: 'rpgle' });
  assert.strictEqual(u.memberPath('a', 'b', 'c'), '/QSYS.LIB/A.LIB/B.FILE/C.MBR');
  assert.throws(() => u.parseMemberPath('/a/b'));
});

test('variable substitution keeps &OBJLIB intact', () => {
  const s = u.substituteVariables('CRTBNDRPG PGM(&OBJLIB/&NAME) SRCFILE(&LIB/&SRCFILE)',
    { LIB: 'SRC', OBJLIB: 'OBJ', NAME: 'HELLO', SRCFILE: 'QRPGLESRC' });
  assert.strictEqual(s, 'CRTBNDRPG PGM(OBJ/HELLO) SRCFILE(SRC/QRPGLESRC)');
});

test('object name from IFS file', () => {
  assert.strictEqual(u.objectNameFromFile('/home/me/order_entry.pgm.rpgle'), 'ORDER_ENTR');
  assert.strictEqual(u.objectNameFromFile('hello.sqlrpgle'), 'HELLO');
});

test('SQL splitting ignores ; in strings and comments', () => {
  const text = "select 'a;b' from x; -- c;\nselect 2 from y /* ; */;\n\n";
  const st = u.splitSqlStatements(text);
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[0].sql, "select 'a;b' from x");
  assert.ok(st[1].sql.includes('select 2 from y'));
  assert.strictEqual(u.statementAtOffset(text, 3), "select 'a;b' from x");
  assert.ok(u.statementAtOffset(text, text.indexOf('select 2') + 2).includes('select 2'));
});

test('destructive SQL detection', () => {
  assert.ok(u.isDestructiveSql('DELETE FROM T'));
  assert.ok(u.isDestructiveSql('  drop table x'));
  assert.ok(!u.isDestructiveSql('DELETE FROM T WHERE A = 1'));
  assert.ok(!u.isDestructiveSql('SELECT * FROM T'));
});

test('CSV', () => {
  assert.strictEqual(u.toCsv(['A', 'B'], [{ A: 'x,y', B: null }, { A: 'q"', B: 3 }]), 'A,B\r\n"x,y",\r\n"q""",3');
});
