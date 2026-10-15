const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v24');

test('find member SQL', () => {
  const sql = v.findMemberSql('ord*', ['dev', 'prod'], 'rpgle');
  assert.match(sql, /SYSTEM_TABLE_MEMBER LIKE 'ORD%'/);
  assert.match(sql, /SYSTEM_TABLE_SCHEMA IN \('DEV', 'PROD'\)/);
  assert.match(sql, /SOURCE_TYPE LIKE 'RPGLE'/);
  assert.match(v.findMemberSql('*CUST*', []), /NOT LIKE 'Q%'/);
  assert.throws(() => v.findMemberSql("x' OR 1=1", []));
  assert.throws(() => v.findMemberSql('*', []));
  assert.strictEqual(v.libraryRank('prod', ['DEV', 'PROD']), 1);
  assert.strictEqual(v.libraryRank('X', ['DEV']), 999);
});

test('objects built from a member', () => {
  const pgm = [{ PROGRAM_LIBRARY: 'OBJ', PROGRAM_NAME: 'OLD1', OBJECT_TYPE: '*PGM', SOURCE_FILE_CHANGE_TIMESTAMP: '2026-09-01-10.00.00.000000', PROGRAM_CREATE_TIMESTAMP: '2026-09-02-10.00.00' }];
  const mod = [{ PROGRAM_LIBRARY: 'OBJ', PROGRAM_NAME: 'ORD01', OBJECT_TYPE: '*PGM', BOUND_MODULE_LIBRARY: 'OBJ', BOUND_MODULE: 'ORD01', SOURCE_CHANGE_TIMESTAMP: '2026-10-05-10.00.00', MODULE_CREATE_TIMESTAMP: '2026-10-05-11.00.00' },
    { PROGRAM_LIBRARY: 'OBJ', PROGRAM_NAME: 'ORD01', OBJECT_TYPE: '*PGM', BOUND_MODULE_LIBRARY: 'OBJ', BOUND_MODULE: 'ORD01', SOURCE_CHANGE_TIMESTAMP: '2026-10-05-10.00.00', MODULE_CREATE_TIMESTAMP: '2026-10-05-11.00.00' }];
  const b = v.builtObjects(pgm, mod, '2026-10-01-09.00.00.000000');
  assert.deepStrictEqual(b.map(o => [o.name, o.status, o.module ?? '']), [['ORD01', 'current', 'OBJ/ORD01'], ['OLD1', 'stale', '']]);
  assert.strictEqual(v.builtFromStatus(undefined, 'x'), 'unknown');
  assert.match(v.builtFromSql('BOUND_MODULE_INFO', 'dev', 'qrpglesrc', 'ord01', ['OBJ', 'obj']), /SOURCE_FILE_MEMBER = 'ORD01' AND PROGRAM_LIBRARY IN \('OBJ'\)$/);
});

test('compile on save', () => {
  assert.strictEqual(v.compileOnSaveAction('rpgle', 'off'), 'none');
  assert.strictEqual(v.compileOnSaveAction('rpgle', 'ask'), 'ask');
  assert.strictEqual(v.compileOnSaveAction('RPGLE', 'always'), 'compile');
  assert.strictEqual(v.compileOnSaveAction('rpgleinc', 'always'), 'none');
  assert.strictEqual(v.compileOnSaveAction('clle', 'always', ['RPGLE']), 'none');
});

test('status bar text', () => {
  assert.match(v.statusText({ objects: [] }).text, /not compiled/);
  const t = v.statusText({ lockedBy: '123456/BOB/QPADEV01', objects: [{ library: 'O', name: 'P', type: '*PGM', status: 'stale' }] });
  assert.ok(t.warn); assert.match(t.text, /\$\(lock\) BOB/); assert.match(t.text, /1 out of date/);
  assert.match(v.statusText({ objects: [{ library: 'O', name: 'P', type: '*PGM', status: 'current' }] }).text, /\$\(check\) O\/P/);
});
