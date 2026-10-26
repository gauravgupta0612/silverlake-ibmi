const test = require('node:test');
const assert = require('node:assert');
const t = require('../out/core/tableSearch');
const cols = [{ name: 'ID', type: 'DECIMAL', length: 7, scale: 0, nullable: false }, { name: 'NAME', type: 'CHARACTER', length: 20, scale: 0, nullable: true },
  { name: 'BORN', type: 'DATE', length: 10, scale: 0, nullable: true }, { name: 'PIC', type: 'BLOB', length: 100, scale: 0, nullable: true }];

test('search a value in every column', () => {
  const p = t.searchSql('APP/CUST', cols, "o'50%");
  assert.deepStrictEqual(p.searched, ['NAME', 'BORN']); assert.deepStrictEqual(p.skipped, ['ID', 'PIC']);
  assert.match(p.sql, /UPPER\("NAME"\) LIKE '%O''50\\%%' ESCAPE '\\'/);
  assert.match(p.sql, /^SELECT RRN\(T\) AS VX_RRN, CASE WHEN .* THEN 'NAME' WHEN .* THEN 'BORN' END AS VX_MATCH, T\.\* FROM APP\/CUST T WHERE/);
  const n = t.searchSql('APP/CUST', cols, '42', { max: 10, exact: true });
  assert.match(n.sql, /\("ID" = 42\)/); assert.match(n.sql, /UPPER\("NAME"\) = '42'/); assert.match(n.sql, /FETCH FIRST 10 ROWS/);
  assert.throws(() => t.searchSql('A/B', cols, ' '), /Type the value/);
  assert.throws(() => t.searchSql('A/B', [cols[3]], 'x'), /No column/);
});

test('rows as an INSERT script', () => {
  const s = t.insertScript('APP.CUST', cols, [{ ID: 1, NAME: "O'Hara   ", BORN: '1990-01-02', PIC: 'x' }, { ID: '2', NAME: null, BORN: null }], { header: 'from DEV\n2 rows', batch: 2 });
  assert.strictEqual(s, "-- from DEV\n-- 2 rows\n\nINSERT INTO APP.CUST (\"ID\", \"NAME\", \"BORN\")\n  VALUES (1, 'O''Hara', DATE('1990-01-02')),\n         (2, NULL, NULL) WITH NC;\n");
});
