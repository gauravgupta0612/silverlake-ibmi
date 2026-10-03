const test = require('node:test');
const assert = require('node:assert');
const { parseEvfEvent, parseQsysPath } = require('../out/core/evfevent');

const sample = [
  'TIMESTAMP  0 20260101120000',
  'PROCESSOR  0 999 1',
  'FILEID     0 001 000000 024 MYLIB/QRPGLESRC(HELLO) 20260101115900 0',
  'FILEID     0 002 000003 022 MYLIB/QCPYSRC(PROTOS) 20250101115900 0',
  'FILEEND    0 002 000010',
  'ERROR      0 001 1 000012 000012 008 000012 015 RNF7030 S 30 044 The name or indicator TOTALX is not defined.',
  'ERROR      0 002 1 000004 000004 001 000004 001 RNF3311 W 10 027 Keyword is not valid here.',
  'ERROR      0 001 1 000012 000012 008 000012 015 RNF7030 S 30 044 The name or indicator TOTALX is not defined.',
  'FILEEND    0 001 000020',
].join('\n');

test('parses errors, file ids and de-duplicates', () => {
  const errors = parseEvfEvent(sample);
  assert.strictEqual(errors.length, 2);
  const [a, b] = errors;
  assert.strictEqual(a.messageId, 'RNF7030');
  assert.strictEqual(a.severity, 30);
  assert.strictEqual(a.line, 12);
  assert.strictEqual(a.column, 8);
  assert.strictEqual(a.endColumn, 15);
  assert.ok(a.isMainFile);
  assert.strictEqual(a.message, 'The name or indicator TOTALX is not defined.');
  assert.strictEqual(b.file, 'MYLIB/QCPYSRC(PROTOS)');
  assert.ok(!b.isMainFile);
});

test('member references', () => {
  assert.deepStrictEqual(parseQsysPath('MYLIB/QCPYSRC(PROTOS)'), { library: 'MYLIB', file: 'QCPYSRC', member: 'PROTOS' });
  assert.deepStrictEqual(parseQsysPath('/QSYS.LIB/MYLIB.LIB/QRPGLESRC.FILE/HELLO.MBR'), { library: 'MYLIB', file: 'QRPGLESRC', member: 'HELLO' });
  assert.strictEqual(parseQsysPath('/home/me/x.rpgle'), undefined);
});
