const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// VS Code refuses to activate an extension that registers the same command twice.
test('every command is registered exactly once and declared', () => {
  const files = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.ts$/.test(e.name) && files.push(path.join(d, e.name))));
  walk(path.join(__dirname, '..', 'src'));
  const ids = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:registerCommand|registerTextEditorCommand|\breg)\(\s*'(vanthrex\.[A-Za-z0-9_.]+)'/g)) { ids.push(m[1]); }
  }
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepStrictEqual([...new Set(dup)], [], 'registered twice');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map(c => c.command);
  const dupDecl = declared.filter((x, i) => declared.indexOf(x) !== i);
  assert.deepStrictEqual([...new Set(dupDecl)], [], 'declared twice in package.json');
  const used = new Set(ids);
  const missing = declared.filter(c => !used.has(c));
  assert.deepStrictEqual(missing, [], 'declared but never registered');
});
