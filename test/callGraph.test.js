const test = require('node:test');
const assert = require('node:assert');
const { buildCallGraph, impactSummary, layoutGraph, toMermaid, usageLabel } = require('../out/core/callGraph');

const refs = [
  { lib: 'APP', pgm: 'ORDENTRY', text: 'Order entry', refLib: '*LIBL', refName: 'CUSTMAST', refType: '*FILE', usage: 1 },
  { lib: 'APP', pgm: 'ORDENTRY', refLib: '*LIBL', refName: 'ORDCALC', refType: '*PGM' },
  { lib: 'APP', pgm: 'ORDCALC', refLib: 'APP', refName: 'ORDERS', refType: '*FILE', usage: 4 },
  { lib: 'APP', pgm: 'ORDCALC', refLib: '*LIBL', refName: 'UTILS', refType: '*SRVPGM' },
  { lib: 'APP', pgm: 'MENU', refLib: '*LIBL', refName: 'ORDENTRY', refType: '*PGM' },
  { lib: 'RPT', pgm: 'DAILYRPT', refLib: 'APP', refName: 'ORDERS', refType: '*FILE', usage: 1 },
];

test('callees follow programs, not files', () => {
  const g = buildCallGraph({ lib: 'APP', name: 'ORDENTRY', type: '*PGM' }, refs, 'callees', 3);
  const ids = g.nodes.map(n => `${n.id}@${n.depth}`).sort();
  assert.deepStrictEqual(ids, ['*LIBL/CUSTMAST*FILE@1', '*LIBL/UTILS*SRVPGM@2', 'APP/ORDCALC*PGM@1', 'APP/ORDENTRY*PGM@0', 'APP/ORDERS*FILE@2']);
  assert.ok(g.edges.some(e => e.from === 'APP/ORDCALC*PGM' && e.to === 'APP/ORDERS*FILE' && e.label === 'update'));
});

test('callers give the impact of changing a file', () => {
  const g = buildCallGraph({ lib: 'APP', name: 'ORDERS', type: '*FILE' }, refs, 'callers', 5);
  const callers = g.nodes.filter(n => n.depth < 0).map(n => `${n.lib}/${n.name}@${n.depth}`).sort();
  assert.deepStrictEqual(callers, ['APP/MENU@-3', 'APP/ORDCALC@-1', 'APP/ORDENTRY@-2', 'RPT/DAILYRPT@-1']);
  assert.deepStrictEqual(impactSummary(g), { programs: 4, libraries: ['APP', 'RPT'] });
});

test('depth and node limits are respected', () => {
  assert.strictEqual(buildCallGraph({ lib: 'APP', name: 'ORDERS', type: '*FILE' }, refs, 'callers', 1).nodes.length, 3);
  const g = buildCallGraph({ lib: 'APP', name: 'ORDENTRY', type: '*PGM' }, refs, 'both', 5, 2);
  assert.strictEqual(g.nodes.length, 2);
  assert.ok(g.truncated);
});

test('layout puts callers left of the root and mermaid text is produced', () => {
  const g = buildCallGraph({ lib: 'APP', name: 'ORDCALC', type: '*PGM' }, refs, 'both', 2);
  const l = layoutGraph(g);
  const x = id => l.nodes.find(n => n.id === id).x;
  assert.ok(x('APP/ORDENTRY*PGM') < x('APP/ORDCALC*PGM'));
  assert.ok(x('APP/ORDERS*FILE') > x('APP/ORDCALC*PGM'));
  const m = toMermaid(g);
  assert.match(m, /^flowchart LR/);
  assert.match(m, /-->\|update\|/);
  assert.strictEqual(usageLabel(3), 'input/output');
});
