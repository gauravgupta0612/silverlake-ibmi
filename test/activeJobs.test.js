const test = require('node:test');
const assert = require('node:assert');
const a = require('../out/core/activeJobs');

test('work with active jobs', () => {
  const sql = a.activeJobsSql({ subsystem: 'qbatch', status: 'MSGW' });
  assert.match(sql, /SUBSYSTEM_LIST_FILTER => 'QBATCH'/); assert.match(sql, /JOB_STATUS = 'MSGW'/);
  assert.throws(() => a.activeJobsSql({ user: "x'--" }));
  const jobs = [{ job: '1/A/B', subsystem: 'QINTER', cpu: 1.5 }, { job: '2/A/C', subsystem: 'QBATCH', cpu: 2 }, { job: '3/A/D', subsystem: 'QINTER', cpu: 0.25 }];
  assert.deepStrictEqual(a.bySubsystem(jobs).map(s => [s.subsystem, s.jobs.length, s.cpu]), [['QBATCH', 1, 2], ['QINTER', 2, 1.8]]);
  const p = a.parseJobOptions([{ job: '1', option: '4' }, { job: '2', option: ' ' }, { job: '3', option: 'x' }, { job: '4', option: 'l' }]);
  assert.deepStrictEqual(p, { ok: [{ job: '1', option: '4' }, { job: '4', option: 'L' }], bad: [{ job: '3', option: 'X' }] });
  assert.strictEqual(a.jobCommand('4', '123456/QUSER/QZDASOINIT'), 'ENDJOB JOB(123456/QUSER/QZDASOINIT) OPTION(*CNTRLD) DELAY(30)');
  assert.strictEqual(a.jobCommand('3', '123456/me/x'), 'HLDJOB JOB(123456/ME/X)');
  assert.throws(() => a.jobCommand('4', 'bad job'));
  assert.strictEqual(a.formatCpuTime(125000), '2m 5s');
  assert.deepStrictEqual(a.toActiveJob({ J: '1/A/B', F: '-QZDASOINIT', C: '1.5' }).function, 'QZDASOINIT');
});
