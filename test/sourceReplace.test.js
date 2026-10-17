const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/sourceReplace'),
  ...require('../out/core/librarySets'),
};

test('replace across members and library sets', () => {
  const re = v.buildPattern('custno', { regex: false, matchCase: false, wholeWord: true });
  const r = v.replaceLines(['     C     CUSTNO    CHAIN     CUSTMAST', 'dcl-s custnoX int(10);', 'x = custno + 1;', 'very long CUSTNO line'], re, 'CUSTID', 80);
  assert.deepStrictEqual(r.changed, [0, 2, 3]);
  assert.strictEqual(r.lines[0], '     C     CUSTID    CHAIN     CUSTMAST');
  assert.strictEqual(r.lines[1], 'dcl-s custnoX int(10);');
  assert.deepStrictEqual(r.tooLong, []);
  assert.deepStrictEqual(v.replaceLines(['A'.repeat(18) + ' X'], v.buildPattern('X', { regex: false, matchCase: true, wholeWord: true }), 'LONGER', 20).tooLong, [0]);
  assert.throws(() => v.buildPattern('(', { regex: true, matchCase: false, wholeWord: false }), /Invalid regular/);
  assert.deepStrictEqual(v.parseLibrarySetInput('applib, utilib  applib qgpl'), ['APPLIB', 'UTILIB', 'QGPL']);
  assert.throws(() => v.parseLibrarySetInput('ok 9bad'), /9BAD/);
});
