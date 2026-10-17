const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/promotion');

test('object promotion plan', () => {
  assert.strictEqual(v.promoteStatus({ name: 'A', type: '*PGM', existsInTarget: false }), 'new');
  assert.strictEqual(v.promoteStatus({ name: 'A', type: '*PGM', existsInTarget: true, sourceChanged: '2026-10-02', targetChanged: '2026-10-01' }), 'newer in source');
  assert.strictEqual(v.promoteStatus({ name: 'A', type: '*PGM', existsInTarget: true, sourceChanged: '2026-09-02', targetChanged: '2026-10-01' }), 'NEWER IN TARGET');
  assert.ok(v.carriesData({ name: 'F', type: '*FILE', attribute: 'PF', existsInTarget: true }));
  assert.ok(!v.carriesData({ name: 'L', type: '*FILE', attribute: 'LF', existsInTarget: true }));
  assert.strictEqual(v.stampedName('VB', new Date(2026, 9, 11, 7, 5)), 'VB10110705');
  const plan = { source: 'DEV', target: 'PROD', backupLibrary: 'QGPL', when: new Date(2026, 9, 11, 7, 5).toISOString(), objects: [{ name: 'ORDENT', type: '*PGM' }, { name: 'PRICING', type: '*SRVPGM' }] };
  const c = v.promotionCommands(plan, [{ name: 'ORDENT', type: '*PGM' }]);
  assert.strictEqual(c.backupSavf, 'QGPL/VB10110705');
  assert.match(c.steps[1], /^SAVOBJ OBJ\(ORDENT\) LIB\(PROD\) DEV\(\*SAVF\) SAVF\(QGPL\/VB10110705\) OBJTYPE\(\*PGM\)$/);
  assert.match(c.steps[3], /^SAVOBJ OBJ\(ORDENT PRICING\) LIB\(DEV\).*OBJTYPE\(\*PGM \*SRVPGM\)$/);
  assert.match(c.steps[4], /^RSTOBJ OBJ\(ORDENT PRICING\) SAVLIB\(DEV\).*RSTLIB\(PROD\)$/);
  assert.strictEqual(c.steps[5], 'DLTF FILE(QGPL/VP10110705)');
  assert.strictEqual(v.promotionCommands(plan, []).steps.length, 4);
  assert.throws(() => v.promotionCommands({ ...plan, target: 'DEV' }, []), /same/);
  assert.strictEqual(v.undoPromotionCommand('PROD', 'QGPL/VB10110705'), 'RSTOBJ OBJ(*ALL) SAVLIB(PROD) DEV(*SAVF) SAVF(QGPL/VB10110705) MBROPT(*ALL) ALWOBJDIF(*COMPATIBLE)');
});
