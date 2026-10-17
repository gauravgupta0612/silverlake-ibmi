const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/alerts');

test('live alert helpers', () => {
  assert.strictEqual(v.endCode('Job 123456/BOB/NIGHT completed on 10/11/26 at 02:00:00 after 3 minutes; end code 20 .'), 20);
  assert.ok(v.isAbnormalEnd('…; end code 30 .') && !v.isAbnormalEnd('…; end code 0 .') && !v.isAbnormalEnd('no code'));
  const m = new v.AlertMemory();
  const a = { kind: 'msgw', key: 'k1', title: 't', detail: '', time: '' };
  assert.strictEqual(m.fresh([a]).length, 1);
  assert.strictEqual(m.fresh([a]).length, 0);
  m.forget('k1');
  assert.strictEqual(m.fresh([a]).length, 1);
  assert.strictEqual(v.replyCommand('0000abcd', 'QSYS', 'QSYSOPR', "C"), "SNDRPY MSGKEY(X'0000ABCD') MSGQ(QSYS/QSYSOPR) RPY('C') RMV(*NO)");
  assert.throws(() => v.replyCommand('zz', 'QSYS', 'QSYSOPR', 'C'), /key/);
  assert.deepStrictEqual(v.validReplies('Error message CPF4131 appeared during OPEN (C G).'), ['C', 'G']);
  assert.deepStrictEqual(v.validReplies('No choices here.'), []);
});
