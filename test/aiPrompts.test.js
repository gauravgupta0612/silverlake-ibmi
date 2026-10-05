const test = require('node:test');
const assert = require('node:assert');
const { buildUserMessage, clampSource, numberLines, firstCodeBlock, parseObjectRef, instructions, rowsToText } = require('../out/ai/prompts');

test('source is numbered, clamped and placed before the request', () => {
  const msg = buildUserMessage({
    command: 'explain', question: '',
    system: { name: 'DEV', user: 'ME', libraries: ['APP', 'UTIL'], currentLibrary: 'APP', osRelease: '7.5' },
    source: { label: 'APP/QRPGLESRC(ORD)', language: 'rpgle', text: 'a\nb', startLine: 10, selection: true },
  });
  assert.match(msg, /Connected IBM i: DEV \(IBM i 7\.5\), user ME, library list APP, UTIL, current library APP\./);
  assert.match(msg, /Selected code from APP\/QRPGLESRC\(ORD\) \(rpgle, starting at line 10\)/);
  assert.match(msg, /10\| a\n11\| b/);
  assert.ok(msg.trim().endsWith('Request: Explain this code.'));
});

test('no system and compiler messages', () => {
  const msg = buildUserMessage({ command: 'fix', question: 'why?', diagnostics: [{ line: 3, code: 'RNF7030', message: 'not defined' }] });
  assert.match(msg, /No IBM i system is connected/);
  assert.match(msg, /- line 3: RNF7030 not defined/);
});

test('helpers', () => {
  assert.deepStrictEqual(clampSource('aaa\nbbb\nccc', 6), { text: 'aaa', truncated: true });
  assert.strictEqual(numberLines('x\ny', 9), ' 9| x\n10| y');
  assert.strictEqual(firstCodeBlock('text\n```sql\nselect 1\n```\n```rpgle\nx\n```', ['sql']), 'select 1');
  assert.strictEqual(firstCodeBlock('```rpgle\nx\n```', ['sql']), undefined);
  assert.deepStrictEqual(parseObjectRef('please explain mylib/ordentry *pgm'), { library: 'MYLIB', name: 'ORDENTRY', type: '*PGM' });
  assert.match(instructions('sql'), /Task: Write a Db2 for i SQL statement/);
  assert.strictEqual(rowsToText(['A'], [{ A: null }, { A: 'x  y' }]), 'A\nNULL\nx y');
});
