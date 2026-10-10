const test = require('node:test');
const assert = require('node:assert');
const { sqlTemplatesFor, targetLabel } = require('../out/core/sqlTemplates');

const labels = t => sqlTemplatesFor(t).map(x => x.label);

test('a file gets data, row count and column queries first', () => {
  const t = sqlTemplatesFor({ library: 'app', name: 'orders', type: '*FILE' });
  assert.strictEqual(t[0].label, 'First 100 rows');
  assert.match(t[0].sql, /FROM APP\/ORDERS\s+FETCH FIRST 100 ROWS ONLY/);
  assert.ok(labels({ library: 'APP', name: 'ORDERS', type: '*FILE' }).includes('Columns'));
  assert.strictEqual(targetLabel({ library: 'app', name: 'orders', type: '*file' }), 'APP/ORDERS *FILE');
});

test('a service program gets exports and the programs bound to it', () => {
  const l = labels({ library: 'APP', name: 'CUSTSRV', type: '*SRVPGM' });
  assert.ok(l.includes('Exported procedures') && l.includes('Programs bound to it') && l.includes('Who has it locked?'));
  assert.ok(!labels({ library: 'APP', name: 'ORD100', type: '*PGM' }).includes('Exported procedures'));
});

test('library, source file and member queries', () => {
  assert.strictEqual(labels({ library: 'APP' })[0], 'All objects');
  assert.strictEqual(labels({ library: 'APP', file: 'QRPGLESRC' })[0], 'Members of this source file');
  const m = sqlTemplatesFor({ library: 'APP', file: 'QRPGLESRC', member: 'ord100' });
  assert.strictEqual(m[0].label, 'Member information');
  assert.match(m[0].sql, /SYSTEM_TABLE_MEMBER = 'ORD100'/);
  assert.strictEqual(targetLabel({ library: 'APP', file: 'QRPGLESRC', member: 'ORD100' }), 'APP/QRPGLESRC(ORD100)');
});

test('names are quoted safely', () => {
  const t = sqlTemplatesFor({ library: "A'B", name: 'X', type: '*PGM' });
  assert.ok(t.every(x => !/'A'B'/.test(x.sql)));
});
