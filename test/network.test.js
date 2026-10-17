const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/network');

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
