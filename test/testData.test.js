const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/testData');

test('test data respects types, lengths and keys', () => {
  const cols = [
    { name: 'ID', type: 'DECIMAL', length: 7, scale: 0, nullable: false, pk: true },
    { name: 'CODE', type: 'CHARACTER', length: 4, scale: 0, nullable: false },
    { name: 'AMT', type: 'DECIMAL', length: 5, scale: 2, nullable: false },
    { name: 'D', type: 'DATE', length: 4, scale: 0, nullable: false },
    { name: 'N', type: 'INTEGER', length: 4, scale: 0, nullable: false },
  ];
  const rows = v.testRows(cols, 50, 1000, 7);
  assert.strictEqual(rows.length, 50);
  assert.deepStrictEqual(rows.slice(0, 3).map(r => r[0]), ['1001', '1002', '1003']);
  assert.ok(rows.every(r => r[1].length <= 4 && /^\d{1,3}(\.\d{1,2})?$/.test(r[2]) && /^\d{4}-\d{2}-\d{2}$/.test(r[3]) && /^\d+$/.test(r[4])));
  assert.deepStrictEqual(v.testRows(cols, 3, 0, 7), v.testRows(cols, 3, 0, 7)); // deterministic
  const r = v.seeded(1); const a = r(); assert.ok(a >= 0 && a < 1);
});
