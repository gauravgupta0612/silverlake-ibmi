const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/storage');

test('storage advisor helpers', () => {
  assert.strictEqual(v.formatBytes(0), '0 B');
  assert.strictEqual(v.formatBytes(1536), '1.5 KB');
  assert.strictEqual(v.formatBytes(5 * 1024 ** 3), '5.0 GB');
  const r = v.reorgCandidates([{ n: 'A', rows: 100, deleted: 50000 }, { n: 'B', rows: 1e7, deleted: 20000 }, { n: 'C', rows: 10, deleted: 100 }]);
  assert.deepStrictEqual(r.map(t => t.n), ['A']);
  assert.strictEqual(v.reorgCommand('app', 'ordhist'), 'RGZPFM FILE(APP/ORDHIST) REUSEDLT(*NO)');
  assert.strictEqual(v.deleteCommand('APP', 'OLDPGM', '*PGM'), 'DLTPGM PGM(APP/OLDPGM)');
  assert.strictEqual(v.deleteCommand('APP', 'X', '*SQLPKG'), 'DLTOBJ OBJ(APP/X) OBJTYPE(*SQLPKG)');
  const adv = v.receiverAdvice([
    { library: 'J', name: 'R1', status: 'SAVED', detached: '2026-01-01 10:00:00', size: 10 },
    { library: 'J', name: 'R2', status: 'ONLINE', detached: '2026-01-01 10:00:00', size: 20 },
    { library: 'J', name: 'R3', status: 'ATTACHED', size: 99 },
    { library: 'J', name: 'R4', status: 'SAVED', detached: '2026-10-01 10:00:00', size: 5 },
  ], new Date('2026-10-11T00:00:00'), 30);
  assert.deepStrictEqual(adv.map(a => [a.name, a.advice]), [['R2', 'save first'], ['R1', 'delete']]);
});
