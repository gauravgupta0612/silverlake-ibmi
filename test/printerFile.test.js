const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/printerFile');

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
