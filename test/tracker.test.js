const test = require('node:test');
const assert = require('node:assert');
const t = require('../out/core/tracker');

test('formatting and tones', () => {
  assert.strictEqual(t.bytes(512), '512 B');
  assert.strictEqual(t.bytes(1536), '1.5 KB');
  assert.strictEqual(t.bytes(5 * 1024 ** 3), '5.0 GB');
  assert.strictEqual(t.bytes(undefined), '');
  assert.strictEqual(t.tone(50, 80, 90), 'ok'); assert.strictEqual(t.tone(85, 80, 90), 'warn'); assert.strictEqual(t.tone(95, 80, 90), 'bad'); assert.strictEqual(t.tone(undefined, 1, 2), 'info');
  assert.strictEqual(t.num('12,5'), 12.5); assert.strictEqual(t.num(''), undefined); assert.strictEqual(t.num('x'), undefined);
  assert.ok(t.isIbmLibrary('QGPL') && t.isIbmLibrary('SYSIBM') && !t.isIbmLibrary('DEV'));
  assert.strictEqual(t.since('2026-10-15-08.00.00', new Date(2026, 9, 15, 10, 30).getTime()), '2 h 30 min');
  assert.strictEqual(t.since('2026-10-13-10.00.00', new Date(2026, 9, 15, 12, 0).getTime()), '2 d 2 h');
  assert.strictEqual(t.since('bad'), '');
});

test('what needs attention', () => {
  const a = t.attention({ aspUsed: 92, cpu: 95, msgwJobs: 2, lckwJobs: 1, inquiries: 3, brokenCompiles: 1, expiredPasswords: 0, libraryListMissing: ['GONE'] });
  assert.deepStrictEqual(a.map(x => x.tone), ['bad', 'bad', 'bad', 'warn', 'warn', 'warn', 'warn']);
  assert.match(a[0].text, /92.0% full/);
  assert.deepStrictEqual(t.attention({ msgwJobs: 0, lckwJobs: 0, inquiries: 0, brokenCompiles: 0, libraryListMissing: [] }), []);
  assert.strictEqual(t.attention({ aspUsed: 81, msgwJobs: 0, lckwJobs: 0, inquiries: 0, brokenCompiles: 0, libraryListMissing: [] })[0].tone, 'warn');
});

test('libraries', () => {
  const r = t.libraryRows([{ OBJNAME: 'DEV', OBJATTRIBUTE: 'TEST', OBJTEXT: 'x', OBJOWNER: 'ME', OBJCREATED: '2020-01-01-10.00.00' }, { OBJNAME: 'PROD' }], ['dev']);
  assert.deepStrictEqual(r.map(l => [l.name, l.type, l.inList, l.created]), [['DEV', 'TEST', 1, '2020-01-01'], ['PROD', 'PROD', 0, '']]);
  assert.match(t.librarySizeSql('dev'), /LIBRARY_NAME => 'DEV', IGNORE_ERRORS => 'YES'/);
  assert.throws(() => t.librarySizeSql("x'--"));
});

test('reliable library list', () => {
  const sql = t.libraryListSql(['dev']);
  assert.match(sql.stats, /OBJECT_STATISTICS\('\*ALL', '\*LIB'\)\) X WHERE OBJNAME IN \('DEV'\)/);
  assert.doesNotMatch(sql.stats, /'QSYS', '\*LIB'/);
  assert.match(sql.catalog, /SYSSCHEMAS WHERE SYSTEM_SCHEMA_NAME IN \('DEV'\)/);
  const m = t.mergeLibraries([{ OBJNAME: 'DEV', OBJTEXT: '', OBJATTRIBUTE: 'TEST', LAST_USED_TIMESTAMP: '2026-01-01' }], [{ OBJNAME: 'DEV', OBJTEXT: 'Dev', OBJOWNER: 'ME' }, { OBJNAME: 'ONLYCAT', OBJTEXT: 'x' }]);
  assert.deepStrictEqual(m.map(r => [r.OBJNAME, r.OBJTEXT, r.OBJATTRIBUTE, r.OBJOWNER]), [['DEV', 'Dev', 'TEST', 'ME'], ['ONLYCAT', 'x', undefined, undefined]]);
  const rows = t.libraryRows([{ OBJNAME: 'OLD', OBJCREATED: '2015-01-01' }, { OBJNAME: 'NEW', LAST_USED_TIMESTAMP: '2026-10-01' }, { OBJNAME: 'QGPL', OBJCREATED: '2000-01-01' }], []);
  assert.deepStrictEqual(t.unusedSince(rows, 365, new Date(2026, 9, 15).getTime()).map(l => l.name), ['OLD']);
  assert.strictEqual(t.csv(['A', 'B'], [['x,y', 1]]), 'A,B\n"x,y",1\n');
});

test('health score, trend, settings, network, queues', () => {
  const ok = t.healthScore({ msgwJobs: 0, lckwJobs: 0, inquiries: 0, brokenCompiles: 0, missingLibraries: 0, badSettings: 0, aspUsed: 50, cpu: 20, qsecurity: 40 });
  assert.deepStrictEqual([ok.score, ok.label, ok.reasons], [100, 'healthy', []]);
  const bad = t.healthScore({ aspUsed: 96, msgwJobs: 3, lckwJobs: 0, inquiries: 2, brokenCompiles: 1, missingLibraries: 0, badSettings: 1, qsecurity: 30 });
  assert.strictEqual(bad.label, 'action'); assert.ok(bad.score < 60); assert.ok(bad.reasons.some(r => /disk/.test(r)));
  assert.strictEqual(t.healthScore({ aspUsed: 99, cpu: 99, msgwJobs: 99, lckwJobs: 99, inquiries: 99, brokenCompiles: 9, missingLibraries: 9, badSettings: 9, qsecurity: 10, expiredPasswords: 9 }).score, 0);
  let l = [];
  l = t.addSnapshot(l, { at: '2026-10-15T10:00:00Z', cpu: 1 }); l = t.addSnapshot(l, { at: '2026-10-15T10:00:30Z', cpu: 2 }); l = t.addSnapshot(l, { at: '2026-10-15T10:02:00Z', cpu: 3 });
  assert.deepStrictEqual(l.map(x => x.cpu), [2, 3]);
  assert.strictEqual(t.sparkPoints([1]), '');
  assert.strictEqual(t.sparkPoints([0, 10], 100, 20), '0.0,18.0 100.0,2.0');
  assert.strictEqual(t.adviseSystemValue('QMAXSIGN', '*NOMAX').tone, 'bad');
  assert.strictEqual(t.adviseSystemValue('QSECURITY', '40').tone, 'ok');
  assert.strictEqual(t.adviseSystemValue('QSECURITY', '30').tone, 'warn');
  assert.strictEqual(t.adviseSystemValue('QCRTAUT', '*CHANGE').tone, 'warn');
  assert.strictEqual(t.portName(8471), 'Database server'); assert.ok(t.unencrypted(23) && !t.unencrypted(22));
  assert.strictEqual(t.queueCommand('jobq', 'release', 'qgpl', 'night'), 'RLSJOBQ JOBQ(QGPL/NIGHT)');
  assert.strictEqual(t.queueCommand('outq', 'hold', 'QUSRSYS', 'PRT01'), 'HLDOUTQ OUTQ(QUSRSYS/PRT01)');
  assert.throws(() => t.queueCommand('jobq', 'hold', 'QGPL', 'X) DLTLIB('));
  assert.match(t.summaryMarkdown('S', 'now', { score: 90, label: 'Healthy', reasons: [] }, [{ label: 'CPU', value: '1%' }], []), /health 90\/100[\s\S]*- CPU: 1%[\s\S]*Nothing needs attention/);
  const a = t.attention({ aspUsed: 85, msgwJobs: 1, lckwJobs: 0, inquiries: 0, brokenCompiles: 0, libraryListMissing: [] });
  assert.deepStrictEqual(a.map(x => x.tone), ['bad', 'warn']);
});

test('schedule, journals and object scan', () => {
  assert.strictEqual(t.scheduleCommand('hold', 'nightly', 12), 'HLDJOBSCDE JOB(NIGHTLY) ENTRYNBR(000012)');
  assert.throws(() => t.scheduleCommand('hold', 'X) DLTLIB(', 1));
  assert.throws(() => t.scheduleCommand('release', 'OK', 0));
  assert.strictEqual(t.journalTone(10, 1024), undefined);
  assert.strictEqual(t.journalTone(60, 0), 'warn');
  assert.strictEqual(t.journalTone(1, 60 * 1024 ** 3), 'bad');
  assert.match(t.objectScanSql(7, ['dev', 'bad lib'], 'changed'), /OBJECT_STATISTICS\('DEV', '\*ALL'\)\) X\) S WHERE CHANGE_TIMESTAMP > CURRENT TIMESTAMP - 7 DAYS/);
  assert.match(t.objectScanSql(500, [], 'size'), /'\*ALLUSR', '\*ALL'\)\) S ORDER BY OBJSIZE DESC FETCH FIRST 500/);
});
