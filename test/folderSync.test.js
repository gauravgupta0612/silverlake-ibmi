const test = require('node:test');
const assert = require('node:assert');
const f = require('../out/core/folderSync');

test('compare a local folder with an IFS folder', () => {
  const rows = f.compareFolders(
    [{ rel: 'a', size: 1, mtimeMs: 1000 }, { rel: 'b', size: 2, mtimeMs: 9000 }, { rel: 'c', size: 3, mtimeMs: 1000 }, { rel: 'd', size: 1, mtimeMs: 1000 }, { rel: 'e', size: 1, mtimeMs: 1000 }],
    [{ rel: 'a', size: 1, mtimeMs: 2500 }, { rel: 'b', size: 2, mtimeMs: 1000 }, { rel: 'c', size: 4, mtimeMs: 1500 }, { rel: 'd', size: 1, mtimeMs: 99000 }, { rel: 'z', size: 1, mtimeMs: 1 }]);
  assert.deepStrictEqual(rows.map(r => `${r.rel}:${r.status}`), ['b:localNewer', 'd:ifsNewer', 'c:different', 'e:onlyLocal', 'z:onlyIfs', 'a:same']);
});

test('archive commands', () => {
  const tools = { zip: false, unzip: true, jar: true };
  assert.strictEqual(f.archiveKind('x.TAR.GZ'), 'tgz'); assert.strictEqual(f.archiveKind('a.jar'), 'zip'); assert.strictEqual(f.archiveKind('a.txt'), undefined);
  assert.strictEqual(f.extractCommand('/h/a b.zip', '/h/a b', tools), "mkdir -p '/h/a b' && cd '/h/a b' && unzip -o '/h/a b.zip'");
  assert.strictEqual(f.extractCommand('/h/x.zip', '/h/x', { zip: false, unzip: false, jar: true }), "mkdir -p '/h/x' && cd '/h/x' && jar xf '/h/x.zip'");
  assert.match(f.extractCommand('/h/x.tgz', '/h/x', tools), /gzip -dc '\/h\/x.tgz' \| tar -xf -$/);
  assert.strictEqual(f.extractCommand('/h/log.gz', '/h', tools), "gzip -dc '/h/log.gz' > '/h/log'");
  assert.throws(() => f.extractCommand('/h/x.zip', '/h/x', { zip: false, unzip: false, jar: false }), /Neither unzip nor jar/);
  assert.throws(() => f.extractCommand('/h/x.txt', '/h', tools), /not an archive/);
  assert.strictEqual(f.compressCommand(['/h/src', "/h/it's.txt"], '/h/out.zip', tools), "cd '/h' && jar cMf '/h/out.zip' 'src' 'it'\\''s.txt'");
  assert.strictEqual(f.compressCommand(['/h/src'], '/h/s.tar.gz', tools), "cd '/h' && tar -cf - 'src' | gzip -c > '/h/s.tar.gz'");
  assert.throws(() => f.compressCommand(['/a/x', '/b/y'], '/a/z.zip', tools), /one folder/);
});
