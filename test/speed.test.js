const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/core/speed');

test('many members read in one QSH script', () => {
  const sc = s.bulkReadScript('app', 'qrpglesrc', ['ORD001', 'B$1', "BAD'X"]);
  assert.match(sc, /^cd '\/QSYS\.LIB\/APP\.LIB\/QRPGLESRC\.FILE' \|\| exit 1/);
  assert.match(sc, /for m in 'ORD001' 'B\$1'; do/);
  assert.doesNotMatch(sc, /BAD/);
  assert.throws(() => s.bulkReadScript("a'b", 'f', []));
  const m = s.parseBulk(`noise\n${s.BULK_MARK} ORD001\n     dcl-s x int(10);   \n\n\n${s.BULK_MARK} B$1\nline\n`);
  assert.deepStrictEqual([...m.entries()], [['ORD001', '     dcl-s x int(10);'], ['B$1', 'line']]);
});

test('only new and changed members are read again', () => {
  const r = s.staleMembers({ 'QRPGLESRC/A': { changed: '1' }, 'QRPGLESRC/B': { changed: '1' }, 'QRPGLESRC/GONE': { changed: '1' } },
    [{ file: 'QRPGLESRC', member: 'A', type: 'RPGLE', changed: '1' }, { file: 'QRPGLESRC', member: 'B', type: 'RPGLE', changed: '2' }, { file: 'QCLSRC', member: 'C', type: 'CLLE', changed: '1' }]);
  assert.deepStrictEqual(r.refresh.map(x => x.member), ['B', 'C']);
  assert.deepStrictEqual(r.removed, ['QRPGLESRC/GONE']);
});

test('instant search: text, regex, whole words, limit', () => {
  const docs = [['L/F/A', 'chain cust custmast;\nCUST = 1;'], ['L/F/B', 'nothing here'], ['L/F/C', 'customer']];
  assert.deepStrictEqual(s.searchIndex(docs, 'cust').hits.map(h => `${h.key}:${h.line}:${h.column}`), ['L/F/A:0:6', 'L/F/A:1:0', 'L/F/C:0:0']);
  assert.strictEqual(s.searchIndex(docs, 'cust', { wholeWord: true }).hits.length, 2);
  assert.strictEqual(s.searchIndex(docs, 'CUST', { caseSensitive: true }).hits.length, 1);
  assert.strictEqual(s.searchIndex(docs, 'cust\\w+', { regex: true }).hits[0].length, 8);
  assert.strictEqual(s.searchIndex(docs, 'cust', { max: 1 }).truncated, true);
  assert.throws(() => s.searchIndex(docs, '(', { regex: true }), /Invalid regular expression/);
  assert.deepStrictEqual(s.searchIndex(docs, '').hits, []);
});

test('procedure definitions found in indexed sources', () => {
  const fixed = '     PGETNAME          B                   EXPORT';
  const d = s.procedureDefinitions([['L/F/A', '**free\ndcl-proc getName export;\nend-proc;'], ['L/F/B', `x\n${fixed}`], ['L/F/C', 'getNameX();']], 'GETNAME');
  assert.deepStrictEqual(d, [{ key: 'L/F/A', line: 1 }, { key: 'L/F/B', line: 1 }]);
});

test('IBM i references in any text', () => {
  const r = s.refsIn("CALL PGM(MYLIB/ORD001) see APP/QRPGLESRC(ORD001) job 123456/QUSER/QZDASOINIT msg CPF4131 file '/home/me/x.txt' and APPLIB/CUST *FILE");
  assert.deepStrictEqual(r.map(x => x.kind), ['object', 'member', 'job', 'message', 'ifs', 'object']);
  assert.deepStrictEqual(r[0].args, { library: 'MYLIB', name: 'ORD001', type: '*PGM' });
  assert.deepStrictEqual(r[4].args, { path: '/home/me/x.txt' });
  assert.deepStrictEqual(s.refsIn('and/or 3/4 a/b'), []);
  assert.strictEqual(s.refsIn('DSPFD FILE(LIB/CUST)')[0].args.type, '*FILE');
});

test('work in parallel keeps the order and the limit', async () => {
  let running = 0; let most = 0;
  const r = await s.runPool([1, 2, 3, 4, 5, 6], 2, async x => { running++; most = Math.max(most, running); await new Promise(res => setTimeout(res, 5 * (7 - x))); running--; return x * 10; });
  assert.deepStrictEqual(r, [10, 20, 30, 40, 50, 60]);
  assert.strictEqual(most, 2);
  let n = 0;
  await s.runPool([1, 2, 3, 4], 1, async () => { n++; }, () => n >= 2);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(s.batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('speed test advice', () => {
  const fast = s.speedSummary({ sshMs: [20, 25, 30], qshMs: [200], sqlMs: [10, 12], downloadMBps: 20, uploadMBps: 10, sqlEngine: 'Mapepire (single)', memberCache: true, indexedLibraries: 2 });
  assert.strictEqual(fast.grade, 'fast'); assert.deepStrictEqual(fast.advice, []);
  const slow = s.speedSummary({ sshMs: [300], qshMs: [1500], sqlMs: [400], sqlEngine: 'QSH db2', memberCache: false, indexedLibraries: 0 });
  assert.strictEqual(slow.grade, 'slow');
  assert.ok(slow.advice.length >= 5);
  assert.match(slow.advice[0], /Mapepire/);
});
