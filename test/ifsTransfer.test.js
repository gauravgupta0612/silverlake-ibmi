const test = require('node:test');
const assert = require('node:assert');
const t = require('../out/core/ifsTransfer');

test('folder transfer plan, names, sizes', () => {
  assert.strictEqual(t.joinIfs('/home/bob/', 'a\\b.txt'), '/home/bob/a/b.txt');
  assert.strictEqual(t.joinIfs('/', 'x'), '/x');
  assert.throws(() => t.joinIfs('/home', '../etc'));
  assert.strictEqual(t.baseName('C:\\Users\\me\\proj\\'), 'proj');
  const plan = t.planTransfer([
    { rel: 'a/b', isDirectory: true, size: 0 }, { rel: 'a', isDirectory: true, size: 0 }, { rel: 'a/b/x.txt', isDirectory: false, size: 10 },
    { rel: '.git/HEAD', isDirectory: false, size: 1 }, { rel: 'big.bin', isDirectory: false, size: 100 },
  ], r => r.startsWith('.git'), 50);
  assert.deepStrictEqual(plan, { folders: ['a', 'a/b'], files: [{ rel: 'a/b/x.txt', size: 10 }], skipped: ['.git/HEAD', 'big.bin'], bytes: 10 });
  assert.strictEqual(t.freeName('r.txt', new Set(['r.txt', 'r (2).txt'])), 'r (3).txt');
  assert.strictEqual(t.freeName('dir', new Set()), 'dir');
  assert.strictEqual(t.formatBytes(1536), '1.5 KB');
});
