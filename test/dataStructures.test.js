const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/dataStructures');

const rows = l => l.fields.map(f => [f.name, f.type, f.from, f.to, f.length]);

// Fixed D spec: name 7-21, E 22, decl 24-25, from 26-32, to 33-39, type 40, dec 41-42, keywords 44+.
const D = (name, decl, from, to, type, dec, kw = '', ext = ' ') => ('     D' + name.padEnd(15) + ext + ' ' + decl.padEnd(2) + String(from).padStart(7) + String(to).padStart(7) + type.padEnd(1) + String(dec).padStart(2) + ' ' + kw);

test('free-form data structure: types, pos, overlay, dim, likeds', () => {
  const src = `**FREE
dcl-s code char(7);
dcl-ds address qualified template;
  street varchar(30);
  zip zoned(5:0);
end-ds;
dcl-ds order qualified;
  id int(10);
  amount packed(9:2);
  when timestamp;
  flag ind;
  ship likeds(address);
  lines char(3) dim(4);
  yr char(4) overlay(when);
  mo char(2) overlay(when:6);
  ref like(code);
  dt date(*ymd);
  tail char(2) pos(100);
end-ds;
`;
  const all = v.dataStructures(src);
  assert.deepStrictEqual(all.map(d => [d.name, d.length]), [['address', 37], ['order', 101]]);
  const o = v.dataStructureAt(src, 9);
  assert.strictEqual(o.name, 'order');
  assert.deepStrictEqual(rows(o), [
    ['id', 'int(10)', 1, 4, 4], ['amount', 'packed(9:2)', 5, 9, 5], ['when', 'timestamp', 10, 35, 26], ['flag', 'ind', 36, 36, 1],
    ['ship', 'likeds(address)', 37, 73, 37], ['lines', 'char(3)', 74, 85, 12], ['yr', 'char(4)', 10, 13, 4], ['mo', 'char(2)', 15, 16, 2],
    ['ref', 'like(code) char(7)', 86, 92, 7], ['dt', 'date(*ymd)', 93, 100, 8], ['tail', 'char(2)', 100, 101, 2],
  ]);
  assert.deepStrictEqual(o.problems, []);
});

test('fixed-form data structure with from/to and length notation', () => {
  const src = [D('CUSTDS', 'DS', '', '', '', ''), D('CUSNO', '', 1, 6, 'S', 0), D('NAME', '', '', 30, 'A', ''), D('BAL', '', '', 11, 'P', 2), D('CNT', '', '', 10, 'I', 0), D('PART', '', '', 2, 'A', '', 'OVERLAY(NAME:5)'), D('QTY', '', '', 5, '', 0)].join('\n');
  const l = v.dataStructures(src)[0];
  assert.deepStrictEqual(rows(l), [['CUSNO', 'zoned(6:0)', 1, 6, 6], ['NAME', 'char(30)', 7, 36, 30], ['BAL', 'packed(11:2)', 37, 42, 6], ['CNT', 'int(10)', 43, 46, 4], ['PART', 'char(2)', 11, 12, 2], ['QTY', 'zoned(5:0)', 47, 51, 5]]);
  assert.strictEqual(l.length, 51);
});

test('external data structure uses the database columns; unknown LIKE stops positions', () => {
  const src = "**FREE\ndcl-ds cust extname('MYLIB/CUSTMAST') qualified end-ds;\ndcl-ds x;\n  a char(2);\n  b like(nowhere);\n  c char(1);\nend-ds;\n";
  assert.deepStrictEqual(v.externalFiles(src), ['CUSTMAST']);
  assert.strictEqual(v.externalLibrary(src, 'CUSTMAST'), 'MYLIB');
  const [c, x] = v.dataStructures(src, { CUSTMAST: [{ name: 'CUSNO', dataType: 'DECIMAL', length: 7, scale: 0 }, { name: 'CUSNAM', dataType: 'VARCHAR', length: 40 }, { name: 'SINCE', dataType: 'DATE', length: 4 }] });
  assert.deepStrictEqual(rows(c), [['CUSNO', 'packed(7:0)', 1, 4, 4], ['CUSNAM', 'varchar(40)', 5, 46, 42], ['SINCE', 'date', 47, 56, 10]]);
  assert.strictEqual(x.fields[2].from, undefined);
  assert.strictEqual(x.length, undefined);
  assert.ok(x.problems.length);
  assert.ok(v.dataStructures(src)[0].problems[0].includes('CUSTMAST'));
});

test('type sizes', () => {
  assert.strictEqual(v.freeTypeBytes('varchar', '100'), 102);
  assert.strictEqual(v.freeTypeBytes('varchar', '100:4'), 104);
  assert.strictEqual(v.freeTypeBytes('ucs2', '10'), 20);
  assert.strictEqual(v.freeTypeBytes('packed', '15:5'), 8);
  assert.strictEqual(v.freeTypeBytes('bindec', '9'), 4);
  assert.strictEqual(v.freeTypeBytes('int', '5'), 2);
  assert.strictEqual(v.freeTypeBytes('timestamp', '0'), 19);
  assert.strictEqual(v.freeTypeBytes('timestamp', '12'), 32);
  assert.strictEqual(v.freeTypeBytes('date', '*jul'), 6);
  assert.strictEqual(v.freeTypeBytes('likeds', 'x'), undefined);
});
