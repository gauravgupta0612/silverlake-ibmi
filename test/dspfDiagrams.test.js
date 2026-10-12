const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const ds = require('../out/core/dspf');
const dg = require('../out/core/diagrams');

const col = (spec) => spec; // lines below are written in DDS columns
const DSPF = [
  '     A                                      DSPSIZ(24 80 *DS3)',
  '     A                                      CA03(03 \'Exit\')',
  '     A          R CUSTSCR',
  '     A                                      OVERLAY',
  '     A                                  1 30\'Customer Inquiry\'',
  '     A                                      COLOR(WHT)',
  '     A                                  3  2\'Customer:\'',
  '     A            CUSTNO         7S 0B  3 13',
  '     A  40                                  DSPATR(RI PC)',
  '     A            CUSTNM        30A  O  4 13',
  '     A                                 23  2\'F3=Exit\'',
  '     A          R SFL01                     SFL',
  '     A            ITEM          10A  O  8  2',
  '     A            QTY            5Y 0O  8 14',
  '     A          R CTL01                     SFLCTL(SFL01)',
  '     A                                      SFLPAG(3)',
  '     A                                      SFLSIZ(50)',
  '     A                                  6  2\'Item       Qty\'',
].join('\n');

test('DSPF parsing', () => {
  const d = ds.parseDspf(DSPF);
  assert.deepStrictEqual(d.records.map(r => r.name), ['CUSTSCR', 'SFL01', 'CTL01']);
  const scr = d.records[0];
  assert.ok(scr.overlay);
  const title = scr.fields.find(f => f.kind === 'constant' && f.line === 1);
  assert.strictEqual(title.text, 'Customer Inquiry'); assert.strictEqual(title.color, 'WHT');
  const custno = scr.fields.find(f => f.name === 'CUSTNO');
  assert.deepStrictEqual([custno.line, custno.col, custno.length, custno.usage, custno.decimals], [3, 13, 7, 'B', 0]);
  assert.deepStrictEqual(custno.attrs, ['RI', 'PC']);
  assert.ok(d.records[1].sfl);
  assert.strictEqual(d.records[2].sflctl, 'SFL01'); assert.strictEqual(d.records[2].sflpag, 3);
  assert.strictEqual(d.rows, 24);
});

test('DSPF screen layout', () => {
  const d = ds.parseDspf(DSPF);
  const { grid } = ds.layoutScreen(d, 'CUSTSCR');
  const line = y => grid[y - 1].map(c => (c ? c.ch : ' ')).join('').trimEnd();
  assert.strictEqual(line(1).trim(), 'Customer Inquiry');
  assert.strictEqual(grid[0][29].ch, 'C');
  assert.match(line(3), /Customer:\s+_{7}$/);
  assert.ok(grid[2][12].input);
  assert.match(line(4), /X{30}/);
  const sfl = ds.layoutScreen(d, 'CTL01').grid;
  const l = y => sfl[y - 1].map(c => (c ? c.ch : ' ')).join('').trimEnd();
  assert.match(l(6), /Item\s+Qty/);
  assert.match(l(8), /^ XXXXXXXXXX\s+99999$/); assert.match(l(10), /XXXXXXXXXX/); assert.strictEqual(l(11), '');
  assert.strictEqual(ds.parseDspf('     A                                      DSPSIZ(27 132 *DS4)\n     A          R X').cols, 132);
});

test('ERD helpers', () => {
  const tables = [
    { name: 'CUSTMAST', columns: [{ name: 'CUSTNO', type: 'DECIMAL(7,0)', pk: true }, { name: 'NAME', type: 'CHAR(30)', pk: false }] },
    { name: 'ORDHDR', columns: [{ name: 'ORDNO', type: 'DECIMAL(9,0)', pk: true }, { name: 'CUSTNO', type: 'DECIMAL(7,0)', pk: false }] },
    { name: 'ORDLIN', columns: [{ name: 'ORDNO', type: 'DECIMAL(9,0)', pk: true }, { name: 'LINE', type: 'INT', pk: true }, { name: 'ITEM', type: 'CHAR(10)', pk: false }] },
  ];
  const declared = [{ from: 'ORDLIN', fromCols: ['ORDNO'], to: 'ORDHDR', toCols: ['ORDNO'], inferred: false }];
  const inf = dg.inferLinks(tables, declared);
  assert.deepStrictEqual(inf.map(l => `${l.from}->${l.to}`), ['ORDHDR->CUSTMAST']);
  const { boxes, width, height } = dg.layoutErd(tables, [...declared, ...inf]);
  assert.strictEqual(boxes.length, 3); assert.ok(width > 0 && height > 0);
  assert.ok(boxes.every((b, i) => boxes.every((c, j) => i === j || b.x + b.w <= c.x || c.x + c.w <= b.x || b.y + b.h <= c.y || c.y + c.h <= b.y)));
  const m = dg.toMermaid(tables, [...declared, ...inf]);
  assert.match(m, /^erDiagram/); assert.match(m, /decimal CUSTNO PK/); assert.match(m, /CUSTMAST \|\|--o\{ ORDHDR : "CUSTNO \(inferred\)"/);
});

test('text to PDF, e-mail and cross-system row compare', () => {
  const pdf = Buffer.from(dg.textToPdf('Page 1 line (a)\nline 2\fPage 2 é', { linesPerPage: 60, title: 'T' })).toString('latin1');
  assert.match(pdf, /^%PDF-1\.4/); assert.match(pdf, /\/Count 2/); assert.match(pdf, /\(Page 1 line \\\(a\\\)\) Tj/); assert.match(pdf, /\\351/);
  const xref = Number(/startxref\n(\d+)/.exec(pdf)[1]); assert.strictEqual(pdf.slice(xref, xref + 4), 'xref');
  assert.deepStrictEqual(dg.parseRecipients('a@b.com; c.d@e.fr'), ['a@b.com', 'c.d@e.fr']);
  assert.throws(() => dg.parseRecipients("x@y.com, bad'"), /Not an e-mail/);
  assert.strictEqual(dg.emailCommand(['a@b.com'], "Q'1", 'Hi', { path: '/tmp/slk_x.pdf', type: '*PDF' }),
    "SNDSMTPEMM RCP(('a@b.com' *PRI)) SUBJECT('Q''1') NOTE('Hi') ATTACH(('/tmp/slk_x.pdf' *PDF *BIN))");
  const r = dg.compareRows(['ID'], [{ ID: 1, N: 'a ' }, { ID: 2, N: 'b' }, { ID: 3, N: 'c' }], [{ ID: 1, N: 'a' }, { ID: 2, N: 'B' }, { ID: 4, N: 'd' }], ['ID', 'N']);
  assert.strictEqual(r.same, 1); assert.deepStrictEqual(r.changed, [{ key: '2', diffs: [{ col: 'N', a: 'b', b: 'B' }] }]);
  assert.deepStrictEqual(r.onlyA.map(x => x.ID), [3]); assert.deepStrictEqual(r.onlyB.map(x => x.ID), [4]);
});
