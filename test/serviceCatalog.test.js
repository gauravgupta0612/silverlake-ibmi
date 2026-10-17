const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/serviceCatalog');

test('self-check evaluation and service catalog', () => {
  const res = v.evaluateSelfCheck({ qsh: true, sqlEngine: 'Mapepire (SSH)', javaVersion: 'openjdk version "1.8.0_391"', ccsid: 65535, homeWritable: false,
    missingLibraries: ['OLDLIB'], release: '7.3', specialAuthorities: '*NONE', rpgUnit: false, debugService: true });
  const by = a => res.find(x => x.area === a);
  assert.strictEqual(by('QSH / CL commands').ok, true);
  assert.strictEqual(by('Java').ok, 'warn');
  assert.strictEqual(by('CCSID').ok, 'warn');
  assert.match(by('Library list').detail, /OLDLIB/);
  assert.strictEqual(by('IBM i release').ok, 'warn');
  assert.strictEqual(by('Special authorities').ok, 'warn');
  assert.strictEqual(v.evaluateSelfCheck({ sqlEngine: 'not started' })[1].ok, false);
  assert.strictEqual(v.evaluateSelfCheck({ javaVersion: 'openjdk version "17.0.2"' }).find(x => x.area === 'Java').ok, true);
  const miss = v.missingServices(v.SERVICES.filter(s => s.name !== 'SAVE_FILE_OBJECTS').map(s => `${s.schema}.${s.name}`));
  assert.deepStrictEqual(miss.map(m => m.name), ['SAVE_FILE_OBJECTS']);
});
