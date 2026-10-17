const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/tableCompare');

test('table structure compare and ALTER script', () => {
  const a = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NAME', type: 'VARCHAR', length: 50, scale: 0, nullable: false },
    { name: 'BAL', type: 'DECIMAL', length: 11, scale: 2, nullable: true, dflt: '0' }];
  const b = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NAME', type: 'VARCHAR', length: 30, scale: 0, nullable: false }, { name: 'OLD', type: 'CHARACTER', length: 1, scale: 0, nullable: true }];
  const d = v.compareStructure(a, b);
  assert.deepStrictEqual(d.map(x => `${x.column}:${x.status}`), ['NAME:different', 'BAL:only in A', 'OLD:only in B']);
  assert.strictEqual(d[0].a, 'VARCHAR(50) NOT NULL'); assert.strictEqual(d[0].b, 'VARCHAR(30) NOT NULL');
  const sql = v.alterScript('prod', 'cust', a, d);
  assert.match(sql, /ALTER TABLE PROD\/CUST ALTER COLUMN "NAME" SET DATA TYPE VARCHAR\(50\);/);
  assert.match(sql, /ALTER TABLE PROD\/CUST ADD COLUMN "BAL" DECIMAL\(11,2\) DEFAULT 0;/);
  assert.match(sql, /-- ALTER TABLE PROD\/CUST DROP COLUMN "OLD";/);
});
