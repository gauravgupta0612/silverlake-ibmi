const test = require('node:test');
const assert = require('node:assert');
const j = require('../out/core/jobDescriptions');

test('job descriptions: list and changes', () => {
  assert.match(j.jobDescriptionsSql('qgpl'), /WHERE JOB_DESCRIPTION_LIBRARY = 'QGPL'/);
  assert.doesNotMatch(j.jobDescriptionsSql('*ALL'), /WHERE/);
  assert.match(j.jobDescriptionsSql('*libl'), /LIBRARY_LIST_INFO/);
  assert.throws(() => j.jobDescriptionsSql("x'y"), /not a valid/);
  const d = j.toJobDescription({ L: 'QGPL', N: 'NIGHTLY', U: 'BATCHUSR', QL: 'QGPL', Q: 'QBATCH', LL: 'APP UTIL', ML: 4, MS: 0, MT: '*SECLVL', T: 'Night' });
  assert.deepStrictEqual([d.jobQueue, d.libraries, d.log], ['QGPL/QBATCH', ['APP', 'UTIL'], '4 0 *SECLVL']);
  assert.strictEqual(j.toJobDescription({ L: 'X', N: 'Y', LL: '*SYSVAL' }).special, '*SYSVAL');
  assert.strictEqual(j.chgjobdLibraryList('qgpl', 'nightly', ['app', ' util ']), 'CHGJOBD JOBD(QGPL/NIGHTLY) INLLIBL(APP UTIL)');
  assert.strictEqual(j.chgjobdLibraryList('QGPL', 'N', []), 'CHGJOBD JOBD(QGPL/N) INLLIBL(*NONE)');
  assert.strictEqual(j.chgjobdLibraryList('QGPL', 'N', '*SYSVAL'), 'CHGJOBD JOBD(QGPL/N) INLLIBL(*SYSVAL)');
  assert.throws(() => j.chgjobdLibraryList('QGPL', 'N', ['A', 'A']), /twice/);
  assert.throws(() => j.chgjobdLibraryList('QGPL', 'N', ['A B(']), /not a valid/);
  assert.strictEqual(j.chgjobdJobQueue('QGPL', 'N', 'qbatch'), 'CHGJOBD JOBD(QGPL/N) JOBQ(*LIBL/QBATCH)');
  assert.strictEqual(j.chgjobdJobQueue('QGPL', 'N', 'app/jq'), 'CHGJOBD JOBD(QGPL/N) JOBQ(APP/JQ)');
});
