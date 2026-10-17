const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/pins');

test('pins', () => {
  const a = { kind: 'member', library: 'DEV', file: 'QRPGLESRC', name: 'ORD01', type: 'RPGLE' };
  const b = { kind: 'ifs', path: '/home/me/app.log', type: 'file' };
  let r = v.togglePin([], a); assert.ok(r.pinned);
  r = v.togglePin(r.list, b); assert.strictEqual(r.list.length, 2);
  assert.deepStrictEqual(v.movePin(r.list, v.pinKey(b), -1).map(v.pinLabel), ['app.log', 'ord01.rpgle'.replace('ord01', 'ORD01')]);
  assert.deepStrictEqual(v.movePin(r.list, v.pinKey(a), -1), r.list);
  r = v.togglePin(r.list, { ...a, library: 'dev' }); assert.ok(!r.pinned); assert.strictEqual(r.list.length, 1);
  assert.strictEqual(v.pinDescription(a), 'DEV/QRPGLESRC');
});
