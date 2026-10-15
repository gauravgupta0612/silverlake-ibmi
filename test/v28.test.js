const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v28');

// Fixed-form D spec: name 7-21, decl 24-25, length 33-39, type 40, decimals 41-42, keywords 44+.
const D = (name, decl, len, type, dec, kw = '') => ('     D' + name.padEnd(15) + '  ' + decl.padEnd(2) + ''.padEnd(7) + String(len).padStart(7) + type.padEnd(1) + String(dec).padStart(2) + ' ' + kw);
const C = (f1, op, result, len = '', dec = '') => ('     C' + ''.padEnd(5) + f1.padEnd(14) + op.padEnd(10) + ''.padEnd(14) + result.padEnd(14) + String(len).padStart(5) + String(dec).padStart(2));

test('free-form main procedure interface', () => {
  const src = '**FREE\ndcl-proc helper;\n  dcl-pi *n; x int(10); end-pi;\nend-proc;\ndcl-pi ORDPGM;\n  custNo char(10) const;\n  amount packed(9:2);\n  qty int(10);\n  flag ind;\n  note varchar(50);\nend-pi;\n';
  const p = v.programParameters(src, 'RPGLE');
  assert.deepStrictEqual(p.map(x => [x.name, v.describeParm(x)]), [['CUSTNO', 'char(10)'], ['AMOUNT', 'packed(9:2)'], ['QTY', 'int(10)'], ['FLAG', 'ind'], ['NOTE', 'other']]);
  assert.ok(p[0].constant);
});

test('fixed-form PI and *ENTRY PLIST', () => {
  const pi = [D('MAIN', 'PI', '', ' ', ''), D('CUST', '', 10, 'A', ''), D('AMT', '', 7, ' ', 2), D('CNT', '', 10, 'I', 0), D('Z', '', 5, 'S', 0)].join('\n');
  assert.deepStrictEqual(v.programParameters(pi, 'RPGLE').map(x => [x.name, v.describeParm(x)]), [['CUST', 'char(10)'], ['AMT', 'packed(7:2)'], ['CNT', 'int(10)'], ['Z', 'zoned(5:0)']]);
  const plist = [D('INAMT', 'S', 9, 'P', 2), C('*ENTRY', 'PLIST', ''), C('', 'PARM', 'INCUST', 8), C('', 'PARM', 'INAMT'), C('', 'PARM', 'INQTY', 5, 0), C('', 'SETON', '')].join('\n');
  assert.deepStrictEqual(v.programParameters(plist, 'RPGLE').map(x => [x.name, v.describeParm(x)]), [['INCUST', 'char(8)'], ['INAMT', 'packed(9:2)'], ['INQTY', 'zoned(5:0)']]);
});

test('CL program parameters', () => {
  const cl = "PGM PARM(&LIB &AMT &N &OK)\n  DCL VAR(&LIB) TYPE(*CHAR) LEN(10)\n  DCL VAR(&AMT) TYPE(*DEC) LEN(7 2)\n  DCL &N *INT 4\n  DCL VAR(&OK) TYPE(*LGL)\nENDPGM";
  assert.deepStrictEqual(v.programParameters(cl, 'CLLE').map(x => [x.name, v.describeParm(x)]), [['&LIB', 'char(10)'], ['&AMT', 'packed(7:2)'], ['&N', 'int(10)'], ['&OK', 'ind']]);
});

test('CALL literals', () => {
  const P = (kind, length, decimals = 0) => ({ name: 'X', kind, length, decimals, raw: '' });
  assert.strictEqual(v.callLiteral(P('char', 10), "O'Neil"), "'O''Neil'");
  assert.strictEqual(v.callLiteral(P('char', 40), 'AB').length, 42);
  assert.throws(() => v.callLiteral(P('char', 3), 'ABCD'));
  assert.strictEqual(v.callLiteral(P('packed', 5, 2), '12.34'), "X'01234F'");
  assert.strictEqual(v.callLiteral(P('packed', 4, 0), '12'), "X'00012F'");
  assert.strictEqual(v.callLiteral(P('packed', 5, 2), '-1.5'), "X'00150D'");
  assert.strictEqual(v.callLiteral(P('packed', 15, 5), '123.456'), '123.456');
  assert.throws(() => v.callLiteral(P('packed', 3, 0), '1234'));
  assert.throws(() => v.callLiteral(P('packed', 5, 1), '1.25'));
  assert.strictEqual(v.callLiteral(P('zoned', 5, 2), '-1.23'), "'0012L'");
  assert.strictEqual(v.callLiteral(P('zoned', 3, 0), '7'), "'007'");
  assert.strictEqual(v.callLiteral(P('int', 10), '-1'), "X'FFFFFFFF'");
  assert.strictEqual(v.callLiteral(P('int', 5), '258'), "X'0102'");
  assert.strictEqual(v.callLiteral(P('uns', 3), '255'), "X'FF'");
  assert.throws(() => v.callLiteral(P('int', 5), '40000'));
  assert.strictEqual(v.callLiteral(P('ind', 1), '*on'), "'1'");
  assert.strictEqual(v.callCommand('mylib', 'ordpgm', ["'A'", "X'01F'"]), "CALL PGM(MYLIB/ORDPGM) PARM('A' X'01F')");
  assert.strictEqual(v.callCommand('*LIBL', 'P', []), 'CALL PGM(*LIBL/P)');
  assert.throws(() => v.callCommand('L', 'X) DLT(', []));
});

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
