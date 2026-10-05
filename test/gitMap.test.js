const test = require('node:test');
const assert = require('node:assert');
const { repoPath, parseRepoPath, textHash, normaliseSource, planUpload, planDownload, emptyState, parseGitLog } = require('../out/git/gitMap');

test('member <-> repository path', () => {
  const m = { lib: 'MYLIB', file: 'QRPGLESRC', member: 'ORDENTRY', type: 'RPGLE' };
  assert.strictEqual(repoPath(m), 'mylib/qrpglesrc/ordentry.rpgle');
  assert.deepStrictEqual(parseRepoPath('mylib/qrpglesrc/ordentry.rpgle'), m);
  assert.deepStrictEqual(parseRepoPath('mylib\\qclsrc\\start.clle'), { lib: 'MYLIB', file: 'QCLSRC', member: 'START', type: 'CLLE' });
  assert.strictEqual(parseRepoPath('README.md'), undefined);
  assert.strictEqual(parseRepoPath('.vanthrex/x/sync.json'), undefined);
  assert.strictEqual(parseRepoPath('mylib/qrpglesrc/a-very-long-member-name.rpgle'), undefined);
});

test('hash ignores line endings and trailing blanks', () => {
  assert.strictEqual(textHash('a  \r\nb\r\n\r\n'), textHash('a\nb'));
  assert.notStrictEqual(textHash('a\nb'), textHash('a\nc'));
  assert.strictEqual(normaliseSource('x \n\n'), 'x\n');
});

function stateWith(members) {
  const s = emptyState('host', 'DEV');
  for (const [rel, changed, text] of members) {
    s.members[rel] = { ...parseRepoPath(rel), changed, hash: textHash(text) };
  }
  return s;
}

test('upload plan: changed, new and conflicting files', () => {
  const s = stateWith([['l/f/a.rpgle', 't1', 'A'], ['l/f/b.rpgle', 't1', 'B'], ['l/f/c.rpgle', 't1', 'C']]);
  const local = new Map([['l/f/a.rpgle', textHash('A2')], ['l/f/b.rpgle', textHash('B')], ['l/f/c.rpgle', textHash('C2')], ['l/f/d.rpgle', textHash('D')]]);
  const remote = new Map([['l/f/a.rpgle', 't1'], ['l/f/c.rpgle', 't2']]);
  assert.deepStrictEqual(planUpload(s, local, remote), { changed: ['l/f/a.rpgle'], added: ['l/f/d.rpgle'], conflicts: ['l/f/c.rpgle'] });
});

test('download plan: changed on IBM i, new there, conflicts and removed', () => {
  const s = stateWith([['l/f/a.rpgle', 't1', 'A'], ['l/f/b.rpgle', 't1', 'B'], ['l/f/gone.rpgle', 't1', 'G']]);
  const remote = new Map([
    ['l/f/a.rpgle', { changed: 't2' }], ['l/f/b.rpgle', { changed: 't2' }], ['l/f/new.rpgle', { changed: 't1' }],
  ]);
  const local = new Map([['l/f/a.rpgle', textHash('A')], ['l/f/b.rpgle', textHash('B-edited')]]);
  assert.deepStrictEqual(planDownload(s, remote, local), { changed: ['l/f/a.rpgle'], added: ['l/f/new.rpgle'], conflicts: ['l/f/b.rpgle'], removed: ['l/f/gone.rpgle'] });
});

test('git log parsing', () => {
  assert.deepStrictEqual(parseGitLog('abc\tGaurav Gupta\t2026-10-05 10:00\tFix\ttabs\n'), [{ sha: 'abc', author: 'Gaurav Gupta', date: '2026-10-05 10:00', subject: 'Fix\ttabs' }]);
});
