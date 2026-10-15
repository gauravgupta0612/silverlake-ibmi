const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v27');

test('reconnect back-off and health', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(v.reconnectDelay), [2, 5, 15, 30, 60, undefined]);
  assert.strictEqual(v.reconnectDelay(0), undefined);
  assert.deepStrictEqual(v.latencyState(120, 0), { state: 'good', text: '120 ms' });
  assert.strictEqual(v.latencyState(2000, 0).state, 'slow');
  assert.strictEqual(v.latencyState(6000, 0).state, 'bad');
  assert.strictEqual(v.latencyState(undefined, 2).state, 'down');
  assert.strictEqual(v.latencyState(undefined, 1).state, 'good');
});

test('connection errors', () => {
  for (const m of ['read ECONNRESET', 'Not connected to an IBM i system.', 'No response from server within 15 s', 'Timed out while waiting for handshake', 'socket hang up']) { assert.ok(v.isConnectionError(m), m); }
  for (const m of ['CPF9810: Library X not found.', 'Line 3 is longer than 100', 'Save cancelled.']) { assert.ok(!v.isConnectionError(m), m); }
  assert.match(v.pendingFileName('vanthrex-member:/DEV/QRPGLESRC/ORD01.rpgle', new Date('2026-10-15T10:00:00Z')), /^2026-10-15T10-00-00-000Z__DEV_QRPGLESRC_ORD01\.rpgle$/);
});

test('copy to another system', () => {
  assert.strictEqual(v.addMemberIfMissing('dev', 'qrpglesrc', 'ord01', 'rpgle', "It's"), "ADDPFM FILE(DEV/QRPGLESRC) MBR(ORD01) TEXT('It''s') SRCTYPE(RPGLE)");
  assert.throws(() => v.addMemberIfMissing('X) DLT(', 'F', 'M', '', ''));
  assert.deepStrictEqual(v.lineDiffSummary('a\nb\nc', 'a\nb\nc   '), { same: true, added: 0, removed: 0 });
  assert.deepStrictEqual(v.lineDiffSummary('a\nb\nd', 'a\nb\nc'), { same: false, added: 1, removed: 1 });
});
