const test = require('node:test');
const assert = require('node:assert');
const d = require('../out/core/localDev');

test('deploy: ignore patterns and changed files', () => {
  assert.ok(d.matchesIgnore('.git/config', []));
  assert.ok(d.matchesIgnore('node_modules/x/y.js', ['node_modules/']));
  assert.ok(d.matchesIgnore('src/sub/app.log', ['*.log']));
  assert.ok(d.matchesIgnore('build/out/a.o', ['build/**']));
  assert.ok(!d.matchesIgnore('qrpglesrc/ord01.rpgle', d.DEFAULT_IGNORE));
  assert.ok(d.matchesIgnore('secrets/.env', d.DEFAULT_IGNORE));
  const files = [{ rel: 'a.rpgle', size: 10, mtimeMs: 5 }, { rel: 'b.clle', size: 3, mtimeMs: 9 }, { rel: 'x.log', size: 1, mtimeMs: 1 }];
  const plan = d.planDeploy(files, { 'a.rpgle': { size: 10, mtimeMs: 5 }, 'old.rpgle': { size: 1, mtimeMs: 1 } }, ['*.log']);
  assert.deepStrictEqual(plan, { upload: ['b.clle'], unchanged: 1, removed: ['old.rpgle'] });
  assert.deepStrictEqual(d.planDeploy(files, { 'a.rpgle': { size: 10, mtimeMs: 5 } }, ['*.log'], true).upload, ['a.rpgle', 'b.clle']);
});

test('deploy folder, paths, build command', () => {
  assert.strictEqual(d.deployDirectory('', { home: '/home/BOB', user: 'BOB', folder: 'my app' }), '/home/BOB/builds/my_app');
  assert.strictEqual(d.deployDirectory('/build/${user}/${folder}', { home: '/home/x', user: 'BOB', folder: 'app' }), '/build/bob/app');
  assert.throws(() => d.deployDirectory('/home/${user}/../x', { home: '/h', user: 'b', folder: 'f' }), /not allowed/);
  assert.throws(() => d.deployDirectory('/QOpenSys', { home: '/h', user: 'b', folder: 'f' }), /not allowed/);
  assert.throws(() => d.deployDirectory('relative', { home: '/h', user: 'b', folder: 'f' }), /absolute/);
  assert.strictEqual(d.remotePathFor('/d/', 'src\\a.rpgle'), '/d/src/a.rpgle');
  assert.throws(() => d.remotePathFor('/d', '../etc/passwd'));
  assert.strictEqual(d.localRelFor('/d', '/d/src/a.rpgle'), 'src/a.rpgle');
  assert.strictEqual(d.localRelFor('/d', '/other/a'), undefined);
  assert.deepStrictEqual(d.foldersToCreate('/d', ['a/b/c.rpgle', 'a/x.clle', 'top.sql']), ['/d/a', '/d/a/b']);
  const cmd = d.buildShellCommand('makei build', "/d/it's", { curlib: 'MYLIB', libl: ['A', 'B'] });
  assert.match(cmd, /export CURLIB='MYLIB'/);
  assert.match(cmd, /cd '\/d\/it'\\''s' && makei build$/);
  assert.throws(() => d.buildShellCommand(' ', '/d', {}));
  assert.strictEqual(d.shellStartup('/home/bob', true), "export PATH=/QOpenSys/pkgs/bin:$PATH && cd '/home/bob'\n");
  assert.strictEqual(d.shellStartup(undefined, false), '');
  const p = d.buildProblems('*RNF7030 30 1 x\nCPF0001 failed\ngmake: *** [all] Error 1');
  assert.deepStrictEqual(p, { messages: ['RNF7030', 'CPF0001'], failed: true });
});
