const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v2');

const PRTF = [
  '     A          R HEADER                    SKIPB(1)',
  '     A                                     2\'Customer list\'',
  '     A                                    60DATE',
  '     A                                      EDTCDE(Y)',
  '     A                                    +2\'Page\'',
  '     A                                    +1PAGNBR',
  '     A          R DETAIL                    SPACEB(1)',
  '     A            CUSTNO         7S 0      2',
  '     A            NAME          30A       +2',
  '     A          R TOTAL                     SPACEB(2)',
  '     A                                     2\'Total:\'',
  '     A            TOTAMT        11Y 2     +1',
].join('\n');

test('printer file layout', () => {
  const r = v.layoutPrtf(PRTF);
  assert.deepStrictEqual(r.records, ['HEADER', 'DETAIL', 'TOTAL']);
  assert.match(r.lines[0], /^ Customer list\s+MM\/DD\/YY  Page 9999$/);
  assert.strictEqual(r.lines[0].indexOf('MM/DD/YY'), 59);
  assert.match(r.lines[1], /^ 9999999  X{30}$/);
  assert.strictEqual(r.lines[2], '');
  assert.match(r.lines[3], /^ Total: 999999999\.99$/);
  assert.strictEqual(r.items.find(i => i.name === 'NAME').col, 11);
});

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

test('SQL helpers and commands', () => {
  const cols = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NAME', type: 'CHARACTER', length: 10, scale: 0, nullable: true }];
  assert.strictEqual(v.insertScript('APP', 'T', cols, [{ ID: 1, NAME: "O'Hara    " }, { ID: 2, NAME: null }]).split('\n').slice(1, 3).join('\n'),
    `INSERT INTO APP/T ("ID", "NAME") VALUES (1, 'O''Hara');\nINSERT INTO APP/T ("ID", "NAME") VALUES (2, NULL);`);
  assert.strictEqual(v.duplicatesSql('app', 'cust', ['EMAIL']), 'SELECT "EMAIL", COUNT(*) AS "COPIES" FROM APP/CUST GROUP BY "EMAIL" HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC FETCH FIRST 500 ROWS ONLY');
  assert.strictEqual(v.crtdupobjCommand('dev', 'cust', '*file', 'test', undefined, true), 'CRTDUPOBJ OBJ(CUST) FROMLIB(DEV) OBJTYPE(*FILE) TOLIB(TEST) DATA(*YES)');
  assert.strictEqual(v.crtdupobjCommand('DEV', 'PGM1', '*PGM', 'DEV', 'PGM1OLD'), 'CRTDUPOBJ OBJ(PGM1) FROMLIB(DEV) OBJTYPE(*PGM) TOLIB(DEV) NEWOBJ(PGM1OLD)');
  assert.strictEqual(v.moveCommand('DEV', 'X', '*PGM', 'OLD'), 'MOVOBJ OBJ(DEV/X) OBJTYPE(*PGM) TOLIB(OLD)');
  assert.strictEqual(v.renameCommand('DEV', 'X', '*PGM', 'Y'), 'RNMOBJ OBJ(DEV/X) OBJTYPE(*PGM) NEWOBJ(Y)');
  assert.strictEqual(v.cpysrcfCommand('DEV', 'QRPGLESRC', 'A', 'TEST', 'QRPGLESRC', false), 'CPYSRCF FROMFILE(DEV/QRPGLESRC) TOFILE(TEST/QRPGLESRC) FROMMBR(A) TOMBR(*FROMMBR) MBROPT(*ADD)');
  assert.throws(() => v.renameCommand('DEV', 'X', '*PGM', '1BAD'), /valid/);
});

test('IFS search command and parsing', () => {
  const c = v.ifsGrepCommand('/home/bob', "it's", { include: '*.rpgle', max: 10 });
  assert.match(c, /^\/QOpenSys\/usr\/bin\/find '\/home\/bob' -type f -name '\*\.rpgle' -exec \/QOpenSys\/usr\/bin\/grep -nFi -e 'it'\\''s' \/dev\/null \{\} \+/);
  assert.match(c, /head -n 10$/);
  assert.throws(() => v.ifsGrepCommand('home', 'x'), /absolute/);
  assert.deepStrictEqual(v.parseGrep('/home/a.txt:12:hello: world\nnoise\n/x/b:3:x'), [{ file: '/home/a.txt', line: 12, text: 'hello: world' }, { file: '/x/b', line: 3, text: 'x' }]);
});
