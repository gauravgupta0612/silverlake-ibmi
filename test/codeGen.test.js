const test = require('node:test');
const assert = require('node:assert');
const g = require('../out/core/codeGen');

test('JSON sample to RPG data structures', () => {
  const rpg = g.jsonToRpg(JSON.stringify({ orderId: 12, total: 10.25, paid: true, 'ship-to': { city: 'Lyon' }, items: [{ sku: 'A1', qty: 2 }, { sku: 'B22', qty: 1, note: null }], tags: ['x', 'yy'], '1st': 'z' }), { root: 'order' });
  assert.match(rpg, /dcl-ds ship_to_t qualified template;\n  city varchar\(20\);\nend-ds;/);
  assert.match(rpg, /dcl-ds items_item_t qualified template;\n  sku varchar\(20\);\n  qty int\(10\);\n  note varchar\(100\);/);
  assert.match(rpg, /dcl-ds order qualified inz;/);
  assert.match(rpg, /  orderId int\(10\);/); assert.match(rpg, /  total packed\(15:2\);/); assert.match(rpg, /  paid ind;/);
  assert.match(rpg, /  ship_to likeds\(ship_to_t\); \/\/ JSON "ship-to"/);
  assert.match(rpg, /  num_items int\(10\);[^\n]*\n  items likeds\(items_item_t\) dim\(100\);/);
  assert.match(rpg, /  tags varchar\(20\) dim\(100\);/);
  assert.match(rpg, /  n1st varchar\(20\); \/\/ JSON "1st"/);
  assert.match(rpg, /data-into order %data\(json: 'doc=string case=any allowmissing=yes allowextra=yes countprefix=num_'\)/);
  assert.match(rpg, /Renamed[^\n]*ship-to → ship_to/);
  const arr = g.jsonToRpg('[{"a":1},{"a":2,"b":"x"}]', { root: 'list', dim: 50 });
  assert.match(arr, /dcl-ds list likeds\(list_item_t\) dim\(50\) inz;/);
  assert.throws(() => g.jsonToRpg('{bad'), /not valid JSON/);
  assert.throws(() => g.jsonToRpg('42'), /object or an array/);
  assert.strictEqual(g.rpgName('select'), 'select_');
});

test('query to RPG cursor loop, DSPFFD columns', () => {
  const cols = g.ffdToColumns([
    { WHFLDE: 'CUSNO', WHFLDT: 'P', WHFLDD: 7, WHFLDP: 0, WHFLDB: 4, WHFTXT: 'Customer' },
    { WHFLDE: 'NAME', WHFLDT: 'A', WHFLDB: 52, WHVARL: 'Y', WHALIS: 'CUSTOMER_NAME', WHNULL: 'Y' },
    { WHFLDE: 'CNT', WHFLDT: 'B', WHFLDD: 9, WHFLDB: 4 }, { WHFLDE: 'D', WHFLDT: 'L', WHFLDB: 10 },
  ]);
  assert.deepStrictEqual(cols.map(c => [c.name, c.type, c.length, c.scale, c.nullable]), [['CUSNO', 'DECIMAL', 7, 0, false], ['CUSTOMER_NAME', 'VARCHAR', 50, 0, true], ['CNT', 'INTEGER', 4, 0, false], ['D', 'DATE', 10, 0, false]]);
  const rpg = g.queryToRpg('select cusno, name from cust;', cols, 'cust', 50);
  assert.match(rpg, /dcl-ds cust_t qualified template;\n  cusno +packed\(7:0\); \/\/ Customer/);
  assert.match(rpg, /name +varchar\(50\); \/\/ CUSTOMER_NAME/);
  assert.match(rpg, /dcl-ds custNulls qualified dim\(50\);[^\n]*\n  ind int\(5\) dim\(4\);/);
  assert.match(rpg, /exec sql declare c1 cursor for\n  select cusno, name from cust\n  for read only;/);
  assert.match(rpg, /fetch next from c1 for 50 rows into :custs :custNulls;/);
  assert.throws(() => g.queryToRpg('x', []), /no columns/);
});
