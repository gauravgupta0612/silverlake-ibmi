const test = require('node:test');
const assert = require('node:assert');
const a = require('../out/core/clAssist');
const def = { name: 'CRTLIB', library: 'QSYS', prompt: 'Create Library', parms: [
  { kwd: 'LIB', prompt: 'Library', type: '*NAME', min: 1, max: 1, values: [], parts: [] },
  { kwd: 'TYPE', prompt: 'Library type', type: '*CHAR', min: 0, max: 1, dft: '*PROD', values: ['*PROD', '*TEST'], parts: [] },
  { kwd: 'TEXT', prompt: 'Text | description', type: '*CHAR', min: 0, max: 1, dft: '*BLANK', values: ['*BLANK'], parts: [] },
] };

test('CL cursor, keywords, values, hover text', () => {
  assert.deepStrictEqual(a.clCursor('CRTL'), { command: 'CRTL', used: [], atCommand: true });
  assert.deepStrictEqual(a.clCursor("LBL: CRTLIB LIB(X) TEXT('a (b'"), { command: 'CRTLIB', keyword: 'TEXT', used: ['LIB', 'TEXT'], atCommand: false });
  assert.deepStrictEqual(a.clCursor('QSYS/CRTLIB LIB(X) TYPE('), { command: 'QSYS/CRTLIB', keyword: 'TYPE', used: ['LIB', 'TYPE'], atCommand: false });
  assert.strictEqual(a.clCursor('CHGVAR VAR(&X) VALUE(%SST(&Y 1 ').keyword, 'VALUE');
  assert.deepStrictEqual(a.keywordsToOffer(def, ['TYPE']).map(p => p.kwd), ['LIB', 'TEXT']);
  assert.deepStrictEqual(a.valuesToOffer(def, 'type'), ['*PROD', '*TEST']);
  assert.deepStrictEqual(a.valuesToOffer(def, 'NOPE'), []);
  const md = a.commandMarkdown(def);
  assert.match(md, /\*\*QSYS\/CRTLIB\*\* — Create Library/); assert.match(md, /\| LIB \| Library \*\*\(required\)\*\* \|/); assert.match(md, /Text \\\| description/);
});
