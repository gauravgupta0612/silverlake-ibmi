const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v25');

const rec = (uri, ok, at = '2026-10-15T10:00:00Z') => ({ at, system: 'S', uri, name: uri, object: 'O/' + uri, ok, errors: ok ? 0 : 2, warnings: 0, command: 'C' });

test('compile history', () => {
  let l = [];
  l = v.addCompile(l, rec('A', false)); l = v.addCompile(l, rec('B', true)); l = v.addCompile(l, rec('A', true)); l = v.addCompile(l, rec('C', false));
  assert.deepStrictEqual(v.latestPerSource(l).map(r => [r.uri, r.ok]), [['C', false], ['A', true], ['B', true]]);
  assert.deepStrictEqual(v.compileSummary(l), { total: 4, failed: 2, rate: 50, brokenNow: 1 });
  for (let i = 0; i < 300; i++) { l = v.addCompile(l, rec('X' + i, true)); }
  assert.strictEqual(l.length, v.HISTORY_SIZE);
});

test('last compile day', () => {
  assert.strictEqual(v.dayOf('2026-10-05-11.00.00.000000'), '2026-10-05');
  assert.strictEqual(v.dayOf('nope'), undefined);
  assert.strictEqual(v.lastCompileDay([{ created: '2026-09-01-10.00.00' }, { created: '2026-10-05 11:00:00' }, {}]), '2026-10-05');
  assert.strictEqual(v.lastCompileDay([]), undefined);
});

test('live job log', () => {
  assert.match(v.jobLogSql('123456/bob/qpadev0001', 12), /JOBLOG_INFO\('123456\/BOB\/QPADEV0001'\)\) J WHERE ORDINAL_POSITION > 12/);
  assert.throws(() => v.jobLogSql("x') OR 1=1 --", 0));
  const m = { pos: 1, time: '2026-10-15-10.11.12.123', id: 'CPF9897', type: 'ESCAPE', severity: 40, text: 'Boom', from: 'PGMA' };
  assert.strictEqual(v.jobLogLine(m), '10:11:12 CPF9897 40 ESCAPE        Boom  [PGMA]');
  assert.ok(v.isAlarming(m));
  assert.ok(!v.isAlarming({ ...m, type: 'INFORMATIONAL', severity: 0 }));
});

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
