const test = require('node:test');
const assert = require('node:assert');
const m = require('../out/core/moreTools');

const cols = [
  { name: 'CUSTOMER_NUMBER', system: 'CUSTNO', type: 'DECIMAL', length: 7, scale: 0, nullable: false, text: 'Customer number' },
  { name: 'NAME', system: 'NAME', type: 'CHARACTER', length: 30, scale: 0, nullable: false },
  { name: 'NOTE', system: 'NOTE', type: 'VARCHAR', length: 200, scale: 0, nullable: true },
  { name: 'OPENED', system: 'OPENED', type: 'DATE', length: 4, scale: 0, nullable: true },
  { name: 'QTY', system: 'QTY', type: 'INTEGER', length: 4, scale: 0, nullable: false },
];

test('RPG types and generated code', () => {
  assert.deepStrictEqual(cols.map(m.rpgType), ['packed(7:0)', 'char(30)', 'varchar(200)', 'date(*iso)', 'int(10)']);
  const code = m.rpgForTable('APP', 'CUSTMAST', cols, ['CUSTOMER_NUMBER']);
  assert.match(code, /dcl-ds custmast_t qualified template;/);
  assert.match(code, /custno\s+packed\(7:0\); \/\/ Customer number/);
  assert.match(code, /dcl-proc getCustmast export;/);
  assert.match(code, /where "CUSTOMER_NUMBER" = :custno;/);
  assert.match(code, /insert into APP\/CUSTMAST \("CUSTOMER_NUMBER", "NAME", "NOTE", "OPENED", "QTY"\)/);
  assert.match(code, /set "NAME" = :row\.name,/);
  assert.match(code, /declare c_custmast cursor for/);
  assert.throws(() => m.rpgForTable('A', 'T', [], []), /no columns/);
});

test('SQL formatter', () => {
  const f = m.formatSql("select a.x, count(*) as n from l/t a left join l/u b on a.k=b.k and a.z = 'it''s' where a.bal between 1 and 10 and a.q <> 'x' group by a.x order by 2 desc fetch first 5 rows only");
  assert.strictEqual(f, [
    'SELECT', '  a.x,', '  count(*) AS n', 'FROM l/t a', 'LEFT JOIN l/u b', '  ON a.k = b.k', "  AND a.z = 'it''s'",
    'WHERE a.bal BETWEEN 1 AND 10', "  AND a.q <> 'x'", 'GROUP BY', '  a.x', 'ORDER BY', '  2 DESC', 'FETCH FIRST 5 ROWS ONLY', ''].join('\n'));
  assert.match(m.formatSql('select * from x where k in (select k from y)'), /IN \(\n  SELECT\n    k\n  FROM y\n\)/);
  assert.match(m.formatSql("values 'select from where'"), /'select from where'/);
});

test('submit and watch helpers', () => {
  assert.strictEqual(m.submittedJob('CPC1221: Job 123456/BOB/NIGHTLY submitted to job queue QBATCH in library QGPL.'), '123456/BOB/NIGHTLY');
  assert.strictEqual(m.submittedJob('nothing'), undefined);
  assert.strictEqual(m.sbmjobCommand('CALL PGM(APP/X)', 'night', 'qbatch'), 'SBMJOB CMD(CALL PGM(APP/X)) JOB(NIGHT) JOBQ(QBATCH)');
  assert.throws(() => m.sbmjobCommand('X', '1bad'), /valid job/);
  assert.deepStrictEqual(['JOBQ', 'ACTIVE', 'OUTQ', 'X'].map(m.jobPhase), ['queued', 'running', 'ended', 'unknown']);
});

test('replace across members and library sets', () => {
  const re = m.buildPattern('custno', { regex: false, matchCase: false, wholeWord: true });
  const r = m.replaceLines(['     C     CUSTNO    CHAIN     CUSTMAST', 'dcl-s custnoX int(10);', 'x = custno + 1;', 'very long CUSTNO line'], re, 'CUSTID', 80);
  assert.deepStrictEqual(r.changed, [0, 2, 3]);
  assert.strictEqual(r.lines[0], '     C     CUSTID    CHAIN     CUSTMAST');
  assert.strictEqual(r.lines[1], 'dcl-s custnoX int(10);');
  assert.deepStrictEqual(r.tooLong, []);
  assert.deepStrictEqual(m.replaceLines(['A'.repeat(18) + ' X'], m.buildPattern('X', { regex: false, matchCase: true, wholeWord: true }), 'LONGER', 20).tooLong, [0]);
  assert.throws(() => m.buildPattern('(', { regex: true, matchCase: false, wholeWord: false }), /Invalid regular/);
  assert.deepStrictEqual(m.parseLibraryList('applib, utilib  applib qgpl'), ['APPLIB', 'UTILIB', 'QGPL']);
  assert.throws(() => m.parseLibraryList('ok 9bad'), /9BAD/);
});
