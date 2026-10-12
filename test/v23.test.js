const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/v23');

test('indicatorUsage: fixed-form C spec and *INxx', () => {
  const src = [
    '     C     KEY           CHAIN     CUSTF                              90',
    '     C  N90              EXSR      SHOW',
    '     C                   EVAL      *IN50 = *ON',
    '     C                   IF        *IN50',
    '     C                   SETON                                        LR',
  ].join('\n');
  const u = v.indicatorUsage(src);
  const by = Object.fromEntries(u.map(x => [x.indicator, x]));
  assert.deepStrictEqual(by['90'].set, [0]);
  assert.deepStrictEqual(by['90'].tested, [1]);
  assert.ok(by['50'].set.includes(2));
  assert.ok(by['50'].tested.includes(3));
  assert.ok(!by.KE, 'factor 1 text is not an indicator');
});

test('indicatorUsage: free form and DDS', () => {
  const free = v.indicatorUsage('**FREE\n*IN33 = *ON;\nif *in33;\nendif;\n*in44 = *off;');
  const f = Object.fromEntries(free.map(x => [x.indicator, x]));
  assert.deepStrictEqual(f['33'].set, [1]);
  assert.deepStrictEqual(f['33'].tested, [2]);
  const dds = v.indicatorUsage('     A                                      CA03(03 \'Exit\')\n     A  40                                  DSPATR(HI)');
  const d = Object.fromEntries(dds.map(x => [x.indicator, x]));
  assert.deepStrictEqual(d['03'].set, [0]);
  assert.deepStrictEqual(d['40'].tested, [1]);
  const probs = v.indicatorProblems(free);
  assert.ok(probs.some(p => p.indicator === '44' && /never tested/.test(p.problem)));
});

test('ping command and parse', () => {
  assert.strictEqual(v.pingCommand('example.com', 5), "PING RMTSYS('example.com') NBRPKT(5) WAITTIME(2)");
  assert.throws(() => v.pingCommand("x'; DLTLIB"));
  const r = v.parsePing('TCP3210 Connection verification statistics: 3 of 3 successful (100 %).\nTCP3211 Round-trip (millisecond) min/avg/max = 1/2/4');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.received, 3); assert.strictEqual(r.sent, 3);
  assert.strictEqual(v.parsePing('TCP3202 Unknown host').ok, false);
});

test('http helpers', () => {
  assert.deepStrictEqual(v.parseHeaders('Accept: application/json; X-Id: 7'), { Accept: 'application/json', 'X-Id': '7' });
  assert.throws(() => v.parseHeaders('Accept: a, b'));
  assert.deepStrictEqual(JSON.parse(v.httpOptions({ Accept: 'x' }, { sslTolerate: true, timeoutSeconds: 5 })), { header: 'Accept,x', sslTolerate: 'true', ioTimeout: 5000 });
  assert.strictEqual(v.prettyBody('{"a":1}').language, 'json');
  assert.strictEqual(v.prettyBody('<x/>').language, 'xml');
  assert.strictEqual(v.httpStatus('{"HTTP_STATUS_CODE":"404"}'), 404);
  assert.strictEqual(v.httpStatus('HTTP/1.1 200 OK'), 200);
});

test('ccsid commands and stack line', () => {
  assert.strictEqual(v.tagCcsidCommand("/home/a'b", 1208, true), "CHGATR OBJ('/home/a''b') ATR(*CCSID) VALUE(1208) SUBTREE(*ALL)");
  assert.throws(() => v.tagCcsidCommand('rel', 1208, false));
  assert.throws(() => v.tagCcsidCommand('/a', 0, false));
  assert.match(v.convertCcsidCommand('/a.txt', 1208), /TOCCSID\(1208\) DTAFMT\(\*TEXT\)/);
  assert.strictEqual(v.stackLine({ PROGRAM_LIBRARY_NAME: 'APP', PROGRAM_NAME: 'ORD01', PROCEDURE_NAME: 'calc', STATEMENT_IDENTIFIERS: '120 121' }), 'APP/ORD01 calc (statement 120)');
});
