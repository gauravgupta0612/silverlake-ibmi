const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/compileHistory');

const rec = (uri, ok, at = '2026-10-15T10:00:00Z') => ({ at, system: 'S', uri, name: uri, object: 'O/' + uri, ok, errors: ok ? 0 : 2, warnings: 0, command: 'C' });

test('compile history', () => {
  let l = [];
  l = v.addCompile(l, rec('A', false)); l = v.addCompile(l, rec('B', true)); l = v.addCompile(l, rec('A', true)); l = v.addCompile(l, rec('C', false));
  assert.deepStrictEqual(v.latestPerSource(l).map(r => [r.uri, r.ok]), [['C', false], ['A', true], ['B', true]]);
  assert.deepStrictEqual(v.compileSummary(l), { total: 4, failed: 2, rate: 50, brokenNow: 1 });
  for (let i = 0; i < 300; i++) { l = v.addCompile(l, rec('X' + i, true)); }
  assert.strictEqual(l.length, v.HISTORY_SIZE);
});

test('last compile day', () => {
  assert.strictEqual(v.dayOf('2026-10-05-11.00.00.000000'), '2026-10-05');
  assert.strictEqual(v.dayOf('nope'), undefined);
  assert.strictEqual(v.lastCompileDay([{ created: '2026-09-01-10.00.00' }, { created: '2026-10-05 11:00:00' }, {}]), '2026-10-05');
  assert.strictEqual(v.lastCompileDay([]), undefined);
});
