const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/jobTools');

test('submit and watch helpers', () => {
  assert.strictEqual(v.submittedJob('CPC1221: Job 123456/BOB/NIGHTLY submitted to job queue QBATCH in library QGPL.'), '123456/BOB/NIGHTLY');
  assert.strictEqual(v.submittedJob('nothing'), undefined);
  assert.strictEqual(v.sbmjobCommand('CALL PGM(APP/X)', 'night', 'qbatch'), 'SBMJOB CMD(CALL PGM(APP/X)) JOB(NIGHT) JOBQ(QBATCH)');
  assert.throws(() => v.sbmjobCommand('X', '1bad'), /valid job/);
  assert.deepStrictEqual(['JOBQ', 'ACTIVE', 'OUTQ', 'X'].map(v.jobPhase), ['queued', 'running', 'ended', 'unknown']);
});

test('live job log', () => {
  assert.match(v.jobLogSql('123456/bob/qpadev0001', 12), /JOBLOG_INFO\('123456\/BOB\/QPADEV0001'\)\) J WHERE ORDINAL_POSITION > 12/);
  assert.throws(() => v.jobLogSql("x') OR 1=1 --", 0));
  const m = { pos: 1, time: '2026-10-15-10.11.12.123', id: 'CPF9897', type: 'ESCAPE', severity: 40, text: 'Boom', from: 'PGMA' };
  assert.strictEqual(v.jobLogLine(m), '10:11:12 CPF9897 40 ESCAPE        Boom  [PGMA]');
  assert.ok(v.isAlarming(m));
  assert.ok(!v.isAlarming({ ...m, type: 'INFORMATIONAL', severity: 0 }));
});

test('failed jobs from CPF1164', () => {
  const r = v.failedJobs([
    { at: '2026-10-15 10:00:00', text: 'Job 123456/QUSER/QZDASOINIT ended on 10/15/26 at 10:00:00; 1 seconds used; end code 0 .' },
    { at: '2026-10-15 11:00:00', text: 'Job 223456/BATCH/NIGHTLY ended on 10/15/26 at 11:00:00; 5 seconds used; end code 30 .' },
    { at: '2026-10-15 12:00:00', text: 'Travail 323456/BATCH/NIGHTLY terminé ; code de fin 20 .' },
    { at: '2026-10-15 12:30:00', text: 'Job 423456/ME/TEST ended; end code 10 .' },
  ]);
  assert.deepStrictEqual(r.map(j => [j.job, j.code]), [['223456/BATCH/NIGHTLY', 30], ['323456/BATCH/NIGHTLY', 20]]);
  assert.deepStrictEqual(v.failuresByName(r), [{ name: 'NIGHTLY', count: 2, last: '2026-10-15 12:00:00', codes: '20, 30' }]);
  assert.strictEqual(v.endCodeMeaning(30), 'Ended abnormally');
  assert.strictEqual(v.failedJobs([{ at: '', text: 'Job 423456/ME/TEST ended; end code 10 .' }], 10).length, 1);
});
