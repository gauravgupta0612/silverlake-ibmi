const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/core/cmdSource');

test('command source preview and problems', () => {
  const src = [
    "             CMD        PROMPT('Copy customer')",
    "             PARM       KWD(FROMCUST) TYPE(*DEC) LEN(7 0) MIN(1) +",
    "                          PROMPT('From customer')",
    "             PARM       KWD(TOFILE) TYPE(QUALFILE) PROMPT('To file')",
    "             PARM       KWD(MODE) TYPE(*CHAR) LEN(4) RSTD(*YES) DFT(*ADD) +",
    "                          SPCVAL((*ADD) (*REPLACE REPL)) PROMPT('Mode')",
    "             PARM       KWD(MODE) TYPE(*CHAR) LEN(1)",
    "             PARM       KWD(BAD) TYPE(NOLABEL) MIN(2) MAX(1) DFT(X)",
    " QUALFILE:   QUAL       TYPE(*NAME) LEN(10)",
    "             QUAL       TYPE(*NAME) LEN(10) DFT(*LIBL) SPCVAL((*LIBL)) PROMPT('Library')",
    "             DEP        CTL(&MODE *EQ '*ADD') PARM(&NOPE)",
  ].join('\n');
  const p = c.previewCommand(src, 'cpycust');
  assert.strictEqual(p.def.prompt, 'Copy customer'); assert.strictEqual(p.def.name, 'CPYCUST');
  assert.deepStrictEqual(p.def.parms.map(x => [x.kwd, x.type, x.min]), [['FROMCUST', '*DEC', 1], ['TOFILE', 'QUAL', 0], ['MODE', '*CHAR', 0], ['MODE', '*CHAR', 0], ['BAD', 'NOLABEL', 2]]);
  assert.deepStrictEqual(p.def.parms[1].parts, ['Name', 'Library']);
  assert.deepStrictEqual(p.def.parms[2].values, ['*ADD', '*REPLACE']);
  const msgs = p.problems.map(x => `${x.line}:${x.severity}:${x.message}`);
  assert.ok(msgs.some(m => /^6:error:Keyword MODE is defined twice/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some(m => /^7:error:TYPE\(NOLABEL\)/.test(m)));
  assert.ok(msgs.some(m => /MIN\(2\) is larger than MAX\(1\)/.test(m)));
  assert.ok(msgs.some(m => /required parameter \(MIN\(2\)\) cannot have DFT/.test(m)));
  assert.ok(msgs.some(m => /^10:error:DEP refers to &NOPE/.test(m)));
  assert.ok(msgs.some(m => /^6:warning:MODE has no PROMPT/.test(m)));
  assert.ok(!msgs.some(m => /FROMCUST/.test(m)));
  assert.ok(c.previewCommand('PARM KWD(A) TYPE(*CHAR) LEN(1) PROMPT(\'A\')').problems.some(x => /no CMD statement/.test(x.message)));
});
