const test = require('node:test');
const assert = require('node:assert');
const n = require('../out/core/notebook');

test('notebook file round trip and cell kinds', () => {
  const cells = [{ kind: 'markdown', source: '# T' }, { kind: 'sql', source: 'SELECT 1\nFROM X' }, { kind: 'cl', source: 'DSPLIBL' }];
  const text = n.serializeNotebook(cells);
  assert.deepStrictEqual(n.parseNotebook(text).cells, cells);
  assert.deepStrictEqual(n.parseNotebook('').cells, []);
  assert.throws(() => n.parseNotebook('{x'), /not valid JSON/);
  assert.strictEqual(n.kindOfLanguage('shellscript'), 'shell');
  assert.strictEqual(n.kindOfLanguage('CL'), 'cl');
  assert.strictEqual(n.kindOfLanguage('sql'), 'sql');
  assert.ok(n.sampleNotebook('BOB').length >= 4);
});

test('cell options, result table, charts, markdown export', () => {
  assert.deepStrictEqual(n.cellOptions('-- chart: bar Sales by month\n-- rows: 50\nSELECT 1'), { chart: 'bar', title: 'Sales by month', rows: 50 });
  assert.deepStrictEqual(n.cellOptions('SELECT 1 -- chart: pie'), {});
  const html = n.resultTableHtml(['A', 'N'], [{ A: '<b>', N: 3 }, { A: null, N: '4.5' }], '2 rows');
  assert.match(html, /&lt;b&gt;/); assert.match(html, /text-align:right">3</); assert.match(html, /null/); assert.match(html, /2 rows/);
  const rows = [{ M: 'Jan', S: 10, C: 2 }, { M: 'Feb', S: -5, C: 3 }];
  const bar = n.chartSvg('bar', ['M', 'S', 'C'], rows, 'Sales');
  assert.match(bar, /^<svg/); assert.strictEqual((bar.match(/<rect x=/g) || []).length, 4); assert.match(bar, /Sales/);
  assert.strictEqual((n.chartSvg('line', ['M', 'S'], rows).match(/<polyline/g) || []).length, 1);
  assert.match(n.chartSvg('pie', ['M', 'S'], [{ M: 'a', S: 1 }, { M: 'b', S: 3 }]), /75%/);
  assert.throws(() => n.chartSvg('bar', ['M'], rows), /label column/);
  assert.throws(() => n.chartSvg('bar', ['M', 'X'], [{ M: 'a', X: 'text' }]), /number/);
  const md = n.notebookMarkdown([{ kind: 'markdown', source: '# Hi' }, { kind: 'sql', source: 'SELECT 1', result: { columns: ['A|B'], rows: [{ 'A|B': 'x|y' }] } }, { kind: 'cl', source: 'DSPLIBL', result: 'done' }]);
  assert.match(md, /# Hi/); assert.match(md, /```sql\nSELECT 1\n```/); assert.match(md, /\| x\\\|y \|/); assert.match(md, /```text\ndone/);
});
