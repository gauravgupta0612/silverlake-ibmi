const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/changeTracking');

test('source sync status', () => {
  const base = { sourceFile: 'QRPGLESRC', sourceMember: 'ORDENT', memberExists: true };
  assert.strictEqual(v.syncStatus({ ...base, compiledFrom: '2026-10-01 10:00:00', memberChanged: '2026-10-05 09:00:00' }), 'source newer');
  assert.strictEqual(v.syncStatus({ ...base, compiledFrom: '2026-10-01 10:00:00', memberChanged: '2026-10-01 10:00:01' }), 'in sync');
  assert.strictEqual(v.syncStatus({ ...base, memberExists: false, compiledFrom: '2026-10-01 10:00:00' }), 'source missing');
  assert.strictEqual(v.syncStatus({ memberExists: false }), 'no source info');
});
