const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/sqlFormat');

test('SQL formatter', () => {
  const f = v.formatSql("select a.x, count(*) as n from l/t a left join l/u b on a.k=b.k and a.z = 'it''s' where a.bal between 1 and 10 and a.q <> 'x' group by a.x order by 2 desc fetch first 5 rows only");
  assert.strictEqual(f, [
    'SELECT', '  a.x,', '  count(*) AS n', 'FROM l/t a', 'LEFT JOIN l/u b', '  ON a.k = b.k', "  AND a.z = 'it''s'",
    'WHERE a.bal BETWEEN 1 AND 10', "  AND a.q <> 'x'", 'GROUP BY', '  a.x', 'ORDER BY', '  2 DESC', 'FETCH FIRST 5 ROWS ONLY', ''].join('\n'));
  assert.match(v.formatSql('select * from x where k in (select k from y)'), /IN \(\n  SELECT\n    k\n  FROM y\n\)/);
  assert.match(v.formatSql("values 'select from where'"), /'select from where'/);
});
