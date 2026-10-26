const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/core/sqlErrorLog');

test('SELF codes, log query, grouping', () => {
  assert.strictEqual(s.selfCodesValue(' *err '), '*ERR');
  assert.strictEqual(s.selfCodesValue('-204 -803,+100'), '-204, -803, 100');
  assert.throws(() => s.selfCodesValue('abc'), /not an SQL code/);
  assert.throws(() => s.selfCodesValue(''), /Give/);
  assert.strictEqual(s.systemWideSql('*all'), "CREATE OR REPLACE VARIABLE SYSIBMADM.SELFCODES VARCHAR(256) DEFAULT '*ALL'");
  const q = s.errorLogSql({ hours: 2, user: 'bob', program: 'ordpgm', sqlcode: -204 }, 50);
  assert.match(q, /CURRENT TIMESTAMP - 2 HOURS/); assert.match(q, /LIKE '%\/BOB\/%'/); assert.match(q, /PROGRAM_NAME = 'ORDPGM'/); assert.match(q, /LOGGED_SQLCODE = -204/); assert.match(q, /FETCH FIRST 50 ROWS/);
  assert.doesNotMatch(s.errorLogSql({ hours: 0 }), /WHERE/);
  assert.throws(() => s.errorLogSql({ user: "x' OR 1=1" }), /Invalid user/);
  assert.strictEqual(s.sqlMessageId(-204), 'SQL0204'); assert.strictEqual(s.sqlMessageId(100), 'SQL0100'); assert.strictEqual(s.sqlMessageId(-7008), 'SQL7008');
  const rows = [
    { LOGGED: '2026-10-01 10:00:00', SQLCODE: -204, STMT: 'SELECT * FROM X', PGMLIB: 'APP', PGM: 'P1', JOB: '1/A/B' },
    { LOGGED: '2026-10-01 11:00:00', SQLCODE: -204, STMT: 'SELECT  *  FROM X', PGMLIB: 'APP', PGM: 'P1', JOB: '2/A/B' },
    { LOGGED: '2026-10-01 09:00:00', SQLCODE: -803, STMT: 'INSERT', PGMLIB: '', PGM: '', JOB: '1/A/B' },
  ].map(s.toLoggedError);
  assert.strictEqual(rows[0].program, 'APP/P1');
  const g = s.groupErrors(rows);
  assert.deepStrictEqual(g.map(x => [x.messageId, x.count, x.jobs, x.last]), [['SQL0204', 2, 2, '2026-10-01 11:00:00'], ['SQL0803', 1, 1, '2026-10-01 09:00:00']]);
  assert.match(s.describeSelfCodes('*ERR'), /error/); assert.match(s.describeSelfCodes(null), /Off/); assert.match(s.describeSelfCodes('-204'), /-204/);
});
