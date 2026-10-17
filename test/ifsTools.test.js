const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/ifsTools'),
  ...require('../out/core/jobTools'),
  ...require('../out/core/objectCommands'),
};

test('IFS search command and parsing', () => {
  const c = v.ifsGrepCommand('/home/bob', "it's", { include: '*.rpgle', max: 10 });
  assert.match(c, /^\/QOpenSys\/usr\/bin\/find '\/home\/bob' -type f -name '\*\.rpgle' -exec \/QOpenSys\/usr\/bin\/grep -nFi -e 'it'\\''s' \/dev\/null \{\} \+/);
  assert.match(c, /head -n 10$/);
  assert.throws(() => v.ifsGrepCommand('home', 'x'), /absolute/);
  assert.deepStrictEqual(v.parseGrep('/home/a.txt:12:hello: world\nnoise\n/x/b:3:x'), [{ file: '/home/a.txt', line: 12, text: 'hello: world' }, { file: '/x/b', line: 3, text: 'x' }]);
});

test('ccsid commands and stack line', () => {
  assert.strictEqual(v.tagCcsidCommand("/home/a'b", 1208, true), "CHGATR OBJ('/home/a''b') ATR(*CCSID) VALUE(1208) SUBTREE(*ALL)");
  assert.throws(() => v.tagCcsidCommand('rel', 1208, false));
  assert.throws(() => v.tagCcsidCommand('/a', 0, false));
  assert.match(v.convertCcsidCommand('/a.txt', 1208), /TOCCSID\(1208\) DTAFMT\(\*TEXT\)/);
  assert.strictEqual(v.stackLine({ PROGRAM_LIBRARY_NAME: 'APP', PROGRAM_NAME: 'ORD01', PROCEDURE_NAME: 'calc', STATEMENT_IDENTIFIERS: '120 121' }), 'APP/ORD01 calc (statement 120)');
});

test('create library and IFS', () => {
  assert.strictEqual(v.createSourceFileCommand('dev', 'qrpglesrc', 'RPG'), "CRTSRCPF FILE(DEV/QRPGLESRC) RCDLEN(112) TEXT('RPG')");
  assert.throws(() => v.createSourceFileCommand('1BAD', 'X', ''));
  assert.strictEqual(v.checkIfsPath(' /home/me/app/ '), '/home/me/app');
  for (const bad of ['rel/x', '/a/../b', '/a//b', '/a/./b']) { assert.throws(() => v.checkIfsPath(bad), bad); }
  assert.strictEqual(v.checkMode('755'), '755'); assert.throws(() => v.checkMode('999')); assert.throws(() => v.checkMode('rwx'));
});
