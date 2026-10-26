const test = require('node:test');
const assert = require('node:assert');
const db = require('../out/core/dbCare');
const g = require('../out/core/sqlGen');

test('unused indexes: unique and recent ones are kept', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const r = db.indexUse([
    { INDEX_SCHEMA: 'APP', INDEX_NAME: 'CUSTIX1', SYSTEM_INDEX_NAME: 'CUSTIX1', TABLE_NAME: 'CUST', INDEX_TYPE: 'INDEX', INDEX_SIZE: 100, LAST_QUERY_USE: '2025-01-01-10.00.00', CREATE_TIMESTAMP: '2020-01-01' },
    { INDEX_SCHEMA: 'APP', INDEX_NAME: 'CUSTIX2', TABLE_NAME: 'CUST', INDEX_TYPE: 'INDEX', INDEX_SIZE: 50, LAST_QUERY_USE: '2026-09-01', CREATE_TIMESTAMP: '2020-01-01' },
    { INDEX_SCHEMA: 'APP', INDEX_NAME: 'CUSTPK', TABLE_NAME: 'CUST', INDEX_TYPE: 'PRIMARY KEY', INDEX_SIZE: 500, CREATE_TIMESTAMP: '2020-01-01' },
    { INDEX_SCHEMA: 'APP', INDEX_NAME: 'NEWIX', TABLE_NAME: 'CUST', INDEX_TYPE: 'INDEX', INDEX_SIZE: 10, CREATE_TIMESTAMP: '2026-09-20' },
    { INDEX_SCHEMA: 'APP', INDEX_NAME: 'CUSTL1', SYSTEM_INDEX_NAME: 'CUSTL1', TABLE_NAME: 'CUST', INDEX_TYPE: 'LOGICAL', INDEX_SIZE: 70, CREATE_TIMESTAMP: '2019-01-01' },
  ], now);
  assert.deepStrictEqual(r.filter(i => i.unused).map(i => i.name), ['CUSTIX1', 'CUSTL1']);
  assert.ok(r.find(i => i.name === 'CUSTPK').keep);
  assert.strictEqual(db.dropIndexCommand(r.find(i => i.name === 'CUSTL1'), 'APP'), 'DLTF FILE(APP/CUSTL1)');
  assert.strictEqual(db.dropIndexCommand(r.find(i => i.name === 'CUSTIX1'), 'APP'), 'DROP INDEX APP.CUSTIX1');
});

test('library names are checked before going into SQL', () => {
  assert.throws(() => db.indexStatsSql("X' OR 1=1 --"));
  assert.match(db.journalCoverageSql('applib'), /'APPLIB'/);
});

test('STRJRNPF in groups of 50', () => {
  const files = Array.from({ length: 51 }, (_, i) => `F${i}`);
  const c = db.strjrnpfCommands('APP', files, 'JRNLIB/APPJRN');
  assert.strictEqual(c.length, 2);
  assert.match(c[0], /^STRJRNPF FILE\(APP\/F0 .* JRN\(JRNLIB\/APPJRN\) IMAGES\(\*BOTH\) OMTJRNE\(\*OPNCLO\)$/);
  assert.match(db.strjrnpfCommands('APP', ['A'], 'J1')[0], /JRN\(APP\/J1\)/);
  assert.throws(() => db.strjrnpfCommands('APP', ['A'], 'BAD JRN'));
});

test('level check finder', () => {
  const uses = db.formatUses([
    { WHLIB: 'APP', WHPNAM: 'PGMA', WHFNAM: 'CUST', WHRFNM: 'CUSTR', WHRFSN: '111' },
    { WHLIB: 'APP', WHPNAM: 'PGMB', WHFNAM: 'CUST', WHRFNM: 'CUSTR', WHRFSN: '222' },
    { WHLIB: 'APP', WHPNAM: 'PGMC', WHFNAM: 'ORD', WHRFNM: 'ORDR', WHRFSN: '1' },
  ], 'cust');
  assert.strictEqual(uses.length, 2);
  const m = db.levelMismatches(uses, db.currentLevels([{ RFNAME: 'CUSTR', RFID: '222' }]));
  assert.deepStrictEqual(m.map(x => [x.pgm, x.now]), [['PGMA', '222']]);
});

test('library snapshots compared', () => {
  const o = (name, type, changed, size = 1) => db.toSnapObject({ N: name, T: type, C: changed, S: size, A: '', SRC: '', X: name });
  const d = db.compareSnapshots([o('A', '*PGM', '2026-01-01'), o('B', '*PGM', '2026-01-01'), o('C', '*FILE', '2026-01-01')],
    [o('A', '*PGM', '2026-02-01', 2), o('C', '*FILE', '2026-01-01'), o('D', '*SRVPGM', '2026-02-01')]);
  assert.deepStrictEqual(d.map(x => `${x.kind}:${x.name}`), ['added:D', 'changed:A', 'removed:B']);
  assert.match(d[1].what, /size 1 → 2/);
});

test('CSV columns guessed and CREATE TABLE', () => {
  const cols = g.guessColumns(['Id', 'Name', 'Amount', 'When', 'Zip', 'Stamp'],
    [['1', 'A', '1.50', '2024-01-01', '01200', '2024-01-01 10:00:00'], ['2', '', '3,2', '2024-02-01', '75000', '2024-01-02T11:00']]);
  assert.deepStrictEqual(cols.map(c => c.type), ['INTEGER', 'VARCHAR(10)', 'DECIMAL(5, 2)', 'DATE', 'VARCHAR(10)', 'TIMESTAMP']);
  assert.deepStrictEqual(cols.map(c => c.name), ['ID', 'NAME_', 'AMOUNT', 'WHEN_', 'ZIP', 'STAMP']);
  assert.ok(cols[1].nullable && !cols[0].nullable);
  const sql = g.createTableSql('APP', 'CUST', cols, "Cust's list");
  assert.match(sql, /CREATE TABLE APP\.CUST \(/); assert.match(sql, /IS 'Cust''s list'/); assert.match(sql, /NAME_ +TEXT IS 'Name'/);
  assert.strictEqual(g.sqlColumnName('1st été', new Set()), 'C_1ST_ETE');
});

test('JSON_TABLE with nested arrays has commas in the right places', () => {
  const sql = g.jsonTableSql(JSON.stringify([{ id: 1, lines: [{ sku: 'A', qty: 2 }], ok: true }]), { kind: 'column', table: 'APP.MSGS', column: 'BODY' });
  assert.match(sql, /FROM APP\.MSGS T,\s+JSON_TABLE\(\s+T\.BODY,\s+'lax \$\[\*\]'/);
  assert.match(sql, /ID INTEGER PATH 'lax \$\.id',\n\s+NESTED PATH 'lax \$\.lines\[\*\]' COLUMNS\(\n\s+LINES_SKU VARCHAR\(50\) PATH 'lax \$\.sku',\n\s+LINES_QTY INTEGER PATH 'lax \$\.qty'\n\s+\),\n\s+OK VARCHAR\(5\) PATH 'lax \$\.ok'\n\s+\)/);
  assert.throws(() => g.jsonTableSql('{bad', { kind: 'variable' }), /not valid JSON/);
  assert.throws(() => g.jsonTableSql('42', { kind: 'variable' }));
});

test('spooled file search SQL is guarded', () => {
  assert.match(g.spooledFilesSql('me', 7), /USER_NAME = 'ME'/);
  assert.doesNotMatch(g.spooledFilesSql('*ALL', 7), /USER_NAME/);
  assert.throws(() => g.spooledFilesSql("x'--", 7));
  assert.match(g.spoolSearchSql('123456/ME/QPADEV0001', 'QSYSPRT', 3, "50% o'k"), /LIKE '%50\\% O''K%' ESCAPE/);
  assert.throws(() => g.spoolSearchSql('bad', 'QSYSPRT', 1, 'x'));
});

test('comment blocks fold', () => {
  assert.deepStrictEqual(g.commentBlocks('// a\n// b\n// c\ndcl-s x;\n// d\n', 'rpgle'), [{ start: 0, end: 2 }]);
  assert.deepStrictEqual(g.commentBlocks('/* a */\n/* b */\n/* c */\nPGM\n', 'cl'), [{ start: 0, end: 2 }]);
  assert.deepStrictEqual(g.commentBlocks('-- a\n-- b\n-- c\n-- d\nSELECT 1', 'sql'), [{ start: 0, end: 3 }]);
});
