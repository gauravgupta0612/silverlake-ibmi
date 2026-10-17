const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/memberNotes'),
  ...require('../out/core/jobTools'),
};

test('signed-on users and notes', () => {
  assert.strictEqual(v.breakMessageCommand("Going down at 6, save your work", 'qpadev0001'), "SNDBRKMSG MSG('Going down at 6, save your work') TOMSGQ(QPADEV0001)");
  assert.strictEqual(v.endJobCommand('123456/bob/qpadev0001', false), 'ENDJOB JOB(123456/BOB/QPADEV0001) OPTION(*CNTRLD) DELAY(30)');
  assert.throws(() => v.endJobCommand('bad', true));
  assert.strictEqual(v.connectionKind('123456/QUSER/QZDASOINIT', ''), 'ODBC / JDBC (database)');
  const note = { id: '1', line: 2, snippet: 'x = 1;', text: 'why', by: 'ME', at: '' };
  assert.strictEqual(v.relocate(note, ['a', 'b', 'x = 1;']), 2);
  assert.strictEqual(v.relocate(note, ['new', 'a', 'b', 'x = 1;']), 3);
  assert.strictEqual(v.relocate(note, ['a']), undefined);
  assert.strictEqual(v.noteKey('dev', 'lib', 'qrpglesrc', 'm'), 'DEV|LIB/QRPGLESRC(M)');
});
