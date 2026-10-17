const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/includes');

test('merge /COPY members', () => {
  const src = '**FREE\ndcl-s a int(10);\n/copy QCPYSRC,PROTOS\n/copy MISSING\nreturn;';
  const out = v.mergeIncludes(src, new Map([[2, { target: 'QCPYSRC,PROTOS', text: '**FREE\ndcl-pr p;\nend-pr;\n\n' }], [3, { target: 'MISSING', text: null }]]), true);
  assert.strictEqual(out, '**FREE\ndcl-s a int(10);\n// >>>>> /copy QCPYSRC,PROTOS\ndcl-pr p;\nend-pr;\n// <<<<< end of QCPYSRC,PROTOS\n/copy MISSING\n// ^^^ MISSING was not found\nreturn;');
  assert.ok(v.mergeIncludes('     C/COPY X', new Map([[0, { target: 'X', text: 'a' }]]), false).startsWith('      * >>>>>'));
});
