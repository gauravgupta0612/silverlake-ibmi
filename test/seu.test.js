const test = require('node:test');
const assert = require('node:assert');
const sd = require('../out/core/sourceDates');
const sl = require('../out/rpg/specLayout');
const cl = require('../out/core/clCommand');

const rec = (seq, date, text) => ({ seq, date, text });

test('diffLines maps unchanged lines', () => {
  assert.deepStrictEqual(sd.diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), [0, -1, 2, 3, -1]);
  assert.deepStrictEqual(sd.diffLines(['a', 'b'], ['b', 'a']).filter(x => x >= 0).length, 1);
  assert.deepStrictEqual(sd.diffLines([], ['a']), [-1]);
});

test('mergeRecords keeps dates of untouched lines and numbers inserts between neighbours', () => {
  const orig = [rec(1, 240101, 'one'), rec(2, 240101, 'two'), rec(3, 240101, 'three')];
  const out = sd.mergeRecords(orig, ['one', 'two', 'new A', 'new B', 'three changed', 'three'], 260103);
  assert.deepStrictEqual(out.map(r => r.date), [240101, 240101, 260103, 260103, 260103, 240101]);
  assert.deepStrictEqual(out.map(r => r.seq), [1, 2, 2.25, 2.5, 2.75, 3]);
});

test('large members keep dates when a line is inserted at the top (patience diff)', () => {
  const orig = Array.from({ length: 2100 }, (_, i) => rec(i + 1, 240101, i % 7 === 0 ? '' : `line ${i}`));
  const lines = ['', ...orig.map(r => r.text)];
  lines[lines.length - 1] = 'edited';
  const out = sd.mergeRecords(orig, lines, 260103);
  const changed = out.filter(r => r.date === 260103).length;
  assert.ok(changed <= 5, `only the new and edited lines change date (got ${changed})`);
});

test('mergeRecords renumbers when there is no room between sequence numbers', () => {
  const orig = [rec(1, 240101, 'a'), rec(1.01, 240101, 'b')];
  const out = sd.mergeRecords(orig, ['a', 'x', 'y', 'b'], 260103);
  assert.deepStrictEqual(out.map(r => r.seq), [1, 2, 3, 4]);
  assert.deepStrictEqual(out.map(r => r.date), [240101, 260103, 260103, 240101]);
});

test('date helpers', () => {
  assert.strictEqual(sd.formatSrcDate(260103, 'iso'), '2026-01-03');
  assert.strictEqual(sd.formatSrcDate(991231, 'iso'), '1999-12-31');
  assert.strictEqual(sd.formatSrcDate(50203, 'seu'), '050203');
  assert.strictEqual(sd.formatSeq(12.5), '0012.50');
  assert.deepStrictEqual(sd.tooLongLines(['abc', 'abcdef   ', 'abcdefg'], 6), [3]);
});

test('spec layout: split and rebuild a C spec keeps columns', () => {
  const line = '     C     KEY           CHAIN     CUSTMAST                           90';
  const layout = sl.layoutFor(line, 'rpgle');
  assert.strictEqual(layout, sl.LAYOUTS.C);
  const v = sl.splitSpec(line, layout);
  assert.strictEqual(v.f1, 'KEY'); assert.strictEqual(v.opcode, 'CHAIN'); assert.strictEqual(v.hi, '90');
  v.f2 = 'ORDERS';
  const out = sl.buildSpec(v, layout, line);
  assert.strictEqual(out.substring(35, 49).trim(), 'ORDERS');
  assert.strictEqual(out.substring(70, 72), '90');
  assert.throws(() => sl.buildSpec({ ...v, f1: 'X'.repeat(15) }, layout, line), /at most 14/);
});

test('spec layout: EVAL uses extended factor 2, numbers are right-aligned, DDS', () => {
  assert.strictEqual(sl.layoutFor('     C                   EVAL      X = 1', 'rpgle'), sl.LAYOUTS.CX);
  const d = sl.buildSpec({ name: 'TOTAL', deftype: 'S', to: '11', datatype: 'P', decimals: '2' }, sl.LAYOUTS.D, '');
  assert.strictEqual(d, '     DTOTAL            S             11P 2');
  const a = sl.buildSpec({ nametype: 'R', name: 'CUSTREC' }, sl.LAYOUTS.A, '');
  assert.strictEqual(a, '     A          R CUSTREC');
});

const XML = `<?xml version="1.0"?><QcdCLCmd DTDVersion="1"><Cmd CmdName="SNDMSG" CmdLib="QSYS" Prompt="Send Message">
<Parm Kwd="MSG" PosNbr="1" KeyParm="NO" Type="CHAR" Min="1" Max="1" Prompt="Message text" Len="512"></Parm>
<Parm Kwd="TOUSR" PosNbr="2" Type="NAME" Min="0" Max="299" Prompt="To user profile" Len="10"><SpcVal><Value Val="*SYSOPR"/><Value Val="*ALLACT"/></SpcVal></Parm>
<Parm Kwd="TOMSGQ" Type="QUAL" Min="0" Max="50" Prompt="To message queue"><Qual Type="NAME" Prompt=""/><Qual Type="NAME" Prompt="Library" Dft="*LIBL"/></Parm>
<Parm Kwd="HIDDEN" Type="CHAR" Constant="X"/>
</Cmd></QcdCLCmd>`;

test('command definition XML', () => {
  const def = cl.parseCommandXml(XML);
  assert.strictEqual(def.name, 'SNDMSG');
  assert.deepStrictEqual(def.parms.map(p => p.kwd), ['MSG', 'TOUSR', 'TOMSGQ']);
  assert.deepStrictEqual(def.parms[1].values, ['*SYSOPR', '*ALLACT']);
  assert.strictEqual(def.parms[0].min, 1);
  assert.strictEqual(def.parms[2].parts.length, 2);
});

test('CL text parsing and formatting', () => {
  const joined = cl.joinClLines(["LOOP:        SNDMSG     MSG('Hello (there)') +", '                          TOUSR(*SYSOPR) /* note */']);
  const p = cl.parseClCommand(joined);
  assert.strictEqual(p.label, 'LOOP');
  assert.strictEqual(p.command, 'SNDMSG');
  assert.strictEqual(p.params.MSG, "'Hello (there)'");
  assert.strictEqual(p.params.TOUSR, '*SYSOPR');
  const def = cl.parseCommandXml(XML);
  assert.deepStrictEqual(cl.currentValues(cl.parseClCommand("SNDMSG 'Hi' QSECOFR"), def), { MSG: "'Hi'", TOUSR: 'QSECOFR' });
  assert.strictEqual(cl.formatClCommand('SNDMSG', [{ kwd: 'MSG', value: "'Hi'" }, { kwd: 'TOUSR', value: '' }], 'line'), "SNDMSG MSG('Hi')");
  const long = "'" + 'Hello world, this is a long message that will not fit on one CL source line at all' + "'";
  const src = cl.formatClCommand('SNDMSG', [{ kwd: 'MSG', value: long }, { kwd: 'TOUSR', value: '*SYSOPR' }], 'source', 'LOOP');
  const lines = src.split('\n');
  assert.ok(lines[0].startsWith('LOOP:        SNDMSG     MSG('));
  assert.ok(lines.every(l => l.length <= 71), 'lines fit in the source');
  const back = cl.parseClCommand(cl.joinClLines(lines));
  assert.strictEqual(back.params.MSG, long, 'long value survives the round trip');
  assert.strictEqual(back.params.TOUSR, '*SYSOPR');
  assert.strictEqual(back.label, 'LOOP');
  const iff = cl.parseClCommand('IF (&A *EQ 1) THEN(DO)');
  assert.deepStrictEqual(iff.positional, ['(&A *EQ 1)']);
  assert.strictEqual(cl.joinClLines(["SNDMSG MSG('Hello +", "          world')"]), "SNDMSG MSG('Hello world')");
});

test('EBCDIC / UTF-8 decoding and path structure', () => {
  assert.strictEqual(cl.decodeIbmText(Buffer.from([0x4c, 0xc1, 0x6e])), '<A>');
  assert.strictEqual(cl.decodeIbmText(Buffer.from('<A>')), '<A>');
  const hex = cl.qlgPathHex('/tmp/x.xml');
  assert.strictEqual(hex.substring(0, 8), '000004B8');
  assert.strictEqual(parseInt(hex.substring(32, 40), 16), 10);
});
