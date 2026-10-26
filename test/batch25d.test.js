const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/core/converters');
const k = require('../out/core/codes');
const f = require('../out/core/flow');
const m = require('../out/core/modernize');
const q = require('../out/core/dataQuality');

test('packed, zoned and binary', () => {
  assert.strictEqual(c.toPacked('-123.45', 7, 2), '0012345D');
  assert.strictEqual(c.toPacked('5', 4, 0), '00005C');
  assert.strictEqual(c.fromPacked('0012345D', 2), '-123.45');
  assert.strictEqual(c.fromPacked("X'00005C'"), '5');
  assert.strictEqual(c.toZoned('-12', 3), 'F0F1D2');
  assert.strictEqual(c.fromZoned('F0F1D2'), '-12');
  assert.strictEqual(c.toBinary('-1', 4), 'FFFFFFFF');
  assert.strictEqual(c.fromBinary('FFFE'), '-2');
  assert.strictEqual(c.fromBinary('FFFE', false), '65534');
  assert.throws(() => c.toPacked('12345', 3), /does not fit/);
  assert.throws(() => c.toPacked('1.234', 5, 2), /decimal/);
  assert.throws(() => c.fromPacked('12G4'));
  assert.throws(() => c.toBinary('40000', 2));
});

test('dates in every IBM i format', () => {
  assert.strictEqual(c.parseDate('1260331').how, '*CYMD');
  assert.deepStrictEqual(c.parseDate('0991231').date, { y: 1999, m: 12, d: 31 });
  assert.deepStrictEqual(c.parseDate('2026090').date, { y: 2026, m: 3, d: 31 });
  assert.deepStrictEqual(c.parseDate('31.03.2026').date, { y: 2026, m: 3, d: 31 });
  assert.deepStrictEqual(c.parseDate('03/31/26').date, { y: 2026, m: 3, d: 31 });
  assert.deepStrictEqual(c.parseDate('26/090').date, { y: 2026, m: 3, d: 31 });
  assert.throws(() => c.parseDate('2026-02-30'));
  const all = Object.fromEntries(c.dateFormats({ y: 2026, m: 3, d: 31 }));
  assert.strictEqual(all['*CYMD'], '1260331'); assert.strictEqual(all['*JUL'], '26/090'); assert.strictEqual(all['Day of week'], 'Tuesday');
  assert.strictEqual(Object.fromEntries(c.dateFormats({ y: 1960, m: 1, d: 5 }))['*CYMD'], '0600105');
  assert.strictEqual(Object.fromEntries(c.dateFormats({ y: 2050, m: 1, d: 5 }))['*MDY'], undefined);
});

test('timestamps and epoch', () => {
  const t = Object.fromEntries(c.timestampFormats('2026-03-31-14.05.00.123456'));
  assert.strictEqual(t['Epoch seconds'], '1774965900');
  assert.strictEqual(Object.fromEntries(c.timestampFormats('1774965900'))['IBM i (SQL / RPG *ISO)'], '2026-03-31-14.05.00.000000');
  assert.throws(() => c.timestampFormats('yesterday'));
});

test('EBCDIC SQL is guarded', () => {
  assert.match(c.textToHexSql("it's", 37), /CAST\('it''s' AS VARCHAR\(4000\) CCSID 37\)/);
  assert.match(c.hexToTextSql('c1 c2', 297), /X'C1C2'.*CCSID 297/);
  assert.throws(() => c.hexToTextSql("C1'--", 37));
  assert.throws(() => c.textToHexSql('a', 'x'));
  assert.strictEqual(c.hexDump('C1C2C3C4C5'), '0000  C1C2C3C4 C5');
});

test('SQLCODE, SQLSTATE and RPG status explained', () => {
  assert.strictEqual(k.explainAny('-803')[0].other, 'SQLSTATE 23505');
  assert.strictEqual(k.explainAny('SQL0204')[0].code, '-204');
  assert.match(k.explainAny("SQLSTATE '23505'")[0].text, /Duplicate key/);
  assert.match(k.explainAny('RNQ1218')[0].text, /locked/);
  assert.match(k.explainAny('00907')[0].text, /Decimal data/);
  assert.match(k.explainSqlcode(-9999).text, /SQL9999/);
  assert.match(k.explainSqlcode(466).text, /warning/);
  assert.strictEqual(k.codeAt('if sqlcode = -803;', 15).code.code, '-803');
  assert.strictEqual(k.codeAt("if sqlstate = '02000';", 16).code.kind, 'SQLSTATE');
  assert.strictEqual(k.codeAt('if %status(cust) = 1218;', 21).code.code, '01218');
  assert.strictEqual(k.codeAt('x = 1218;', 5), undefined);
});

const RPG = `**free
read cust;
dow not %eof(cust);
  if bal > 100;
    send();
  elseif bal < 0;
    leave;
  else;
    x = 1;
  endif;
  read cust;
enddo;
select;
when a = 1;
  b();
other;
  c();
endsl;
return;`;

test('matching block keywords', () => {
  assert.deepStrictEqual(f.matchingLines(RPG, 'rpgle', 5), [3, 5, 7, 9]);
  assert.deepStrictEqual(f.matchingLines(RPG, 'rpgle', 11), [2, 6, 11]);
  assert.deepStrictEqual(f.matchingLines(RPG, 'rpgle', 13), [12, 13, 15, 17]);
  const fixed = ['     C     A             IFEQ      B', '     C                   EVAL      X = 1', '     C                   ELSE', '     C                   ENDIF'].join('\n');
  assert.deepStrictEqual(f.matchingLines(fixed, 'rpgle', 0), [0, 2, 3]);
  const cl = "PGM\nIF COND(&A *EQ 'X') THEN(DO)\n  CALL A\nENDDO\nELSE CMD(DO)\n  CALL B\nENDDO\nENDPGM";
  assert.deepStrictEqual(f.matchingLines(cl, 'cl', 1), [1, 4, 6]);
});

test('flowchart', () => {
  const fc = f.flowchart(RPG, 'rpgle', 'main');
  assert.match(fc, /^flowchart TD/);
  assert.match(fc, /\{\{"DOW not %eof\(cust\)"\}\}/);
  assert.match(fc, /\{"IF bal #gt; 100"\}/);
  assert.match(fc, /-->\|repeat\|/); assert.match(fc, /\(\["RETURN"\]\)/);
  assert.doesNotMatch(fc, /E\(\["end"\]\)/); // every path ends with RETURN
  const src = '**free\ndcl-proc a;\n  x = 1;\nend-proc;\nbegsr sr1;\n  y = 2;\nendsr;\nz = 3;';
  assert.deepStrictEqual(f.scopes(src), [{ name: 'A', kind: 'procedure' }, { name: 'SR1', kind: 'subroutine' }]);
  assert.match(f.flowchart(f.scopeText(src, 'A', 'rpgle'), 'rpgle'), /x = 1/);
  assert.doesNotMatch(f.flowchart(f.scopeText(src, '*MAIN', 'rpgle'), 'rpgle'), /x = 1|y = 2/);
  assert.match(f.flowchart("PGM\nIF (&A *EQ 'Y') THEN(RETURN)\nCALL X\nENDPGM", 'cl'), /IF &A \*EQ 'Y'/);
});

test('SQL procedure over a program', () => {
  const ep = m.entryPoints('**free\ndcl-pi *n;\n  cust char(7) const;\n  bal packed(9:2);\nend-pi;\ndcl-proc getName export;\n  dcl-pi *n varchar(50);\n    id int(10) value;\n  end-pi;\nend-proc;');
  assert.deepStrictEqual(ep.map(e => [e.kind, e.name, e.params.length]), [['program', '', 2], ['procedure', 'getName', 1]]);
  const p = m.wrapperSql({ schema: 'APP', name: 'CUSTUPD', library: 'APP', object: 'CUSTUPD', language: 'RPGLE', params: ep[0].params });
  assert.match(p.sql, /IN CUST CHAR\(7\),\n  INOUT BAL DECIMAL\(9, 2\)/); assert.match(p.sql, /EXTERNAL NAME APP\/CUSTUPD;/);
  const fn = m.wrapperSql({ schema: 'APP', name: 'GETNAME', library: 'APP', object: 'UTIL', procedure: 'getName', language: 'RPGLE', params: ep[1].params, returns: ep[1].returns });
  assert.match(fn.sql, /CREATE OR REPLACE FUNCTION/); assert.match(fn.sql, /RETURNS VARCHAR\(50\)/); assert.match(fn.sql, /'APP\/UTIL\(GETNAME\)'/);
  assert.deepStrictEqual(m.wrapperSql({ schema: 'A', name: 'B', library: 'A', object: 'B', language: 'RPGLE', params: [{ name: 'x', type: 'likeds(r)' }] }).unknown, ['x likeds(r)']);
  assert.strictEqual(m.sqlTypeForRpg('int(5)'), 'SMALLINT'); assert.strictEqual(m.sqlTypeForRpg('zoned(5:0)'), 'NUMERIC(5, 0)'); assert.strictEqual(m.sqlTypeForRpg('pointer'), undefined);
});

test('DDS to SQL', () => {
  const pf = `     A                                      UNIQUE
     A                                      TEXT('Customer master')
     A          R CUSTR
     A            CUSTNO         7P 0       TEXT('Customer number')
     A                                      COLHDG('Cust' 'No')
     A            NAME          30A         ALIAS(CUSTOMER_NAME)
     A            BAL            9  2       ALWNULL
     A            OPENED          L
     A          K CUSTNO`;
  const r = m.ddsToSql(pf, 'APP', 'CUST').sql;
  assert.match(r, /CUSTNO DECIMAL\(7, 0\) NOT NULL DEFAULT/);
  assert.match(r, /CUSTOMER_NAME FOR COLUMN NAME CHAR\(30\)/);
  assert.match(r, /BAL NUMERIC\(9, 2\),/); assert.match(r, /OPENED DATE/);
  assert.match(r, /PRIMARY KEY \(CUSTNO\)\n\)\n  RCDFMT CUSTR;/);
  assert.match(r, /CUSTNO IS 'Cust {16}No'/); assert.match(r, /LABEL ON TABLE APP\.CUST IS 'Customer master'/);
  const lf = m.ddsToSql('     A          R CUSTR                     PFILE(CUST)\n     A          K NAME                      DESCEND', 'APP', 'CUSTL1').sql;
  assert.match(lf, /CREATE INDEX APP\.CUSTL1\n  ON APP\.CUST \(NAME DESC\)\n  RCDFMT CUSTR;/);
  const so = m.ddsToSql('     A          R CUSTR                     PFILE(CUST)\n     A          K NAME\n     A          S BAL                       COMP(GT 0)', 'APP', 'CUSTL2');
  assert.match(so.sql, /CREATE OR REPLACE VIEW/); assert.ok(so.notes[0].includes('Select / omit'));
});

test('CRUD statements, SELECT * and constants', () => {
  const sql = m.crudSql('APP.CUST', [{ name: 'CUSTNO', type: 'DECIMAL', nullable: false }, { name: 'NAME', type: 'CHAR', nullable: true }, { name: 'ID', type: 'INTEGER', nullable: false, identity: true }], ['CUSTNO']);
  assert.match(sql, /INSERT INTO APP\.CUST\n  \(CUSTNO, NAME\)/); assert.match(sql, /UPDATE APP\.CUST\n   SET NAME   = :name\n WHERE CUSTNO = :custno;/);
  assert.match(sql, /MERGE INTO APP\.CUST T/); assert.match(sql, /Nullable: NAME/);
  assert.match(m.crudSql('A.B', [{ name: 'K', type: 'INTEGER', nullable: false }], ['K']), /nothing to update/);
  assert.deepStrictEqual(m.starAt('select * from app.cust where x=1'), { start: 7, end: 8, table: 'app.cust' });
  assert.strictEqual(m.starAt('select count(*) from x'), undefined);
  assert.strictEqual(m.constantName("'Customer not found'"), 'CUSTOMER_NOT_FOUND');
  assert.strictEqual(m.constantName('100', new Set(['C_100'])), 'C_100_2');
  assert.strictEqual(m.constantInsertLine('**free\nctl-opt dftactgrp(*no);\ndcl-c A 1;\ndcl-s x int(10);'), 3);
  assert.strictEqual(m.changeLogEntry('{date} {user}: {text}', { date: '2026-10-26', user: 'GG', ticket: '', text: 'fix' }, 'rpgle'), '// 2026-10-26 GG: fix');
});

test('column profile and top values', () => {
  const cols = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NOTE', type: 'VARCHAR', length: 50, scale: 0, nullable: true }, { name: 'DOC', type: 'CLOB', length: 1000, scale: 0, nullable: true }];
  const sql = q.profileSql('APP.T', cols);
  assert.strictEqual(sql.length, 1); assert.match(sql[0], /COUNT\(DISTINCT X\.ID\) AS D0/); assert.doesNotMatch(sql[0], /MIN\(X\.DOC\)/);
  const p = q.readProfile([{ T: 10, N0: 10, D0: 10, L0: '1', H0: '10', N1: 0, D1: 0, N2: 1 }], cols);
  assert.ok(p[0].flags.includes('unique (key candidate)')); assert.ok(p[1].flags.includes('always null')); assert.ok(p[2].flags.includes('mostly null'));
  assert.match(q.topValuesSql('APP.T', 'my col'), /GROUP BY "my col"/);
});

test('orphan rows and foreign keys', () => {
  const fks = q.foreignKeys([{ FK: 'F1', CS: 'APP', CT: 'ORD', CC: 'CUSTNO', PS: 'APP', PT: 'CUST', PC: 'CUSTNO' }, { FK: 'F1', CS: 'APP', CT: 'ORD', CC: 'BR', PS: 'APP', PT: 'CUST', PC: 'BRANCH' }]);
  assert.deepStrictEqual(fks[0].childCols, ['CUSTNO', 'BR']);
  const o = q.orphanSql(fks[0]);
  assert.match(o.count, /NOT EXISTS \(SELECT 1 FROM APP\.CUST P WHERE P\.CUSTNO = C\.CUSTNO AND P\.BRANCH = C\.BR\) AND C\.CUSTNO IS NOT NULL AND C\.BR IS NOT NULL/);
  assert.throws(() => q.orphanSql({ child: 'A', childCols: ['X'], parent: 'B', parentCols: [] }));
  assert.match(q.foreignKeysSql("A'B", 'T'), /'A''B'/);
});

test('capacity of columns', () => {
  const cols = [{ name: 'SEQ', type: 'DECIMAL', length: 5, scale: 0, nullable: false }, { name: 'NAME', type: 'CHAR', length: 10, scale: 0, nullable: false }, { name: 'N', type: 'SMALLINT', length: 2, scale: 0, nullable: false }, { name: 'D', type: 'DATE', length: 4, scale: 0, nullable: false }];
  assert.match(q.capacitySql('APP.T', cols), /MAX\(ABS\(SEQ\)\) AS M0, MAX\(LENGTH\(RTRIM\(NAME\)\)\) AS M1, MAX\(ABS\(N\)\) AS M2 FROM/);
  const r = q.capacity({ M0: 99000, M1: 10, M2: 100 }, cols);
  assert.deepStrictEqual(r.map(x => [x.name, x.level]), [['NAME', 'full'], ['SEQ', 'high'], ['N', 'ok']]);
});

test('unused objects', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const r = q.unusedObjects([
    { N: 'OLD', T: '*PGM', S: 500, C: '2018-01-01-10.00.00', U: '2020-01-01-10.00.00' },
    { N: 'NEVER', T: '*FILE', S: 900, C: '2019-01-01', U: null },
    { N: 'NEW', T: '*PGM', S: 100, C: '2026-09-01', U: null },
    { N: 'USED', T: '*PGM', S: 100, C: '2019-01-01', U: '2026-09-01' },
    { N: 'RCV', T: '*JRNRCV', S: 9999, C: '2019-01-01', U: null },
  ], now);
  assert.deepStrictEqual(r.map(o => o.name), ['NEVER', 'OLD']);
});

test('program findings', () => {
  const f2 = q.programFindings([
    { PROGRAM_LIBRARY: 'APP', PROGRAM_NAME: 'P1', OBJECT_TYPE: '*PGM', PROGRAM_OWNER: 'QSECOFR', USER_PROFILE: '*OWNER', SQL_DYNAMIC_USER_PROFILE: '*OWNER' },
    { PROGRAM_LIBRARY: 'APP', PROGRAM_NAME: 'P2', OBJECT_TYPE: '*PGM', PROGRAM_OWNER: 'APPOWN', USER_PROFILE: '*OWNER' },
    { PROGRAM_LIBRARY: 'APP', PROGRAM_NAME: 'P3', OBJECT_TYPE: '*PGM', PROGRAM_OWNER: 'ME', USER_PROFILE: '*USER', TARGET_RELEASE: 'V7R1M0' },
  ], new Set(), 'V7R5M0');
  assert.deepStrictEqual(f2.map(x => [x.program, x.level]), [['P1', 'high'], ['P1', 'medium'], ['P2', 'medium'], ['P3', 'info']]);
});

test('shadowed objects in the library list', () => {
  const r = q.shadowedObjects([{ L: 'DEV', N: 'PGMA', T: '*PGM' }, { L: 'PROD', N: 'PGMA', T: '*PGM' }, { L: 'PROD', N: 'PGMB', T: '*PGM' }, { L: 'OTHER', N: 'PGMB', T: '*PGM' }], ['DEV', 'PROD']);
  assert.deepStrictEqual(r, [{ name: 'PGMA', type: '*PGM', used: 'DEV', hidden: ['PROD'] }]);
});

test('job schedule calendar', () => {
  const from = new Date('2026-10-26T08:00:00Z'); // a Monday
  const runs = q.scheduleRuns([
    { SCHEDULED_JOB_ENTRY_NAME: 'NIGHT', STATUS: 'SCHEDULED', FREQUENCY: '*WEEKLY', SCHEDULED_DAYS: '*MON *WED', SCHEDULED_TIME: '22.00.00', NEXT_SUBMISSION_DATE: '2026-10-26' },
    { SCHEDULED_JOB_ENTRY_NAME: 'MEND', STATUS: 'SCHEDULED', FREQUENCY: '*MONTHLY', SCHEDULED_DATE_VALUE: '*MONTHEND', SCHEDULED_TIME: '23.30.00', NEXT_SUBMISSION_DATE: '2026-10-31' },
    { SCHEDULED_JOB_ENTRY_NAME: 'ONCE', STATUS: 'SCHEDULED', FREQUENCY: '*ONCE', SCHEDULED_TIME: '10.00.00', NEXT_SUBMISSION_DATE: '2026-10-28' },
    { SCHEDULED_JOB_ENTRY_NAME: 'HELD', STATUS: 'HELD', FREQUENCY: '*WEEKLY', SCHEDULED_DAYS: '*ALL' },
    { SCHEDULED_JOB_ENTRY_NAME: 'FIRSTMON', STATUS: 'SCHEDULED', FREQUENCY: '*MONTHLY', SCHEDULED_DAYS: '*MON', RELATIVE_DAYS_OF_MONTH: '1', SCHEDULED_TIME: '06.00.00', NEXT_SUBMISSION_DATE: '2026-11-02' },
  ], from, 8);
  assert.deepStrictEqual(runs.map(r => `${r.day} ${r.time} ${r.entry}`), ['2026-10-26 22:00 NIGHT', '2026-10-28 10:00 ONCE', '2026-10-28 22:00 NIGHT', '2026-10-31 23:30 MEND', '2026-11-02 06:00 FIRSTMON', '2026-11-02 22:00 NIGHT']);
});

test('timings of repeated runs', () => {
  const t = q.timings([100, 10, 12, 11, 30]);
  assert.strictEqual(t.first, 100); assert.strictEqual(t.min, 10); assert.strictEqual(t.median, 12); assert.strictEqual(t.p90, 100); assert.strictEqual(t.warm, 15.75);
  assert.throws(() => q.timings([]));
});
