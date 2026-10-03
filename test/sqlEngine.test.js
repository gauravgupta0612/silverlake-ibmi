const test = require('node:test');
const assert = require('node:assert');
const { MapepireEngine } = require('../out/core/sql');
const { compareSets, summarize } = require('../out/core/compareSets');

function fakeJob(first, more) {
  return { query: () => ({
    execute: async () => first,
    fetchMore: async () => { if (more instanceof Error) { throw more; } return more; },
    close: async () => undefined,
  }) };
}

test('statements without a result set do not fetch more (CREATE ALIAS, CALL…)', async () => {
  const e = new MapepireEngine(fakeJob({ success: true, has_results: false, is_done: false, data: [], update_count: 0 },
    new Error('Result set was null')), 'test');
  const r = await e.query('CREATE OR REPLACE ALIAS QTEMP/X FOR A/B(C)', 1);
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.truncated, false);
});

test('"Result set was null" while paging ends the fetch instead of failing', async () => {
  const e = new MapepireEngine(fakeJob({ success: true, is_done: false, data: [{ A: 1 }], metadata: { columns: [{ name: 'A' }] } },
    new Error('Result set was null')), 'test');
  const r = await e.query('SELECT A FROM T', 10);
  assert.deepStrictEqual(r.rows, [{ A: 1 }]);
});

test('query results page until done', async () => {
  const e = new MapepireEngine(fakeJob({ success: true, is_done: false, data: [{ A: 1 }], metadata: { columns: [{ name: 'A' }] } },
    { success: true, is_done: true, data: [{ A: 2 }] }), 'test');
  const r = await e.query('SELECT A FROM T', 10);
  assert.strictEqual(r.rows.length, 2);
  assert.deepStrictEqual(r.columns, ['A']);
});

test('compareSets classifies and orders rows', () => {
  const a = [{ key: 'X', fingerprint: '1', changed: '2026-01-02' }, { key: 'ONLYA', fingerprint: '1' }, { key: 'SAME', fingerprint: 's' }];
  const b = [{ key: 'X', fingerprint: '2', changed: '2026-01-01' }, { key: 'ONLYB', fingerprint: '1' }, { key: 'SAME', fingerprint: 's' }];
  const rows = compareSets(a, b);
  assert.deepStrictEqual(rows.map(r => [r.key, r.status]), [['X', 'different'], ['ONLYA', 'onlyA'], ['ONLYB', 'onlyB'], ['SAME', 'same']]);
  assert.strictEqual(rows[0].newer, 'A');
  assert.deepStrictEqual(summarize(rows), { onlyA: 1, onlyB: 1, different: 1, same: 1 });
});
