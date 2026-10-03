const test = require('node:test');
const assert = require('node:assert');
const { lintRpg } = require('../out/rpg/lint');

const rules = f => f.map(x => x.rule);

test('clean program has no findings', () => {
  const src = `**free\ndcl-s name varchar(20);\nname = 'A';\ndsply name;\n*inlr = *on;\n`;
  assert.deepStrictEqual(lintRpg(src), []);
});

test('unused variable, GOTO, numbered indicator, empty on-error, select *', () => {
  const src = `**free
dcl-s unused int(10);
dcl-s used int(10);
used = 1;
if *in50;
endif;
monitor;
  used = 2;
on-error;
endmon;
exec sql SELECT * INTO :used FROM T;
goto skip;
return;
`;
  const r = rules(lintRpg(src));
  for (const want of ['unused-definition', 'numbered-indicator', 'empty-on-error', 'select-star', 'goto']) {
    assert.ok(r.includes(want), `expected ${want} in ${r}`);
  }
  assert.ok(!r.includes('program-end'));
  const unused = lintRpg(src).find(f => f.rule === 'unused-definition');
  assert.match(unused.message, /unused/);
});

test('program-end warning and NOMAIN exemption', () => {
  assert.ok(rules(lintRpg(`**free\ndcl-s a int(10);\na = 1;\ndsply a;\n`)).includes('program-end'));
  assert.ok(!rules(lintRpg(`**free\nctl-opt nomain;\ndcl-proc p export;\n  dsply 'x';\nend-proc;\n`)).includes('program-end'));
  assert.ok(!rules(lintRpg(`**free\nctl-opt main(run);\ndcl-proc run;\n  dsply 'x';\nend-proc;\n`)).includes('program-end'));
});

test('rules can be switched off and long procedures are reported', () => {
  const body = Array.from({ length: 12 }, (_, i) => `  dsply '${i}';`).join('\n');
  const src = `**free\nctl-opt nomain;\ndcl-proc big export;\n${body}\nend-proc;\n`;
  assert.ok(rules(lintRpg(src, { maxProcedureLines: 5 })).includes('long-procedure'));
  assert.ok(!rules(lintRpg(src, { maxProcedureLines: 5, rules: { 'long-procedure': false } })).includes('long-procedure'));
});

test('mixed fixed and free format', () => {
  const src = [
    '     C                   EVAL      X = 1',
    '       x = 2;',
    '       *inlr = *on;',
  ].join('\n');
  assert.ok(rules(lintRpg(src, { rules: { 'unused-definition': false } })).includes('mixed-format'));
});

test('include members skip unused and program-end checks; multiplication counts as use', () => {
  const inc = `**free\ndcl-c MAX 10;\ndcl-s shared int(10);\n`;
  assert.deepStrictEqual(lintRpg(inc, { isInclude: true }), []);
  const src = `**free\ndcl-s qty int(10);\ndcl-s price int(10);\ndcl-s total int(10);\ntotal = qty*price;\ndsply total;\nreturn;\n`;
  assert.ok(!rules(lintRpg(src)).includes('unused-definition'));
});
