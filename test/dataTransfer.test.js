const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const d = require('../out/core/dataTransfer');

test('CSV parsing with quotes, delimiters and BOM', () => {
  assert.strictEqual(d.detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.deepStrictEqual(d.parseCsv('﻿ID,NAME,NOTE\r\n1,"Smith, J","said ""hi""\nthen left"\r\n\r\n2,Bob,'),
    [['ID', 'NAME', 'NOTE'], ['1', 'Smith, J', 'said "hi"\nthen left'], ['2', 'Bob', '']]);
});

test('column mapping and SQL values', () => {
  const cols = [
    { name: 'CUSTNO', type: 'DECIMAL', length: 7, scale: 0, nullable: false },
    { name: 'NAME', type: 'CHARACTER', length: 10, scale: 0, nullable: false },
    { name: 'BALANCE', type: 'DECIMAL', length: 9, scale: 2, nullable: true },
    { name: 'OPENED', type: 'DATE', length: 4, scale: 0, nullable: true },
  ];
  assert.deepStrictEqual(d.mapColumns(['Cust No', 'name', 'Opened', 'Extra'], cols), [0, 1, -1, 2]);
  assert.strictEqual(d.sqlValue('12,50', cols[2]), '12.50');
  assert.strictEqual(d.sqlValue('', cols[2]), 'NULL');
  assert.strictEqual(d.sqlValue('', cols[0]), '0');
  assert.strictEqual(d.sqlValue("O'Hara", cols[1]), "'O''Hara'");
  assert.strictEqual(d.sqlValue('31/12/2025', cols[3]), "DATE('2025-12-31')");
  assert.throws(() => d.sqlValue('abc', cols[0]), /not a number/);
  assert.throws(() => d.sqlValue('12345678', cols[0]), /too large/);
  assert.throws(() => d.sqlValue('1.234', cols[2]), /decimal/);
  assert.throws(() => d.sqlValue('ABCDEFGHIJK', cols[1]), /longer than 10/);
  const { sql, errors } = d.insertStatements('APP', 'CUST', cols, [0, 1, -1, -1], [['1', 'A'], ['x', 'B'], ['3', 'C']], 100);
  assert.strictEqual(sql.length, 1);
  assert.strictEqual(sql[0], `INSERT INTO APP/CUST ("CUSTNO", "NAME") VALUES (1, 'A'), (3, 'C') WITH NC`);
  assert.deepStrictEqual(errors, ['Row 3: CUSTNO: "x" is not a number']);
  assert.strictEqual(d.insertStatements('A', 'T', cols, [0, -1, -1, -1], Array.from({ length: 250 }, (_, i) => [String(i)]), 100).sql.length, 3);
});

test('xlsx round trip through the zip writer and reader', () => {
  assert.strictEqual(d.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.strictEqual(d.columnLetter(0), 'A'); assert.strictEqual(d.columnLetter(27), 'AB');
  const x = d.buildXlsx('Customers', ['ID', 'NAME'], [{ ID: 1, NAME: 'A & B <x>' }, { ID: 2, NAME: null }], [true, false]);
  const files = d.unzip(x, b => zlib.inflateRawSync(b));
  assert.ok(files.has('xl/workbook.xml') && files.has('[Content_Types].xml'));
  const rows = d.readSheet(new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')));
  assert.deepStrictEqual(rows, [['ID', 'NAME'], ['1', 'A & B <x>'], ['2']]);
  // Deflated entries (as Excel writes them) and shared strings.
  const shared = '<sst><si><t>Hello</t></si><si><r><t>Wor</t></r><r><t>ld</t></r></si></sst>';
  assert.deepStrictEqual(d.readSheet('<sheetData><row r="1"><c r="B1" t="s"><v>1</v></c><c r="A1" t="s"><v>0</v></c></row></sheetData>', shared), [['Hello', 'World']]);
  assert.match(d.toJson(['A'], [{ A: 1, B: 2 }]), /"A": 1/);
});
